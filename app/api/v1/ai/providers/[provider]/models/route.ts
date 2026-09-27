/**
 * GET /api/v1/ai/providers/:provider/models
 *
 * Lê do catálogo curado `ai_models` (tabela GLOBAL, RLS read-all).
 * Retorna modelos não-deprecated ordenados por default-first depois preço.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { exigirAcessoLiberado } from "@/lib/planos/guarda";
import { createClient } from "@/lib/supabase/server";
import { ehProvedorSuportado } from "@/lib/ai/pontos/provedores";

export const dynamic = "force-dynamic";

// A lista única (`lib/ai/pontos/provedores.ts`) — não uma quarta cópia. Esta
// rota alimenta o seletor de modelos; com a lista velha, pedir os modelos da
// OpenRouter devolvia "provedor desconhecido" para um provedor que a tela ao
// lado oferecia.

const MODEL_COLUMNS =
  "id, provider, model_id, display_name, description, context_window, input_price_per_million_cents, output_price_per_million_cents, supports_tools, is_default_for_provider, deprecated_at, released_at";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { provider } = await ctx.params;

  if (!ehProvedorSuportado(provider)) {
    return fail("not_found", "Provider desconhecido.", 404, { requestId });
  }

  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  }

  // Gate de COBRANÇA (migration 0393). Esta rota resolve a organização por
  // `resolveActiveOrg` e não passa por `requireRole`, então a guarda é explícita —
  // é o terceiro dos três pontos do gate. Quem prova que nenhuma rota ficou fora
  // dos três é `tests/unit/planos-gate-cobre-toda-rota.test.ts`.
  //
  // LER é o produto: deixar a leitura aberta entregaria o essencial de graça a
  // quem venceu.
  const semAcesso = await exigirAcessoLiberado(activeOrg.orgId, {
    requestId,
    idioma: authUser?.idioma,
  });
  if (semAcesso) return semAcesso;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_models")
    .select(MODEL_COLUMNS)
    .eq("provider", provider)
    .is("deprecated_at", null)
    .order("is_default_for_provider", { ascending: false })
    .order("input_price_per_million_cents", { ascending: true });

  if (error) {
    return fail("internal_error", "Erro ao listar modelos.", 500, { requestId });
  }

  return ok({ models: data ?? [] }, { requestId });
}
