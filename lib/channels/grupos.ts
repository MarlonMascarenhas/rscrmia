import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

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
