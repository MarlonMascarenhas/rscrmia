/**
 * Helper ÚNICO de autorização por role nas rotas /api/v1 (spec 13 §4 — G2-01).
 *
 * Resolve o role efetivo do usuário na org ativa e nega com 403 padronizado
 * (`fail("forbidden_role", ...)`). Nenhuma rota deve reimplementar a checagem
 * na mão (comparação com ROLE_RANK direto em rota é proibida — anti-padrão
 * "matriz advisória").
 *
 * Fluxo:
 *  1. `loadAuthUser()` — valida o JWT via `supabase.auth.getUser()` (nunca
 *     `getSession()`); 401 se não autenticado.
 *  2. `resolveActiveOrg()` — org ativa de fonte confiável (cookie validado
 *     contra memberships), NUNCA do body; 403 `forbidden_tenant` se ausente.
 *  3. `rpc fn_user_role_in_org(org)` — role efetivo direto do banco, a MESMA
 *     função SECURITY DEFINER que as policies RLS usam (fonte única de
 *     verdade); falha fechada se membership foi revogado.
 *  4. Rank insuficiente → audit `authz.denied` (fire-and-forget) + 403.
 */
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, type ActiveOrg, type AuthUser, type Role } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import type { CapacidadeDePlano } from "@/lib/planos/capacidades";
import { exigirAcessoLiberado, exigirCapacidade } from "@/lib/planos/guarda";
import { createClient } from "@/lib/supabase/server";

export type RoleCheck =
  | { ok: true; user: AuthUser; org: ActiveOrg }
  | { ok: false; response: NextResponse<ApiError> };

interface RequireRoleOpts {
  /** Correlaciona a resposta e o audit com o X-Request-Id da rota. */
  requestId?: string;
  /** resource_type gravado no audit `authz.denied` (ex.: "api_tokens"). */
  resource?: string;
  /** Platform admin (role transversal) bypassa o rank do tenant. */
  allowPlatformAdmin?: boolean;
  /**
   * Override da org onde o role é resolvido (default: org ativa do cookie).
   * Use quando a autorização é sobre a org do RECURSO (ex.: LGPD anonymize —
   * admin na org do CONTATO), resolvida de fonte confiável (query RLS-scoped),
   * NUNCA do body. O role vem de `fn_user_role_in_org(p_org)` nessa org.
   */
  organizationId?: string;
  /**
   * Isenta esta rota do gate de COBRANÇA, declarando POR QUÊ.
   *
   * String e não booleano de propósito: `portaDeSaida: true` seria um opt-out
   * silencioso, e o mecanismo pelo qual o gate se perde é exatamente esse — a
   * sétima rota copia o `true` da sexta sem que ninguém releia a razão. A razão
   * escrita é lida por `tests/unit/planos-portas-de-saida.test.ts`, que reprova
   * motivo fora da lista revisada.
   *
   * Só é porta de saída o que uma conta TRANCADA precisa poder fazer: pagar, ver
   * a fatura, cancelar, sair, exportar os próprios dados. Uso do produto, nunca.
   */
  portaDeSaida?: string;
  /**
   * Esta rota só existe se o PLANO da organização inclui a capacidade (migration
   * 0393). Fica aqui, e não num `if` na rota, pela razão de sempre: repetição de
   * gate é como se perde um. Vem DEPOIS do gate de acesso — quem venceu leva
   * `assinatura_vencida`, que é a causa que a pessoa resolve, e não `plano_nao_inclui`.
   *
   * Nunca em porta de saída: desconectar, cancelar e sair não dependem do plano.
   */
  capacidade?: CapacidadeDePlano;
}

/**
 * Gate de rota: `const authz = await requireRole("manager", { requestId });`
 * `if (!authz.ok) return authz.response;`
 */
export async function requireRole(min: Role, opts: RequireRoleOpts = {}): Promise<RoleCheck> {
  const { requestId, resource, allowPlatformAdmin = false, organizationId, portaDeSaida, capacidade } = opts;

  const user = await loadAuthUser();
  if (!user) {
    return { ok: false, response: fail("unauthenticated", "Auth required.", 401, { requestId }) };
  }
  const t = (texto: string) => traduzir(texto, user.idioma);

  if (user.support && user.support.status !== "active") {
    return { ok: false, response: fail("forbidden", "O acompanhamento terminou. Saia para continuar.", 403, { requestId }) };
  }
  let org: ActiveOrg | null;
  if (organizationId) {
    const membership = user.organizations.find((o) => o.organization_id === organizationId);
    org = user.support?.organization_id === organizationId
      ? { orgId: organizationId, name: user.support.name, role: user.support.access_mode === "full" ? "admin" : "viewer" }
      : membership
      ? {
          orgId: membership.organization_id,
          name: membership.organization_name,
          role: membership.role,
        }
      : allowPlatformAdmin && user.is_platform_admin
        ? { orgId: organizationId, name: "—", role: "viewer" }
        : null;
  } else {
    org = await resolveActiveOrg(user);
  }
  if (!org) {
    return {
      ok: false,
      response: fail("forbidden_tenant", t("Sem organização ativa."), 403, { requestId }),
    };
  }

  if (allowPlatformAdmin && user.is_platform_admin && !user.support) {
    return { ok: true, user, org };
  }

  // Role efetivo do banco (não do snapshot do cookie/membership em memória).
  const supabase = await createClient();
  const { data: effectiveRole, error } = await supabase.rpc("fn_user_role_in_org", {
    p_org: org.orgId,
  });
  if (error) {
    return { ok: false, response: fail("internal_error", error.message, 500, { requestId }) };
  }

  const rank = effectiveRole ? (ROLE_RANK[effectiveRole as Role] ?? 0) : 0;

  // MFA como política de SESSÃO, não só de cadastro.
  //
  // O gate de MFA vivia em `app/app/layout.tsx`, e layout não roda em rota de
  // API: uma sessão `aal1` de admin com TOTP cadastrado chamava direto as 33
  // rotas gateadas por `requireRole("admin")` — criar token de API (plaintext
  // mostrado uma vez), convidar membro, LGPD anonymize, publicar agente,
  // credenciais. Pior, o layout perguntava a coisa errada: `isMfaEnrolled()` é
  // "tem fator", não "provou o fator agora".
  //
  // Fica DEPOIS do rank e ANTES do retorno de sucesso, de propósito: quem não
  // tem papel suficiente continua levando 403 por falta de papel, sem que a
  // resposta revele o estado de MFA de quem nem chegaria lá.
  if (rank >= ROLE_RANK[min] && (await mfaEmDivida())) {
    void audit({
      action: "authz.denied",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: resource ?? null,
      requestId,
      metadata: { reason: "mfa_required", effective_role: effectiveRole ?? null },
    });
    return {
      ok: false,
      response: fail(
        "mfa_required",
        t(
          "Esta sessão precisa da verificação em duas etapas. Entre novamente com o código do aplicativo.",
        ),
        403,
        { requestId },
      ),
    };
  }

  if (rank < ROLE_RANK[min]) {
    // Fire-and-forget: falha de audit alerta, não bloqueia o 403.
    void audit({
      action: "authz.denied",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: resource ?? null,
      requestId,
      metadata: { required_role: min, effective_role: effectiveRole ?? null },
    });
    return {
      ok: false,
      response: fail("forbidden_role", `Permissão insuficiente. Requer role >= ${min}.`, 403, {
        requestId,
      }),
    };
  }

  // Gate de COBRANÇA (migration 0393).
  //
  // Fica DEPOIS do rank e do MFA e ANTES do sucesso, pela mesma razão escrita
  // acima para o MFA: quem não tem papel continua levando 403 por papel, sem que
  // a resposta revele o estado de pagamento de quem nem chegaria lá.
  //
  // Aqui, e não no `proxy.ts`: o Edge não tem banco (`proxy.ts:92-94`). E aqui,
  // e não rota por rota: com 356 rotas, `if` repetido é como se perde um
  // (`lib/voice/guarda.ts:4-10`).
  //
  // ⚠️ Este ponto cobre 249 das 356 rotas de `/api/v1`. O ramo Bearer vive em
  // `lib/mcp/auth.ts` e as que resolvem a org só por `resolveActiveOrg` chamam
  // `exigirAcessoLiberado` na mão. Quem prova que nenhuma escapou é
  // `tests/unit/planos-gate-cobre-toda-rota.test.ts`.
  //
  // Platform admin nunca chega aqui: sai em `allowPlatformAdmin` acima, e é o
  // desfecho certo — quem administra a instalação é quem LIBERA.
  if (!portaDeSaida && !user.support) {
    const negado = await exigirAcessoLiberado(org.orgId, {
      requestId,
      idioma: user.idioma,
    });
    if (negado) return { ok: false, response: negado };
  }

  if (capacidade && !portaDeSaida && !user.support) {
    const semCapacidade = await exigirCapacidade(org.orgId, capacidade, {
      requestId,
      idioma: user.idioma,
    });
    if (semCapacidade) return { ok: false, response: semCapacidade };
  }

  return { ok: true, user, org: { ...org, role: effectiveRole as Role } };
}
