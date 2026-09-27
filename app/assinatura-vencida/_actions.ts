"use server";

import { redirect } from "next/navigation";

import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";

/**
 * Trocar de organização a partir da tela de bloqueio.
 *
 * Existe porque um usuário pode pertencer a várias organizações e só UMA estar
 * vencida: sem esta porta, a organização vencida prenderia a pessoa fora das
 * outras, que estão em dia. Seria o bloqueio de uma conta derrubando o acesso a
 * contas alheias — e o pior é que pareceria correto de dentro.
 *
 * Reusa `setActiveOrg` inteiro, e de propósito: ele já revalida a membership no
 * banco (fresca, `revoked_at is null` e `accepted_at not null`), recusa durante
 * acompanhamento de suporte, recusa com MFA em dívida e audita
 * `organization.switched`. Uma versão própria aqui perderia as quatro coisas.
 *
 * Ele exige `organizations.status = 'active'`, e isso não conflita com a
 * cobrança: uma organização vencida continua `active` — o vencimento vive em
 * `acesso_liberado_ate`, nunca em `status` (ver o cabeçalho da migration 0393).
 */
export async function trocarDeOrganizacao(formData: FormData): Promise<void> {
  const orgId = String(formData.get("organization_id") ?? "");
  const r = await setActiveOrg(orgId);
  // Falha volta para a própria tela: a ação não tem onde mostrar erro, e mandar
  // a pessoa para o produto sem ter trocado a levaria de volta ao bloqueio sem
  // explicação nenhuma.
  redirect(r.ok ? "/app/inbox" : "/assinatura-vencida");
}
