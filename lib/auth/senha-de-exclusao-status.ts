import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A organização já definiu a senha para excluir conversas?
 *
 * Devolve só o boolean — o hash nunca sai da tabela. Service role com
 * `organization_id` vindo de quem chama (fonte confiável: `resolveActiveOrg`).
 * Falha de leitura conta como "não configurada" para a tela; a rota DELETE faz a
 * própria leitura e decide por conta dela.
 */
export async function senhaDeExclusaoConfigurada(organizationId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("organization_conversation_delete_secret")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return false;
  return data !== null;
}
