/**
 * O contato aponta para um GRUPO do WhatsApp (migration 0394)?
 *
 * O banco já trava lead e fusão nos dois triggers (`fn_contato_grupo_nao_vira_lead`,
 * `fn_contato_grupo_nao_mescla`) — esta função existe para a API recusar ANTES,
 * com uma mensagem amigável, em vez de deixar o 500 cru do trigger chegar à tela.
 *
 * Erro de leitura devolve `false`: a trava do banco continua de pé, então um
 * falso negativo aqui não abre brecha — só perde a mensagem amigável.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export async function ehContatoDeGrupo(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("contacts")
    .select("is_group")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    logger.warn("contato-de-grupo: leitura de is_group falhou", {
      organization_id: organizationId,
      contact_id: contactId,
      detalhe: error.message,
    });
    return false;
  }

  return (data as { is_group: boolean } | null)?.is_group ?? false;
}
