/**
 * O WEBHOOK DO STRIPE.
 *
 * Vive sob `/api/v1/webhooks/`, que o proxy já libera e o gate de cobrança já
 * isenta — e a isenção aqui não é conveniência, é parte do mecanismo: trancar o
 * webhook do provedor faria o pagamento não conseguir destrancar a conta que ele
 * acabou de pagar (`lib/planos/guarda.ts`).
 *
 * ═══ A ROTA NÃO EXISTE ATÉ SER CONFIGURADA ═══
 *
 * Sem `STRIPE_WEBHOOK_SECRET` ela responde 404, a mesma resposta de uma rota que
 * nunca foi instalada — a de `POST /api/v1/tenants/provision` faz igual. Uma rota
 * pública que aceitasse pedidos sem ter como verificá-los seria uma porta aberta
 * disfarçada de "ainda não configurado".
 *
 * ═══ O CORPO É LIDO CRU ═══
 *
 * `await req.text()`, nunca `req.json()`. Parsear antes de verificar quebra a
 * assinatura, e o erro resultante não sugere a causa.
 *
 * ═══ IDEMPOTÊNCIA, E O CASO DO EVENTO RESERVADO E NÃO PROCESSADO ═══
 *
 * O recibo é gravado ANTES do efeito (`cobranca_eventos`, PK = id do evento) e o
 * INSERT duplicado é capturado por `23505`. Mas reserva sem processamento — o
 * processo morreu no meio — NÃO pode virar "já processado": o provedor reentrega
 * exatamente para isso, e tratar a linha reservada como concluída perderia o
 * pagamento para sempre. Por isso a linha só encerra a conversa quando
 * `processado_em` está preenchido.
 *
 * Resposta 200 para duplicata, nunca 409: o provedor reentregaria por dias.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { credenciaisDoStripe } from "@/lib/planos/stripe/cliente";
import { processarEventoDoStripe, type ResultadoDoEvento } from "@/lib/planos/stripe/aplicar";
import { verificarAssinaturaDoStripe, type EventoDoStripe } from "@/lib/planos/stripe/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Só o que o processamento consome; o resto do payload não é lido nem guardado. */
function lerEvento(json: unknown): EventoDoStripe | null {
  if (!json || typeof json !== "object") return null;
  const e = json as Record<string, unknown>;
  const objeto = (e.data as { object?: unknown } | undefined)?.object;
  if (
    typeof e.id !== "string" ||
    typeof e.type !== "string" ||
    typeof e.created !== "number" ||
    typeof e.livemode !== "boolean" ||
    !objeto ||
    typeof objeto !== "object"
  ) {
    return null;
  }
  return {
    id: e.id,
    type: e.type,
    created: e.created,
    livemode: e.livemode,
    data: { object: objeto as Record<string, unknown> },
  };
}

/** Só identificadores, estados e datas. Nunca e-mail, nome ou cartão. */
function resumoDoEvento(evento: EventoDoStripe): Record<string, unknown> {
  const o = evento.data.object;
  const pega = (k: string) => (typeof o[k] === "string" ? o[k] : undefined);
  return {
    objeto: pega("id"),
    status: pega("status"),
    cliente: typeof o.customer === "string" ? o.customer : (o.customer as { id?: string } | undefined)?.id,
    livemode: evento.livemode,
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const cred = await credenciaisDoStripe();
  if (!cred.segredoDoWebhook) return fail("not_found", "Not found.", 404, { requestId });

  const corpo = await req.text();
  const assinatura = verificarAssinaturaDoStripe({
    corpo,
    cabecalho: req.headers.get("stripe-signature"),
    segredo: cred.segredoDoWebhook,
    agora: new Date(),
  });
  if (!assinatura.ok) {
    logger.warn("stripe: webhook recusado", { request_id: requestId, motivo: assinatura.motivo });
    return fail("unauthorized", "invalid_signature", 401, { requestId });
  }

  let json: unknown;
  try {
    json = JSON.parse(corpo);
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const evento = lerEvento(json);
  if (!evento) return fail("invalid_request", "Evento inesperado.", 400, { requestId });

  // Evento de OUTRO modo (teste × produção) não é nosso: senão o webhook de teste de
  // uma conta liberaria acesso de verdade, ou o contrário. 200, para não reentregar.
  const modoDoEvento = evento.livemode ? "producao" : "teste";
  if (cred.modo !== "invalida" && cred.modo !== modoDoEvento) {
    logger.warn("stripe: evento de outro modo ignorado", { request_id: requestId, evento: evento.id, modo_do_evento: modoDoEvento });
    return ok({ recebido: true, resultado: "ignorado_modo" }, { requestId });
  }

  const db = createAdminClient();

  // ── reserva idempotente ────────────────────────────────────────────────────
  const { error: erroReserva } = await db.from("cobranca_eventos").insert({
    stripe_event_id: evento.id,
    // Desconhecida NESTE instante: a organização só se resolve no efeito, por dado
    // nosso, e é gravada no recibo depois. `null` explícito é o que ela é.
    organization_id: null,
    tipo: evento.type,
    stripe_criado_em: new Date(evento.created * 1000).toISOString(),
    resumo: resumoDoEvento(evento),
  });
  if (erroReserva) {
    if (erroReserva.code !== "23505") {
      logger.error("stripe: falha ao reservar o evento", { request_id: requestId, detalhe: erroReserva.message });
      return fail("internal_error", "Não foi possível registrar o evento.", 500, { requestId });
    }
    const { data: existente } = await db
      .from("cobranca_eventos")
      .select("processado_em")
      .eq("stripe_event_id", evento.id)
      .maybeSingle();
    if ((existente as { processado_em: string | null } | null)?.processado_em) {
      return ok({ recebido: true, resultado: "duplicado" }, { requestId });
    }
    // Reservado e nunca concluído: segue e reprocessa.
  }

  // ── efeito ─────────────────────────────────────────────────────────────────
  const { data: cfg } = await db.from("platform_config").select("valor").eq("chave", "CARENCIA_DIAS").maybeSingle();
  const dias = Number((cfg as { valor: string | null } | null)?.valor);
  const carenciaDias = Number.isFinite(dias) && dias >= 0 && dias <= 90 ? dias : 5;

  let resultado: ResultadoDoEvento;
  try {
    resultado = await processarEventoDoStripe(db, evento, { carenciaDias });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await db.from("cobranca_eventos").update({ erro: mensagem.slice(0, 500) }).eq("stripe_event_id", evento.id);
    logger.error("stripe: falha ao processar o evento", { request_id: requestId, evento: evento.id, detalhe: mensagem });
    // 500: o provedor reentrega, e a linha reservada sem `processado_em` deixa passar.
    return fail("internal_error", "Não foi possível processar o evento.", 500, { requestId });
  }

  await db
    .from("cobranca_eventos")
    .update({
      processado_em: new Date().toISOString(),
      resultado: resultado.resultado,
      organization_id: resultado.organizationId,
      erro: null,
    })
    .eq("stripe_event_id", evento.id);

  if (resultado.resultado === "sem_organizacao") {
    // Fica registrado para reconciliação — nunca adivinhado.
    logger.warn("stripe: evento sem organização", { request_id: requestId, evento: evento.id, tipo: evento.type });
  }
  if (resultado.resultado === "aplicado" || resultado.resultado === "vinculado") {
    void audit({
      action: "assinatura.evento_do_provedor",
      actorUserId: null,
      organizationId: resultado.organizationId,
      resourceType: "assinatura",
      resourceId: resultado.organizationId,
      requestId,
      metadata: { evento: evento.id, tipo: evento.type, resultado: resultado.resultado },
    });
  }

  return ok({ recebido: true, resultado: resultado.resultado }, { requestId });
}
