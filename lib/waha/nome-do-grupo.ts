/**
 * O nome REAL do grupo do WhatsApp, trocando o "Grupo NNNN" provisório que
 * `fn_upsert_wa_grupo` grava (migration 0394) pelo que o WAHA souber
 * (`WahaClient.obterNomeDoGrupo`, campo `subject`).
 *
 * ─── O memo mora em `globalThis` ────────────────────────────────────────────
 *
 * Mesmo motivo documentado em `lib/auth/politica-de-cadastro.ts`: um `let`/
 * `Map` de arquivo é por INSTÂNCIA DE MÓDULO, e o Next instancia este módulo
 * mais de uma vez no mesmo processo (o webhook global e o per-tenant chamam o
 * mesmo caminho de ingestão por rotas diferentes). Sem o memo em `globalThis`,
 * cada rota reconsultaria o WAHA por conta própria e o TTL perderia o sentido.
 *
 * ─── Por que consultar de novo custa, e por que 6h ──────────────────────────
 *
 * Toda mensagem de um grupo ativo passaria por aqui — sem TTL, cada mensagem
 * do grupo bateria no WAHA só para confirmar um nome que raramente muda. 6h
 * é generoso o bastante para não martelar a dependência externa e curto o
 * bastante para o nome convergir no mesmo dia em que o grupo é renomeado.
 *
 * ─── `null` também entra no memo ────────────────────────────────────────────
 *
 * Um grupo sem `subject` (ou uma falha do WAHA) grava `null` na mesma chave:
 * sem isso, o grupo problemático seria consultado de novo a CADA mensagem —
 * exatamente o caso em que martelar a dependência externa dói mais.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getWahaClient } from "@/lib/waha/client";
import { logger } from "@/lib/logger";

const SEIS_HORAS_MS = 6 * 60 * 60 * 1000;

/** Teto de linhas do memo — grupo é caso raro; isto é só para não crescer sem fim. */
const LIMITE_DE_ENTRADAS = 5000;

interface EntradaDeMemo {
  readonly expiraEm: number;
}

declare global {
  var __memoDeNomesDeGrupo: Map<string, EntradaDeMemo> | undefined;
}

function memo(): Map<string, EntradaDeMemo> {
  if (!globalThis.__memoDeNomesDeGrupo) globalThis.__memoDeNomesDeGrupo = new Map();
  return globalThis.__memoDeNomesDeGrupo;
}

/** Só para teste: devolve o processo ao estado de quem nunca consultou nada. */
export function esquecerNomesDeGrupo(): void {
  globalThis.__memoDeNomesDeGrupo = undefined;
}

export interface EntradaDeAtualizacaoDeNome {
  organizationId: string;
  contactId: string;
  sessionName: string;
  groupChatId: string;
  /** Injeção de tempo para o teste; produção usa `Date.now()`. */
  agora?: number;
}

/**
 * Consulta o WAHA (respeitando o memo de 6h) e, se souber o nome, grava em
 * `contacts.display_name`.
 *
 * NUNCA LANÇA: é chamado de dentro do caminho de ingestão de mensagem — uma
 * falha aqui não pode impedir a mensagem de ser gravada.
 */
export async function atualizarNomeDoGrupo(
  admin: SupabaseClient,
  entrada: EntradaDeAtualizacaoDeNome,
): Promise<void> {
  const agora = entrada.agora ?? Date.now();
  const chave = `${entrada.organizationId}|${entrada.groupChatId}`;
  const cache = memo();

  const vista = cache.get(chave);
  if (vista && vista.expiraEm > agora) return;

  const waha = getWahaClient();
  if (!waha) return;

  const nome = await waha.obterNomeDoGrupo(entrada.sessionName, entrada.groupChatId);

  // Grava mesmo quando `null`: evita martelar o WAHA por um grupo sem subject.
  if (!cache.has(chave) && cache.size >= LIMITE_DE_ENTRADAS) {
    const maisAntiga = cache.keys().next().value;
    if (maisAntiga !== undefined) cache.delete(maisAntiga);
  }
  cache.set(chave, { expiraEm: agora + SEIS_HORAS_MS });

  if (!nome) return;

  try {
    const { error } = await admin
      .from("contacts")
      .update({ display_name: nome })
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .eq("is_group", true);
    if (error) {
      logger.warn("waha.nome-do-grupo: update do display_name falhou", { detalhe: error.message });
    }
  } catch (erro) {
    logger.warn("waha.nome-do-grupo: update do display_name lançou", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
