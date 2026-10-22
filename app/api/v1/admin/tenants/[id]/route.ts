import { type NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { encerrarSessoesDaEmpresaExcluida } from "@/lib/channels/encerrar-sessoes";
import { removerObjetosDaEmpresa } from "@/lib/tenants/limpar-armazenamento";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/tenants/[id]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Load the organization (service-role bypasses RLS — intentional cross-tenant)
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select(
      `
      id,
      slug,
      display_name,
      legal_name,
      cnpj,
      status,
      onboarded_at,
      suspended_at,
      created_at,
      settings
    `,
    )
    .eq("id", id)
    .single();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  // Run counts in parallel — service role, all cross-tenant reads are intentional
  const [
    usersRes,
    conversationsRes,
    messagesRes,
    leadsRes,
    ordersRes,
    lgpdRes,
    aiRes,
    wahaRes,
    integrationRes,
  ] = await Promise.all([
    admin
      .from("user_organizations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("crm_leads")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("lgpd_requests")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      // `pending` não existe em `lgpd_requests_status_check`
      // (received/processing/completed/failed/expired), então este contador era
      // sempre 0 e a tela jurava que o tenant não devia nada à LGPD. Aqui
      // pendente = TUDO que ainda não fechou, sem recorte de prazo. O KPI de
      // plataforma (`app/api/v1/admin/dashboard/kpis/route.ts`) parte do mesmo
      // "não fechado" mas soma só o que vence nos próximos 5 dias — os dois
      // números divergem de propósito: este é o total do tenant, aquele é a
      // fila de SLA da plataforma.
      .not("status", "in", "(completed,failed)"),
    // `llm_calls` e não `ai_invocations`: a migration 0130 deixou a segunda sem
    // nenhum escritor (`lib/ai/log-invocation.ts` passou a gravar na primeira).
    // Lendo a tabela morta, este contador viraria ZERO em 30 dias para todo
    // tenant — com o dinheiro saindo. É o mesmo sintoma que a 0130 veio matar.
    admin
      .from("llm_calls")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      .gte(
        "created_at",
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    admin
      .from("channel_sessions")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("tenant_integrations")
      // `connected_at` não existe: a linha passa a existir quando a integração
      // é conectada, então `created_at` é essa mesma data com o nome real.
      .select("id, provider, status, created_at")
      .eq("organization_id", id)
      .eq("provider", "nuvemshop")
      .limit(1),
  ]);

  const counts = {
    user_count: usersRes.count ?? 0,
    conversations_count: conversationsRes.count ?? 0,
    messages_count: messagesRes.count ?? 0,
    leads_count: leadsRes.count ?? 0,
    orders_count: ordersRes.count ?? 0,
    lgpd_requests_pending: lgpdRes.count ?? 0,
    ai_invocations_30d: aiRes.count ?? 0,
    waha_sessions_count: wahaRes.count ?? 0,
  };

  const nuvemshopIntegration =
    integrationRes.data && integrationRes.data.length > 0
      ? integrationRes.data[0]
      : null;

  const integrations = {
    nuvemshop_status: nuvemshopIntegration?.status ?? null,
    // Nome de SAÍDA preservado: é o que TenantOverview já lê. Só a coluna de
    // origem estava errada.
    nuvemshop_connected_at: nuvemshopIntegration?.created_at ?? null,
  };

  // Audit lightweight — fire-and-forget
  void audit({
    action: "platform_admin.tenant_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "organization",
    resourceId: id,
    requestId,
    metadata: { tenant_slug: org.slug },
  });

  return ok({ organization: org, counts, integrations }, { requestId });
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/tenants/[id] — o platform admin EXCLUI a empresa inteira
// ---------------------------------------------------------------------------
//
// Exclusão IMEDIATA, confirmada digitando o slug. As CONTAS das pessoas ficam (perdem só o
// vínculo); a auditoria e o histórico de cobrança ficam com organization_id nulo.
//
// Ordem, e por quê:
//  1. `fn_admin_excluir_organizacao` (migration 0399), UMA transação sob trava: recusa empresa
//     inexistente, slug diferente, acompanhamento de suporte aberto e assinatura do Asaas que
//     ainda renova; sem recusa, apaga tudo e devolve as sessões de canal coletadas ANTES.
//  2. Limpeza FORA do banco (sessões do provedor de canal; objetos de storage `{org}/...`). Roda
//     depois do commit e NUNCA desfaz a exclusão: o que falhar volta em `limpeza.falhas` e na
//     auditoria, com 200 — a empresa já não existe e um 500 aqui mentiria.
//  3. Auditoria `admin.tenant_deleted` com organization_id NULO (a organização não existe mais; o
//     id vai no metadata). Sem event_log: a linha dele é filha da organização e sumiria com ela.

const excluirSchema = z.object({
  confirmacao_slug: z.string().min(1).max(200),
});

interface ResultadoDaExclusao {
  ok: boolean;
  codigo: "nao_encontrada" | "slug_nao_confere" | "em_acompanhamento" | "assinatura_ativa" | "excluida";
  assinatura?: { asaas_assinatura_id: string; situacao: string; liberado_ate: string | null };
  slug?: string;
  display_name?: string;
  sessoes_de_canal?: unknown;
  contagens?: Record<string, number>;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  const supportDenied = await requireSupportWrite(rawId);
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  // Um super-admin de leitura não apaga empresa (mesma fronteira de assinatura/route.ts).
  if (adminCtx.platformAdmin.scope !== "full") {
    return fail("forbidden", "Este acesso é somente leitura.", 403, { requestId });
  }

  const parsedId = z.string().uuid().safeParse(rawId);
  if (!parsedId.success) {
    return fail("validation_failed", "Invalid tenant id", 400, { requestId });
  }
  const id = parsedId.data;

  let body: z.infer<typeof excluirSchema>;
  try {
    body = excluirSchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("fn_admin_excluir_organizacao", {
    p_org_id: id,
    p_slug_confirmacao: body.confirmacao_slug,
  });
  const resultado = data as ResultadoDaExclusao | null;
  if (error || !resultado) {
    logger.error("[admin/tenants] fn_admin_excluir_organizacao falhou", {
      requestId,
      organization_id: id,
      detalhe: error?.message,
    });
    return fail("internal_error", "Failed to delete tenant", 500, { requestId });
  }

  if (resultado.codigo === "nao_encontrada") {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }
  if (resultado.codigo === "slug_nao_confere") {
    return fail(
      "slug_nao_confere",
      "O texto digitado não é igual ao slug da empresa. Nada foi apagado.",
      422,
      { requestId },
    );
  }
  if (resultado.codigo === "em_acompanhamento") {
    return fail(
      "tenant_em_acompanhamento",
      "Há um acompanhamento de suporte aberto nesta empresa. Encerre o acompanhamento antes de excluir.",
      409,
      { requestId },
    );
  }
  if (resultado.codigo === "assinatura_ativa") {
    return fail(
      "assinatura_ativa",
      "Esta empresa tem uma assinatura ativa. Cancele a assinatura antes de excluir a empresa.",
      409,
      { requestId, details: { assinatura: resultado.assinatura ?? null } },
    );
  }

  // Excluída. Daqui em diante NADA devolve erro: a empresa já não existe.
  const falhas: string[] = [];
  let sessoesEncerradas = 0;
  let midiasRemovidas = 0;

  try {
    const sessoes = await encerrarSessoesDaEmpresaExcluida(admin, resultado.sessoes_de_canal);
    sessoesEncerradas = sessoes.encerradas;
    falhas.push(...sessoes.falhas);
  } catch (err) {
    falhas.push(`Falha ao encerrar as conexões de canal: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const armazenamento = await removerObjetosDaEmpresa(admin, id);
    midiasRemovidas = armazenamento.removidos;
    falhas.push(...armazenamento.falhas);
  } catch (err) {
    falhas.push(`Falha ao remover os arquivos: ${err instanceof Error ? err.message : String(err)}`);
  }

  const limpeza = {
    midias_removidas: midiasRemovidas,
    sessoes_encerradas: sessoesEncerradas,
    falhas,
  };
  const contagens = resultado.contagens ?? {};

  await audit({
    action: "admin.tenant_deleted",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: null,
    resourceType: "organization",
    resourceId: id,
    requestId,
    metadata: {
      organization_id: id,
      slug: resultado.slug,
      display_name: resultado.display_name,
      contagens,
      limpeza,
    },
  });

  return ok(
    {
      id,
      deleted: true,
      slug: resultado.slug,
      display_name: resultado.display_name,
      contagens,
      limpeza,
    },
    { requestId },
  );
}
