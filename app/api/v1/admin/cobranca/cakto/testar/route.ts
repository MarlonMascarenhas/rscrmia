/**
 * TESTA AS CREDENCIAIS DA CAKTO CONFIGURADAS NA INSTALAÇÃO.
 *
 * Sob `/api/v1/admin/`, porta de saída do gate de cobrança (`requirePlatformAdmin`
 * chega ao gate — ver `lib/planos/guarda.ts`). Não grava nada: só pede um token
 * (`POST /token/`) para confirmar que `client_id`/`client_secret` estão certos, o
 * mesmo caminho de `lib/planos/cakto/cliente.ts:obterToken`. Não é mutação —
 * nenhuma linha muda no banco —, então não audita.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { caktoPronto, credenciaisDaCakto, obterToken } from "@/lib/planos/cakto/cliente";

export async function POST(): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const cred = await credenciaisDaCakto();
  if (!caktoPronto(cred)) {
    return fail("validation_failed", "Credenciais da Cakto incompletas.", 422, { requestId });
  }

  const resultado = await obterToken(cred);
  if (!resultado.ok) {
    return fail("upstream_unavailable", resultado.mensagem, 502, { requestId });
  }

  return ok({ ok: true }, { requestId });
}
