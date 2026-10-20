/**
 * TESTA AS CREDENCIAIS DO ASAAS CONFIGURADAS NA INSTALAÇÃO.
 *
 * Sob `/api/v1/admin/`, porta de saída do gate de cobrança (`requirePlatformAdmin`
 * chega ao gate — ver `lib/planos/guarda.ts`). Não grava nada: faz UMA chamada GET
 * barata e autenticada (`GET /customers?limit=1`) para confirmar que a chave vale
 * para o ambiente escolhido, e devolve o ambiente testado. Não é mutação — nenhuma
 * linha muda no banco —, então não audita. Chave de outro ambiente volta 401
 * `invalid_environment`: a mensagem diz isso em vez de um "HTTP 401" mudo.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { asaasPronto, credenciaisDoAsaas, testarCredenciaisDoAsaas } from "@/lib/planos/asaas/cliente";

export async function POST(): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const cred = await credenciaisDoAsaas();
  if (!asaasPronto(cred)) {
    return fail("validation_failed", "Credenciais do Asaas incompletas.", 422, { requestId });
  }

  const resultado = await testarCredenciaisDoAsaas(cred);
  if (!resultado.ok) {
    const outroAmbiente = resultado.codigo === "invalid_environment";
    return fail(
      "upstream_unavailable",
      outroAmbiente
        ? `A chave não é do ambiente ${cred.ambiente}. Troque a chave ou o ambiente.`
        : resultado.mensagem,
      502,
      { requestId, details: { ambiente: cred.ambiente } },
    );
  }

  return ok({ ok: true, ambiente: cred.ambiente }, { requestId });
}
