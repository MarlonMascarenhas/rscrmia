/**
 * O WEBHOOK DO ASAAS.
 *
 * Vive sob `/api/v1/webhooks/`, que o proxy já libera (`lib/auth/public-paths.ts`)
 * e o gate de cobrança já isenta (`lib/planos/guarda.ts`) — a isenção não é
 * conveniência, é parte do mecanismo: trancar o webhook do provedor faria o
 * pagamento não conseguir destrancar a conta que ele acabou de pagar.
 *
 * ═══ A ROTA NÃO EXISTE ATÉ SER CONFIGURADA ═══
 *
 * Sem `ASAAS_WEBHOOK_TOKEN` ela responde 404. Uma rota pública que aceitasse
 * pedidos sem ter como verificá-los seria uma porta aberta disfarçada de "ainda
 * não configurado".
 *
 * ═══ AUTENTICAÇÃO: UM TOKEN NO HEADER ═══
 *
 * O Asaas envia o token que o operador configurou no webhook, em TODA notificação,
 * no header `asaas-access-token`. Comparado por hash com `timingSafeEqual`. Não há
 * assinatura do corpo: a defesa contra replay é a idempotência abaixo.
 *
 * ═══ IDEMPOTÊNCIA, E POR QUE 200 É A RESPOSTA PADRÃO ═══
 *
 * A entrega é at-least-once e a fila do Asaas PAUSA após 15 falhas seguidas. Então:
 * duplicata, evento ignorado e reprocessamento em curso respondem 200 rápido. Só uma
 * falha real e recuperável (banco fora, erro ao aplicar) responde 500 — e aí o Asaas
 * reentrega, e a reentrega reprocessa: o recibo (`cobranca_eventos_asaas`, PK = `id`
 * do evento) é gravado ANTES do efeito, e uma linha com `erro` ou reservada há mais
 * de 60s sem `processado_em` NÃO vira "já processado".
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { processarEventoDoAsaas, type ResultadoDoEventoDoAsaas } from "@/lib/planos/asaas/aplicar";
import { credenciaisDoAsaas } from "@/lib/planos/asaas/cliente";
import {
  chaveDoEvento,
  entradaSanitizada,
  lerEventoDoAsaas,
  verificarTokenDoAsaas,
} from "@/lib/planos/asaas/webhook";
import { lerConfigDeCobranca } from "@/lib/planos/config";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TAMANHO_MAXIMO_BYTES = 256 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const cred = await credenciaisDoAsaas();
  if (!cred.webhookToken) return fail("not_found", "Not found.", 404, { requestId });

  if (!verificarTokenDoAsaas(req.headers.get("asaas-access-token"), cred.webhookToken)) {
    logger.warn("asaas: webhook recusado (token)", { request_id: requestId });
    return fail("unauthorized", "invalid_token", 401, { requestId });
  }

  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > TAMANHO_MAXIMO_BYTES) {
    return fail("payload_too_large", "Corpo do webhook grande demais.", 413, { requestId });
  }

  // Autenticado mas ilegível: repetir não conserta, e o Asaas só aceita HTTP 200 como
  // entrega — qualquer outro código conta para as 15 falhas que pausam a fila inteira.
  let json: unknown = null;
  try {
    json = JSON.parse(corpo);
  } catch {
    json = null;
  }
  const evento = lerEventoDoAsaas(json);
  if (!evento) {
    logger.warn("asaas: evento ilegível ignorado", { request_id: requestId });
    return ok({ recebido: true, resultado: "ignorado_ilegivel" }, { requestId });
  }

  const db = createAdminClient();
  const chave = chaveDoEvento(evento);

  // ── reserva idempotente ────────────────────────────────────────────────────
  const { error: erroReserva } = await db.from("cobranca_eventos_asaas").insert({
    chave,
    evento: evento.evento,
    pagamento_id: evento.pagamentoId,
    // Desconhecida NESTE instante: a organização só se resolve no efeito, por
    // dado nosso, e é gravada no recibo depois.
    organization_id: null,
    entrada: entradaSanitizada(evento),
  });
  if (erroReserva) {
    if (erroReserva.code !== "23505") {
      logger.error("asaas: falha ao reservar o evento", { request_id: requestId, detalhe: erroReserva.message });
      return fail("internal_error", "Não foi possível registrar o evento.", 500, { requestId });
    }
    const { data: existente } = await db
      .from("cobranca_eventos_asaas")
      .select("processado_em, recebido_em, erro")
      .eq("chave", chave)
      .maybeSingle();
    const linha = existente as { processado_em: string | null; recebido_em: string; erro: string | null } | null;
    if (linha?.processado_em) {
      return ok({ recebido: true, resultado: "duplicado" }, { requestId });
    }
    // Uma linha que falhou (`erro`) não está em processamento: a reentrega é o conserto.
    if (linha && !linha.erro && Date.now() - new Date(linha.recebido_em).getTime() < 60_000) {
      return ok({ recebido: true, em_processamento: true }, { requestId });
    }
    // Falhou antes, ou reservado há mais de 60s e nunca concluído: segue e reprocessa.
  }

  // ── efeito ─────────────────────────────────────────────────────────────────
  const { carenciaDias } = await lerConfigDeCobranca(db);
  // `dateCreated` do Asaas não declara fuso: a ordem dos eventos é a do recebimento.
  const agora = new Date();

  let resultado: ResultadoDoEventoDoAsaas;
  try {
    resultado = await processarEventoDoAsaas(db, evento, { agora, eventoCriadoEm: agora, carenciaDias, cred });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await db.from("cobranca_eventos_asaas").update({ erro: mensagem.slice(0, 500) }).eq("chave", chave);
    logger.error("asaas: falha ao processar o evento", { request_id: requestId, chave, detalhe: mensagem });
    // 500: falha real e recuperável — o Asaas reentrega, e a reentrega reprocessa.
    return fail("internal_error", "Não foi possível processar o evento.", 500, { requestId });
  }

  await db
    .from("cobranca_eventos_asaas")
    .update({
      processado_em: new Date().toISOString(),
      resultado: resultado.resultado,
      organization_id: resultado.organizationId,
      erro: null,
    })
    .eq("chave", chave);

  if (resultado.resultado === "sem_organizacao") {
    logger.warn("asaas: evento sem organização", { request_id: requestId, chave, evento: evento.evento });
  }
  if (resultado.resultado === "aplicado" || resultado.resultado === "fatura_registrada") {
    void audit({
      action: "assinatura.evento_do_provedor",
      actorUserId: null,
      organizationId: resultado.organizationId,
      resourceType: "assinatura",
      resourceId: resultado.organizationId,
      requestId,
      metadata: { provedor: "asaas", chave, evento: evento.evento, resultado: resultado.resultado, via: resultado.via },
    });
  }

  return ok({ recebido: true, resultado: resultado.resultado }, { requestId });
}
