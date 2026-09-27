/**
 * A PORTA MANUAL — LIBERAR ACESSO À MÃO.
 *
 * Existe porque cobrança automática sempre falha em algum caso real, e três deles
 * são certos: alguém paga por Pix fora do sistema, alguém ganha cortesia, e um
 * dia o webhook do provedor não chega. Sem esta porta, o desfecho nesses três
 * casos é mexer no banco à mão — sem validação, sem auditoria e sem gatilho, o
 * que deixaria `organizations.acesso_liberado_ate` fora de sincronia com
 * `assinaturas` e o gate lendo um estado que ninguém escreveu de propósito.
 *
 * É a decisão que o dono do produto tomou junto com o checkout automático: a
 * porta manual é ESCAPE, não atalho. Por isso `motivo` é obrigatório (schema) e
 * toda passagem por aqui audita.
 *
 * `PUT` e não `PATCH`: a operação substitui o estado da assinatura inteiro. Um
 * PATCH parcial convidaria a mudar `situacao` sem tocar em `liberado_ate`, e a
 * combinação resultante (`ativa` com prazo vencido) é justamente a que a decisão
 * tem de desempatar — melhor não deixar produzi-la.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { liberarAcessoSchema } from "@/lib/planos/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  // `scope === 'full'`: um super-admin de leitura não libera cobrança. É a mesma
  // fronteira que `app/api/v1/admin/tenants/route.ts:166-170` aplica para criar
  // organização, e por razão mais forte — aqui se dá dinheiro de graça.
  if (admin.platformAdmin.scope !== "full") {
    return fail("forbidden", "Este acesso é somente leitura.", 403, { requestId });
  }

  const { id: organizationId } = await ctx.params;
  const parsed = liberarAcessoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const entrada = parsed.data;

  const db = createAdminClient();

  // A organização tem de existir. Sem esta conferência, um id errado criaria uma
  // assinatura órfã — e o `on delete cascade` não ajuda, porque não há o que
  // cascatear.
  const { data: org, error: orgErr } = await db
    .from("organizations")
    .select("id, display_name, acesso_liberado_ate")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgErr) return fail("internal_error", orgErr.message, 500, { requestId });
  if (!org) return fail("not_found", "Organização não encontrada.", 404, { requestId });

  const antes = (org as { acesso_liberado_ate: string | null }).acesso_liberado_ate;

  // `upsert` por `organization_id` (que é a PK): a primeira liberação cria a
  // linha, as seguintes substituem. O gatilho `trg_assinaturas_sincroniza_acesso`
  // propaga para `organizations.acesso_liberado_ate` na MESMA transação — é por
  // isso que não há um segundo `update` aqui, e é o que impede os dois lados de
  // divergirem.
  const { error } = await db.from("assinaturas").upsert(
    {
      organization_id: organizationId,
      plano_id: entrada.plano_id ?? null,
      situacao: entrada.situacao,
      liberado_ate: entrada.liberado_ate,
      motivo: entrada.motivo,
      liberado_por: admin.user.id,
      // Liberação manual zera a carência: quem libera à mão está dizendo que o
      // caso está resolvido, e deixar uma carência velha ali faria a decisão
      // liberar por um motivo que já não é o verdadeiro.
      carencia_ate: null,
      cancelada_em: entrada.situacao === "cancelada" ? new Date().toISOString() : null,
    },
    { onConflict: "organization_id" },
  );
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "assinatura.liberada_manualmente",
    actorUserId: admin.user.id,
    organizationId,
    resourceType: "assinatura",
    resourceId: organizationId,
    requestId,
    metadata: {
      situacao: entrada.situacao,
      liberado_ate_antes: antes,
      liberado_ate_depois: entrada.liberado_ate,
      plano_id: entrada.plano_id ?? null,
      motivo: entrada.motivo,
      // `null` em `liberado_ate` é SEM PRAZO, e é a decisão mais forte que esta
      // rota toma — a linha do audit diz isso em palavras para quem for auditar
      // depois não ter de saber a convenção de cor.
      sem_prazo: entrada.liberado_ate === null,
    },
  });

  return ok(
    { organization_id: organizationId, situacao: entrada.situacao, liberado_ate: entrada.liberado_ate },
    { requestId },
  );
}
