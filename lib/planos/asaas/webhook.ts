/**
 * O WEBHOOK DO ASAAS — LEITURA, VERIFICAÇÃO E PLANEJAMENTO. PURO.
 *
 * Nada de rede, banco ou relógio próprio. Esquema, conforme docs.asaas.com:
 *
 *   - Autenticação: o Asaas envia, em TODA notificação, o token que o operador
 *     configurou no webhook, no header `asaas-access-token`. Não há HMAC nem
 *     timestamp: a defesa contra replay é a idempotência pelo `id` do evento.
 *   - Payload: `id` (do EVENTO — a chave de idempotência; a entrega é at-least-once),
 *     `event`, `dateCreated` e o objeto relacionado, `payment` ou `subscription`.
 *     `payment.subscription` é o id da assinatura de origem (quando a cobrança é
 *     recorrente); `payment.invoiceUrl` é a fatura hospedada.
 *
 * ═══ O QUE NÃO FOI MEDIDO ═══
 *
 * Nada aqui foi visto num payload real, só na documentação. `dateCreated`
 * ("2024-06-12 16:45:03") não declara fuso, e por isso NÃO é usado para ordenar
 * eventos — quem aplica usa o instante do recebimento. Ver a ADR-0006.
 * `lerEventoDoAsaas` lê o que a doc promete e degrada para `null` em qualquer
 * formato inesperado; nunca lança.
 */
import { createHash, timingSafeEqual } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Leitura do evento
// ─────────────────────────────────────────────────────────────────────────────

export interface EventoDoAsaas {
  /** `id` do EVENTO — base da idempotência. */
  eventoId: string;
  evento: string;
  pagamentoId: string | null;
  assinaturaId: string | null;
  clienteId: string | null;
  /** `externalReference` do pagamento ou da assinatura — o token opaco NOSSO, quando o Asaas o devolve. */
  referenciaExterna: string | null;
  faturaUrl: string | null;
  /** `YYYY-MM-DD`, o vencimento da cobrança. */
  vencimento: string | null;
  billingType: string | null;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const objetoOuVazio = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** `YYYY-MM-DD` e uma data que existe; qualquer outra coisa não é um vencimento. */
export function dataDeVencimentoValida(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * Só `https:` vira link. A URL da fatura vai para `href` e para
 * `window.location.assign`: um `javascript:` vindo de payload não pode chegar lá.
 */
export function urlDeFaturaValida(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2048) return false;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Lê `id`, `event` e `payment`/`subscription`. Nunca lança: formato fora do
 * esperado degrada para `null` no campo, ou `null` no evento inteiro quando
 * falta `id` ou `event`.
 */
export function lerEventoDoAsaas(json: unknown): EventoDoAsaas | null {
  if (typeof json !== "object" || json === null) return null;
  const raiz = json as Record<string, unknown>;
  const eventoId = texto(raiz.id);
  const evento = texto(raiz.event);
  if (!eventoId || !evento) return null;

  const pagamento = objetoOuVazio(raiz.payment);
  const assinatura = objetoOuVazio(raiz.subscription);

  // `payment.subscription` é o id (string); em `SUBSCRIPTION_*` o id está no próprio objeto.
  const assinaturaId = texto(pagamento.subscription) ?? texto(assinatura.id);
  const faturaUrl = urlDeFaturaValida(pagamento.invoiceUrl) ? pagamento.invoiceUrl : null;

  return {
    eventoId,
    evento,
    pagamentoId: texto(pagamento.id),
    assinaturaId,
    clienteId: texto(pagamento.customer) ?? texto(assinatura.customer),
    referenciaExterna: texto(pagamento.externalReference) ?? texto(assinatura.externalReference),
    faturaUrl,
    vencimento: dataDeVencimentoValida(pagamento.dueDate) ? pagamento.dueDate : null,
    billingType: texto(pagamento.billingType) ?? texto(assinatura.billingType),
  };
}

/** A chave do recibo é o `id` do evento: é ele que o Asaas repete nas reentregas. */
export function chaveDoEvento(e: EventoDoAsaas): string {
  return e.eventoId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Evento → plano
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O efeito na assinatura, mas SEM `periodoAte`: quem planeja o evento não sabe até
 * quando o período pago vai; quem aplica calcula (via `fimDoAcessoPago`) e monta o
 * `EfeitoNaAssinatura` de `lib/planos/cobranca/maquina.ts`.
 */
export type EfeitoDoAsaasSemPeriodo =
  | { tipo: "pago" }
  | { tipo: "falhou" }
  | { tipo: "nao_renova" }
  | { tipo: "estornado" };

export type PlanoDoEventoDoAsaas =
  | { acao: "efeito"; efeito: EfeitoDoAsaasSemPeriodo }
  /** `PAYMENT_CREATED`: só registra o link e o vencimento da fatura em aberto. */
  | { acao: "fatura" }
  | { acao: "ignorar"; motivo: string };

/**
 * O mapa evento → efeito.
 *
 * `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` são `pago` os dois: o cartão libera no
 * CONFIRMED, e o MESMO pagamento pode chegar nos dois — o efeito é idempotente
 * porque o fim do acesso sai do vencimento da cobrança, não da data de hoje.
 */
export function planejarEventoDoAsaas(e: EventoDoAsaas): PlanoDoEventoDoAsaas {
  switch (e.evento) {
    case "PAYMENT_RECEIVED":
    case "PAYMENT_CONFIRMED":
      return { acao: "efeito", efeito: { tipo: "pago" } };
    case "PAYMENT_OVERDUE":
      return { acao: "efeito", efeito: { tipo: "falhou" } };
    case "PAYMENT_REFUNDED":
    case "PAYMENT_CHARGEBACK_REQUESTED":
      return { acao: "efeito", efeito: { tipo: "estornado" } };
    case "SUBSCRIPTION_DELETED":
    case "SUBSCRIPTION_INACTIVATED":
      return { acao: "efeito", efeito: { tipo: "nao_renova" } };
    case "PAYMENT_CREATED":
      return { acao: "fatura" };
    default:
      return { acao: "ignorar", motivo: `evento_nao_tratado:${e.evento}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Verificação
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compara o `asaas-access-token` recebido com o configurado, por HASH e
 * `timingSafeEqual` (comparar os hashes iguala o tamanho e não vaza o
 * comprimento do segredo). Entrada ausente nunca é o segredo certo.
 */
export function verificarTokenDoAsaas(recebido: string | null | undefined, segredo: string): boolean {
  if (typeof recebido !== "string" || recebido === "" || segredo === "") return false;
  const a = createHash("sha256").update(recebido).digest();
  const b = createHash("sha256").update(segredo).digest();
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Entrada sanitizada (recibo e reprocessamento)
// ─────────────────────────────────────────────────────────────────────────────

/** O que vai para `cobranca_eventos_asaas.entrada`: identificadores, nunca dado pessoal. */
export function entradaSanitizada(e: EventoDoAsaas): Record<string, unknown> {
  return {
    eventoId: e.eventoId,
    evento: e.evento,
    pagamentoId: e.pagamentoId,
    assinaturaId: e.assinaturaId,
    clienteId: e.clienteId,
    referenciaExterna: e.referenciaExterna,
    faturaUrl: e.faturaUrl,
    vencimento: e.vencimento,
    billingType: e.billingType,
  };
}

/** O inverso de `entradaSanitizada`, para a ligação manual reprocessar o recibo. */
export function eventoDaEntrada(json: unknown): EventoDoAsaas | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as Record<string, unknown>;
  const eventoId = texto(j.eventoId);
  const evento = texto(j.evento);
  if (!eventoId || !evento) return null;
  return {
    eventoId,
    evento,
    pagamentoId: texto(j.pagamentoId),
    assinaturaId: texto(j.assinaturaId),
    clienteId: texto(j.clienteId),
    referenciaExterna: texto(j.referenciaExterna),
    faturaUrl: urlDeFaturaValida(j.faturaUrl) ? j.faturaUrl : null,
    vencimento: dataDeVencimentoValida(j.vencimento) ? j.vencimento : null,
    billingType: texto(j.billingType),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. O fim do período pago
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O vencimento da PRÓXIMA cobrança de uma assinatura cujo ciclo atual venceu em
 * `vencimento` (`YYYY-MM-DD`): mais um mês (ou um ano), com o dia limitado ao último
 * do mês de destino (31/jan + 1 mês = 28/fev). O instante é o FIM do dia em
 * America/Sao_Paulo (UTC-3): quem paga o Pix na própria data de vencimento não pode
 * ver o acesso fechar às 21h.
 *
 * Sai do vencimento da cobrança paga, e não de "hoje": o mesmo pagamento, entregue
 * duas vezes (`PAYMENT_CONFIRMED` e depois `PAYMENT_RECEIVED`), dá o mesmo prazo.
 */
export function proximoVencimento(vencimento: string, intervalo: "mensal" | "anual"): Date | null {
  if (!dataDeVencimentoValida(vencimento)) return null;
  const [ano, mes, dia] = vencimento.split("-").map(Number) as [number, number, number];
  const mesesAMais = intervalo === "anual" ? 12 : 1;
  const alvo = new Date(Date.UTC(ano, mes - 1 + mesesAMais, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const diaFinal = Math.min(dia, ultimoDia);
  const iso = `${String(alvo.getUTCFullYear()).padStart(4, "0")}-${String(alvo.getUTCMonth() + 1).padStart(2, "0")}-${String(diaFinal).padStart(2, "0")}`;
  return new Date(`${iso}T23:59:59-03:00`);
}
