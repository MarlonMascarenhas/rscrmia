/**
 * O WEBHOOK DA CAKTO — LEITURA, VERIFICAÇÃO E PLANEJAMENTO. PURO.
 *
 * Espelha `lib/planos/stripe/webhook.ts` na forma (nada de rede, banco ou relógio
 * próprio; `agora` é argumento), mas o esquema é outro — documentação oficial da
 * Cakto:
 *
 *   - Assinatura: dois cabeçalhos, `X-Cakto-Timestamp` (segundos unix) e
 *     `X-Cakto-Signature` (uma ou mais partes `v1=<hex>` separadas por vírgula,
 *     para rotação de segredo — o mesmo desenho do Stripe). O hex é
 *     HMAC-SHA256(segredo, `${timestamp}.${corpoCru}`). Tolerância padrão: 5
 *     minutos, a mesma janela contra replay.
 *   - A Cakto TAMBÉM aceita um segredo simples embutido no corpo
 *     (`verificarSegredoNoCorpo`) para quem não configura HMAC — mais fraco,
 *     mas documentado como caminho válido.
 *   - `data.callback`: um token de correlação que o INTEGRADOR escolheu ao criar
 *     o checkout, devolvido no evento. Charset documentado: `[A-Za-z0-9._~-]`,
 *     no máximo 255 caracteres — fora disso não é um callback nosso, é descartado.
 *   - Dedup: a Cakto reentrega: `data.id` é o identificador do PEDIDO, e é a base
 *     da chave de idempotência.
 *
 * ═══ O QUE NÃO FOI MEDIDO ═══
 *
 * O formato exato de `data.subscription` (quais campos além de `id`, `status` e
 * `next_payment_date` a Cakto realmente manda, e se `status` tem vocabulário
 * fixo) não foi visto num payload real — só na documentação. `lerEventoDaCakto`
 * lê o que a doc promete e degrada para `null`/ignorar em qualquer formato
 * inesperado, nunca lança.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Leitura do evento
// ─────────────────────────────────────────────────────────────────────────────

export interface EventoDaCakto {
  evento: string;
  pedidoId: string | null;
  callback: string | null;
  clienteId: string | null;
  email: string | null;
  produtoId: string | null;
  ofertaId: string | null;
  assinatura: { id: string; status: string | null; proximaCobranca: Date | null } | null;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** A Cakto pode mandar id como string ou como número, a depender do campo. */
const idParaTexto = (v: unknown): string | null => {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};
const objetoOuVazio = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const dataDeTexto = (v: unknown): Date | null => {
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
};

/** `[A-Za-z0-9._~-]`, 1 a 255 caracteres — o charset que a Cakto documenta para
 *  `data.callback`. Qualquer outra coisa não é um token nosso. */
export function tokenDeCallbackValido(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9._~-]{1,255}$/.test(s);
}

/**
 * Lê `event` e `data.{id, callback, customer.{id,email}, product.id, offer.id,
 * subscription}`. Nunca lança: qualquer formato fora do esperado degrada para
 * `null` no campo, ou `null` no evento inteiro quando falta `event`.
 */
export function lerEventoDaCakto(json: unknown): EventoDaCakto | null {
  if (typeof json !== "object" || json === null) return null;
  const raiz = json as Record<string, unknown>;
  const evento = raiz.event;
  if (typeof evento !== "string" || evento === "") return null;

  const d = objetoOuVazio(raiz.data);
  const customer = objetoOuVazio(d.customer);
  const product = objetoOuVazio(d.product);
  const offer = objetoOuVazio(d.offer);

  const subBruto = d.subscription;
  const sub = typeof subBruto === "object" && subBruto !== null ? (subBruto as Record<string, unknown>) : null;
  const subId = sub ? idParaTexto(sub.id) : null;
  const assinatura =
    sub && subId
      ? { id: subId, status: texto(sub.status), proximaCobranca: dataDeTexto(sub.next_payment_date) }
      : null;

  return {
    evento,
    pedidoId: idParaTexto(d.id),
    callback: tokenDeCallbackValido(d.callback) ? d.callback : null,
    clienteId: idParaTexto(customer.id),
    email: texto(customer.email),
    produtoId: idParaTexto(product.id),
    ofertaId: idParaTexto(offer.id),
    assinatura,
  };
}

/** A chave de idempotência: o pedido é a unidade de dedup da Cakto. Sem pedido
 *  (nunca visto, mas a doc não garante), cai no hash do corpo cru — determinístico
 *  para o MESMO corpo, sem inventar um id que não existe. */
export function chaveDoEvento(e: EventoDaCakto, corpoCru: string): string {
  if (e.pedidoId) return `${e.evento}:${e.pedidoId}`;
  const hash = createHash("sha256").update(corpoCru).digest("hex").slice(0, 32);
  return `${e.evento}:sem-id:${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Evento → plano
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O efeito na assinatura, mas SEM `periodoAte` — quem planeja o evento não sabe
 * até quando o período pago vai; isso é responsabilidade de quem aplica (via
 * `fimDoAcessoPago`, com a `proximaCobranca` do evento e o intervalo do plano),
 * que então monta o `EfeitoNaAssinatura` de `lib/planos/cobranca/maquina.ts`.
 */
export type EfeitoDaCaktoSemPeriodo =
  | { tipo: "pago" }
  | { tipo: "falhou" }
  | { tipo: "nao_renova" }
  | { tipo: "estornado" };

export type PlanoDoEventoDaCakto =
  | { acao: "efeito"; efeito: EfeitoDaCaktoSemPeriodo }
  | { acao: "vincular" }
  | { acao: "ignorar"; motivo: string };

/**
 * O mapa evento → efeito, conforme a documentação de eventos da Cakto.
 *
 * `subscription_created` só VINCULA (o cliente/pedido à assinatura) — não é
 * pagamento em si; `purchase_approved` e as renovações é que concedem acesso.
 */
export function planejarEventoDaCakto(e: EventoDaCakto): PlanoDoEventoDaCakto {
  switch (e.evento) {
    case "purchase_approved":
    case "subscription_renewed":
    case "subscription_late_recovered":
      return { acao: "efeito", efeito: { tipo: "pago" } };
    case "subscription_renewal_refused":
    case "subscription_late":
      return { acao: "efeito", efeito: { tipo: "falhou" } };
    case "subscription_canceled":
      return { acao: "efeito", efeito: { tipo: "nao_renova" } };
    case "refund":
    case "chargeback":
      return { acao: "efeito", efeito: { tipo: "estornado" } };
    case "subscription_created":
      return { acao: "vincular" };
    default:
      return { acao: "ignorar", motivo: `evento_nao_tratado:${e.evento}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Verificação
// ─────────────────────────────────────────────────────────────────────────────

export type ResultadoDaAssinaturaDaCakto =
  | { ok: true; enviadoEm: Date }
  | { ok: false; motivo: "cabecalho_ausente" | "malformado" | "assinatura_invalida" | "fora_da_tolerancia" };

/** 5 minutos — a mesma janela do Stripe, documentada pela Cakto contra replay. */
export const TOLERANCIA_PADRAO_SEGUNDOS = 300;

/**
 * `X-Cakto-Timestamp` (segundos unix) + `X-Cakto-Signature` (`v1=<hex>`, uma ou
 * mais partes separadas por vírgula — rotação de segredo). O corpo TEM de ser o
 * texto CRU: reserializar quebra a assinatura.
 */
export function verificarAssinaturaDaCakto(entrada: {
  corpo: string;
  timestamp: string | null;
  assinatura: string | null;
  segredo: string;
  agora: Date;
  toleranciaSegundos?: number;
}): ResultadoDaAssinaturaDaCakto {
  const { corpo, timestamp, assinatura, segredo, agora, toleranciaSegundos = TOLERANCIA_PADRAO_SEGUNDOS } = entrada;
  if (!timestamp || !assinatura) return { ok: false, motivo: "cabecalho_ausente" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, motivo: "malformado" };

  const v1: string[] = [];
  for (const parte of assinatura.split(",")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const chave = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (chave === "v1") v1.push(valor);
  }
  if (v1.length === 0) return { ok: false, motivo: "malformado" };

  const esperado = createHmac("sha256", segredo).update(`${timestamp}.${corpo}`).digest();
  // Compara BYTES de mesmo tamanho — hex de tamanho errado é entrada hostil, não
  // motivo para lançar (`timingSafeEqual` lançaria em tamanhos diferentes).
  const casou = v1.some((hex) => {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== esperado.length * 2) return false;
    return timingSafeEqual(Buffer.from(hex, "hex"), esperado);
  });
  if (!casou) return { ok: false, motivo: "assinatura_invalida" };

  const idade = Math.abs(agora.getTime() / 1000 - Number(timestamp));
  if (idade > toleranciaSegundos) return { ok: false, motivo: "fora_da_tolerancia" };
  return { ok: true, enviadoEm: new Date(Number(timestamp) * 1000) };
}

/** Gera o cabeçalho que a Cakto geraria. Existe para os TESTES provarem a verificação. */
export function assinarParaTeste(corpo: string, segredo: string, t: number): string {
  return `v1=${createHmac("sha256", segredo).update(`${t}.${corpo}`).digest("hex")}`;
}

/** O caminho alternativo, mais fraco, que a Cakto documenta: um segredo simples
 *  embutido no corpo do evento, comparado por HASH (nunca em texto puro) com
 *  `timingSafeEqual`. Entrada não-string nunca é o segredo certo. */
export function verificarSegredoNoCorpo(recebido: unknown, segredo: string): boolean {
  if (typeof recebido !== "string" || recebido === "") return false;
  const a = createHash("sha256").update(recebido).digest();
  const b = createHash("sha256").update(segredo).digest();
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sanitização (para log/audit sem dado pessoal)
// ─────────────────────────────────────────────────────────────────────────────

/** Tudo do evento MENOS `email` — para logar/auditar sem dado pessoal. */
export function entradaSanitizada(e: EventoDaCakto): Record<string, unknown> {
  return {
    evento: e.evento,
    pedidoId: e.pedidoId,
    callback: e.callback,
    clienteId: e.clienteId,
    produtoId: e.produtoId,
    ofertaId: e.ofertaId,
    assinatura: e.assinatura
      ? {
          id: e.assinatura.id,
          status: e.assinatura.status,
          proximaCobranca: e.assinatura.proximaCobranca ? e.assinatura.proximaCobranca.toISOString() : null,
        }
      : null,
  };
}

/** O inverso de `entradaSanitizada`: lê de volta a estrutura sanitizada, sempre
 *  com `email: null` (nunca esteve ali). */
export function eventoDaEntrada(json: unknown): EventoDaCakto | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as Record<string, unknown>;
  if (typeof j.evento !== "string" || j.evento === "") return null;

  let assinatura: EventoDaCakto["assinatura"] = null;
  const assinaturaBruta = j.assinatura;
  if (typeof assinaturaBruta === "object" && assinaturaBruta !== null) {
    const a = assinaturaBruta as Record<string, unknown>;
    if (typeof a.id === "string" && a.id !== "") {
      assinatura = {
        id: a.id,
        status: typeof a.status === "string" ? a.status : null,
        proximaCobranca: dataDeTexto(a.proximaCobranca),
      };
    }
  }

  return {
    evento: j.evento,
    pedidoId: typeof j.pedidoId === "string" ? j.pedidoId : null,
    callback: typeof j.callback === "string" ? j.callback : null,
    clienteId: typeof j.clienteId === "string" ? j.clienteId : null,
    email: null,
    produtoId: typeof j.produtoId === "string" ? j.produtoId : null,
    ofertaId: typeof j.ofertaId === "string" ? j.ofertaId : null,
    assinatura,
  };
}
