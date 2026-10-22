import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { getWahaClient } from "@/lib/waha/client";

/**
 * Leitura preguiçosa de propósito: se a coluna ainda não existir (banco sem a
 * migration 0394), o caminho 1:1 não quebra, só não mostra grupos.
 */
export async function lerMostrarGrupos(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("channel_sessions")
      .select("mostrar_grupos")
      .eq("organization_id", organizationId)
      .eq("id", channelSessionId)
      .maybeSingle();
    if (error) {
      logger.warn("canal: não li mostrar_grupos", { organization_id: organizationId, detalhe: error.message });
      return false;
    }
    return data?.mostrar_grupos === true;
  } catch (err) {
    logger.warn("canal: não li mostrar_grupos", {
      organization_id: organizationId,
      detalhe: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}

export type ConvergenciaDeGrupos = "ja_convergida" | "aplicada" | "nao_aplicada";

export type CanalParaGrupos =
  | { situacao: "erro" }
  | { situacao: "nao_encontrado" }
  // Canal que não tem sessão por QR (o oficial): grupos não existem nele.
  | { situacao: "sem_sessao" }
  | { situacao: "ok"; sessionRef: string };

/** Carrega o canal (da organização, não arquivado) e diz se ele tem sessão onde grupos fazem sentido. */
export async function lerCanalParaGrupos(
  db: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<CanalParaGrupos> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, waha_session_name")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return { situacao: "erro" };
  if (!data) return { situacao: "nao_encontrado" };
  if (!data.waha_session_name) return { situacao: "sem_sessao" };
  return { situacao: "ok", sessionRef: data.waha_session_name };
}

/**
 * Faz o transporte refletir a preferência de grupos. NÃO lança: transporte
 * indisponível devolve `nao_aplicada` e a preferência salva vale na próxima
 * reconexão.
 */
export async function convergirGruposDoCanal(
  sessionRef: string,
  mostrarGrupos: boolean,
): Promise<ConvergenciaDeGrupos> {
  const cliente = getWahaClient();
  if (!cliente) return "nao_aplicada";
  return cliente.convergirConfigDaSessao(sessionRef, { mostrarGrupos });
}
