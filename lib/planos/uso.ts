/**
 * QUANTO A ORGANIZAÇÃO USA DE CADA TETO — MEDIDO NA FONTE, NUNCA INVENTADO.
 *
 * Cada limite tem UMA régua, declarada em `FORMA_DO_LIMITE[...].medidor`, e é ela
 * que este arquivo executa. Duas réguas para o mesmo teto é como a tela diz "80
 * de 100" enquanto a rota recusa no 90 — o defeito do cabeçalho de `orcamento.ts`.
 *
 * ═══ `null` É "NÃO MEDI" E NUNCA É `0` ═══
 *
 * Consulta que falhou devolve `null`, e `decidirLimite` trata `null` como "não
 * bloqueia". Devolver `0` no lugar faria um defeito de leitura virar uma
 * organização "sem uso" — o teto nunca dispararia, com a tela mostrando "0 de
 * 1000" e o recurso sendo consumido. É o furo `gasto_incompleto` que
 * `lib/ai/budget/check.ts:59-76` documenta, e por isso aqui ele nem é possível:
 * cada medidor devolve `number | null`, e o `null` nasce de erro.
 *
 * Nunca lança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import type { LimiteDePlano } from "@/lib/planos/limites";

/** Primeiro instante do mês corrente, em UTC — a mesma âncora de `fn_gasto_de_ia_do_mes`
 *  (`date_trunc('month', now())` no fuso do servidor, que é UTC no Supabase). */
function inicioDoMes(agora: Date): string {
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();
}

async function contar(
  consulta: PromiseLike<{ count: number | null; error: { message: string } | null }>,
  limite: LimiteDePlano,
  organizationId: string,
): Promise<number | null> {
  const { count, error } = await consulta;
  if (error || count === null) {
    logger.warn("cobrança: uso do teto não medido", {
      organization_id: organizationId,
      limite,
      detalhe: error?.message ?? "count nulo",
    });
    return null;
  }
  return count;
}

/** O uso atual de UM teto. `null` = não medido. Nunca lança. */
export async function medirUso(
  db: SupabaseClient,
  organizationId: string,
  limite: LimiteDePlano,
  agora: Date = new Date(),
): Promise<number | null> {
  try {
    const head = { count: "exact", head: true } as const;
    switch (limite) {
      case "usuarios": {
        // Um convite pendente OCUPA a vaga: contar só os membros deixaria a
        // organização convidar 50 pessoas com teto de 5 e descobrir no aceite.
        const [membros, convites] = await Promise.all([
          contar(
            db.from("user_organizations").select("id", head)
              .eq("organization_id", organizationId).is("revoked_at", null),
            limite, organizationId,
          ),
          contar(
            db.from("team_invites").select("id", head)
              .eq("organization_id", organizationId)
              .is("accepted_at", null).is("revoked_at", null)
              .gt("expires_at", agora.toISOString()),
            limite, organizationId,
          ),
        ]);
        return membros === null || convites === null ? null : membros + convites;
      }
      case "conexoes":
        return contar(
          db.from("channel_sessions").select("id", head)
            .eq("organization_id", organizationId).is("archived_at", null),
          limite, organizationId,
        );
      case "contatos":
        // Grupo do WhatsApp nunca conta para o teto de plano (migration 0394).
        return contar(
          db.from("contacts").select("id", head)
            .eq("organization_id", organizationId).eq("is_anonymized", false)
            .eq("is_group", false),
          limite, organizationId,
        );
      case "mensagens_por_mes":
        // `pacing_ledger` é o ÚNICO contador de envio real (uma linha por envio).
        return contar(
          db.from("pacing_ledger").select("sent_at", head)
            .eq("organization_id", organizationId).gte("sent_at", inicioDoMes(agora)),
          limite, organizationId,
        );
      case "campanhas_por_mes":
        return contar(
          db.from("campaigns").select("id", head)
            .eq("organization_id", organizationId).gte("created_at", inicioDoMes(agora)),
          limite, organizationId,
        );
      case "tokens_de_api":
        return contar(
          db.from("api_tokens").select("id", head)
            .eq("organization_id", organizationId).is("revoked_at", null),
          limite, organizationId,
        );
      case "agentes":
        return contar(
          db.from("ai_agents").select("id", head)
            .eq("organization_id", organizationId).is("archived_at", null),
          limite, organizationId,
        );
    }
  } catch (erro) {
    logger.warn("cobrança: medição do uso falhou", {
      organization_id: organizationId,
      limite,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}
