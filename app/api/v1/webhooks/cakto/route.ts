/**
 * O WEBHOOK DA CAKTO.
 *
 * Vive sob `/api/v1/webhooks/`, que o proxy já libera (`lib/auth/public-paths.ts`)
 * e o gate de cobrança já isenta (`lib/planos/guarda.ts`) — a isenção não é
 * conveniência, é parte do mecanismo: trancar o webhook do provedor faria o
 * pagamento não conseguir destrancar a conta que ele acabou de pagar.
 *
 * ═══ A ROTA NÃO EXISTE ATÉ SER CONFIGURADA ═══
 *
 * Sem `CAKTO_WEBHOOK_SECRET` ela responde 404 — a mesma resposta do irmão
 * `/api/v1/webhooks/stripe`. Uma rota pública que aceitasse pedidos sem ter como
 * verificá-los seria uma porta aberta disfarçada de "ainda não configurado".
 *
 * ═══ DUAS FORMAS DE AUTENTICAR, NA ORDEM QUE A CAKTO DOCUMENTA ═══
 *
 * `X-Cakto-Signature` + `X-Cakto-Timestamp` (HMAC, com tolerância de replay) é o
 * caminho forte. Sem esses cabeçalhos, a Cakto aceita um `secret` simples embutido
 * no corpo — mais fraco, mas documentado como caminho válido, então tem de ser
 * aceito. O corpo é lido CRU (`req.text()`, nunca `req.json()`): parsear antes de
 * verificar a assinatura quebra o HMAC.
 *
 * ═══ IDEMPOTÊNCIA, E O CASO DO EVENTO RESERVADO E NÃO PROCESSADO ═══
 *
 * O recibo é gravado ANTES do efeito (`cobranca_eventos_cakto`, PK = chave do
 * evento) e o INSERT duplicado é capturado por `23505`. Reserva sem processamento
 * — o processo morreu no meio — NÃO vira "já processado": a Cakto reentrega
 * exatamente para isso. Resposta 200 para duplicata e para reprocessamento em
 * curso, nunca 409/500: a Cakto só reentrega em falha de REDE, e um 4xx/5xx aqui
 * dispararia retry sobre um evento que já está sendo tratado.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { processarEventoDaCakto, type ResultadoDoEventoDaCakto } from "@/lib/planos/cakto/aplicar";
import { credenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import {
  chaveDoEvento,
  entradaSanitizada,
  lerEventoDaCakto,
  verificarAssinaturaDaCakto,
  verificarSegredoNoCorpo,
} from "@/lib/planos/cakto/webhook";
import { lerConfigDeCobranca } from "@/lib/planos/config";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TAMANHO_MAXIMO_BYTES = 256 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const cred = await credenciaisDaCakto();
  if (!cred.webhookSecret) return fail("not_found", "Not found.", 404, { requestId });

  const corpo = await req.text();
  if (Buffer.byteLength(corpo, "utf8") > TAMANHO_MAXIMO_BYTES) {
    return fail("payload_too_large", "Corpo do webhook grande demais.", 413, { requestId });
  }

  let autenticacao: "hmac" | "segredo_no_corpo";
  let enviadoEm: Date | null = null;

  const cabecalhoAssinatura = req.headers.get("x-cakto-signature");
  if (cabecalhoAssinatura) {
    const verificacao = verificarAssinaturaDaCakto({
      corpo,
      timestamp: req.headers.get("x-cakto-timestamp"),
      assinatura: cabecalhoAssinatura,
      segredo: cred.webhookSecret,
      agora: new Date(),
    });
    if (!verificacao.ok) {
      logger.warn("cakto: webhook recusado (hmac)", { request_id: requestId, motivo: verificacao.motivo });
      return fail("unauthorized", "invalid_signature", 401, { requestId });
    }
    autenticacao = "hmac";
    enviadoEm = verificacao.enviadoEm;
  } else {
    let jsonParaSegredo: unknown;
    try {
      jsonParaSegredo = JSON.parse(corpo);
    } catch {
      return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
    }
    const segredoRecebido =
      jsonParaSegredo && typeof jsonParaSegredo === "object"
        ? (jsonParaSegredo as Record<string, unknown>).secret
        : undefined;
    if (!verificarSegredoNoCorpo(segredoRecebido, cred.webhookSecret)) {
      logger.warn("cakto: webhook recusado (segredo no corpo)", { request_id: requestId });
      return fail("unauthorized", "invalid_signature", 401, { requestId });
    }
    autenticacao = "segredo_no_corpo";
  }

  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const evento = lerEventoDaCakto(json);
  if (!evento) return fail("invalid_request", "Evento inesperado.", 400, { requestId });

  const db = createAdminClient();
  const chave = chaveDoEvento(evento, corpo);

  // ── reserva idempotente ────────────────────────────────────────────────────
  const { error: erroReserva } = await db.from("cobranca_eventos_cakto").insert({
    chave,
    evento: evento.evento,
    pedido_id: evento.pedidoId,
    enviado_em: enviadoEm ? enviadoEm.toISOString() : null,
    autenticacao,
    // Desconhecida NESTE instante: a organização só se resolve no efeito, por
    // dado nosso, e é gravada no recibo depois.
    organization_id: null,
    entrada: entradaSanitizada(evento),
  });
  if (erroReserva) {
    if (erroReserva.code !== "23505") {
      logger.error("cakto: falha ao reservar o evento", { request_id: requestId, detalhe: erroReserva.message });
      return fail("internal_error", "Não foi possível registrar o evento.", 500, { requestId });
    }
    const { data: existente } = await db
      .from("cobranca_eventos_cakto")
      .select("processado_em, recebido_em")
      .eq("chave", chave)
      .maybeSingle();
    const linha = existente as { processado_em: string | null; recebido_em: string } | null;
    if (linha?.processado_em) {
      return ok({ recebido: true, resultado: "duplicado" }, { requestId });
    }
    if (linha && Date.now() - new Date(linha.recebido_em).getTime() < 60_000) {
      return ok({ recebido: true, em_processamento: true }, { requestId });
    }
    // Reservado há mais de 60s e nunca concluído: segue e reprocessa.
  }

  // ── efeito ─────────────────────────────────────────────────────────────────
  const { carenciaDias } = await lerConfigDeCobranca(db);
  const eventoCriadoEm = enviadoEm ?? new Date();

  let resultado: ResultadoDoEventoDaCakto;
  try {
    resultado = await processarEventoDaCakto(db, evento, {
      agora: new Date(),
      eventoCriadoEm,
      carenciaDias,
      cred,
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await db.from("cobranca_eventos_cakto").update({ erro: mensagem.slice(0, 500) }).eq("chave", chave);
    logger.error("cakto: falha ao processar o evento", { request_id: requestId, chave, detalhe: mensagem });
    // 500: a Cakto não reentrega em resposta de erro do nosso lado — a linha
    // fica reservada e sem `processado_em`, e um reprocessamento manual reabre.
    return fail("internal_error", "Não foi possível processar o evento.", 500, { requestId });
  }

  await db
    .from("cobranca_eventos_cakto")
    .update({
      processado_em: new Date().toISOString(),
      resultado: resultado.resultado,
      organization_id: resultado.organizationId,
      erro: null,
    })
    .eq("chave", chave);

  if (resultado.resultado === "sem_organizacao") {
    logger.warn("cakto: evento sem organização", { request_id: requestId, chave, evento: evento.evento });
  }
  if (resultado.resultado === "aplicado" || resultado.resultado === "vinculado") {
    void audit({
      action: "assinatura.evento_do_provedor",
      actorUserId: null,
      organizationId: resultado.organizationId,
      resourceType: "assinatura",
      resourceId: resultado.organizationId,
      requestId,
      metadata: { provedor: "cakto", chave, evento: evento.evento, resultado: resultado.resultado, via: resultado.via },
    });
  }

  return ok({ recebido: true, resultado: resultado.resultado }, { requestId });
}
