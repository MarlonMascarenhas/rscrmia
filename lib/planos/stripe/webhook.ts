/**
 * O WEBHOOK DO STRIPE — VERIFICAÇÃO, MAPEAMENTO E A MÁQUINA DE ESTADOS. PURO.
 *
 * Nada aqui toca rede, banco ou relógio próprio (`agora` é argumento). Isso é o
 * que permite provar a parte perigosa — o que cada evento faz com uma assinatura
 * — contra todos os desvios que o provedor pode fazer, sem subir nada.
 *
 * ═══ POR QUE HMAC PRÓPRIO E NÃO O SDK ═══
 *
 * O esquema do Stripe é `t=<timestamp>,v1=<hex de HMAC-SHA256("<t>.<corpo>")>`, e o
 * repo já verifica assinatura de webhook assim (WAHA: HMAC + `timingSafeEqual`).
 * Puxar o SDK inteiro só para isto pesaria na imagem — `build-and-size` é check
 * obrigatório — e esconderia a tolerância de timestamp, que é justamente o que
 * vigia replay. O corpo TEM de ser o texto CRU: parsear antes de verificar quebra a
 * assinatura, e o erro que sai ("assinatura inválida") não sugere a causa.
 *
 * ═══ O STRIPE NÃO GARANTE ORDEM, E REENTREGA POR DIAS ═══
 *
 * Um `subscription.updated` atrasado não pode descancelar nem re-trancar uma conta.
 * `ultimo_evento_em` guarda o `created` do último evento aplicado; evento mais
 * antigo que ele é REGISTRADO e IGNORADO. Sem isso o defeito é silencioso — nada
 * estoura, a conta só fica no estado errado.
 *
 * ═══ SÓ UM CAMINHO CONCEDE ACESSO A QUEM NÃO TEM LINHA ═══
 *
 * A linha de `assinaturas` só nasce com um período pago futuro. Uma linha sem
 * `liberado_ate` sincronizaria `null` para a organização, e `null` é "SEM PRAZO" —
 * acesso vitalício. Por isso `inadimplente`/`cancelada` sem linha prévia são
 * ignorados, e `ativa` sem data de fim também: melhor recusar registrar do que
 * registrar uma assinatura que não vence.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { SituacaoDeAssinatura } from "@/lib/planos/decisao";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Assinatura
// ─────────────────────────────────────────────────────────────────────────────

export type ResultadoDaAssinatura =
  | { ok: true }
  | {
      ok: false;
      motivo: "cabecalho_ausente" | "cabecalho_malformado" | "assinatura_invalida" | "fora_da_tolerancia";
    };

/** 5 minutos, o padrão do provedor. Mais que isso é janela para replay. */
export const TOLERANCIA_PADRAO_SEGUNDOS = 300;

export function verificarAssinaturaDoStripe(entrada: {
  /** O corpo CRU, byte a byte. `req.text()`, nunca `JSON.stringify(await req.json())`. */
  corpo: string;
  cabecalho: string | null;
  segredo: string;
  agora: Date;
  toleranciaSegundos?: number;
}): ResultadoDaAssinatura {
  const { corpo, cabecalho, segredo, agora, toleranciaSegundos = TOLERANCIA_PADRAO_SEGUNDOS } = entrada;
  if (!cabecalho) return { ok: false, motivo: "cabecalho_ausente" };

  let t: string | null = null;
  const v1: string[] = [];
  for (const parte of cabecalho.split(",")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const chave = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (chave === "t") t = valor;
    else if (chave === "v1") v1.push(valor);
  }
  if (t === null || !/^\d+$/.test(t) || v1.length === 0) return { ok: false, motivo: "cabecalho_malformado" };

  const esperado = createHmac("sha256", segredo).update(`${t}.${corpo}`).digest();
  // O provedor pode mandar mais de um `v1` (rotação de segredo): basta um casar.
  // Compara BYTES de mesmo tamanho — `timingSafeEqual` lança se diferirem, e um
  // hex de tamanho errado é entrada hostil, não motivo para 500.
  const casou = v1.some((hex) => {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== esperado.length * 2) return false;
    return timingSafeEqual(Buffer.from(hex, "hex"), esperado);
  });
  if (!casou) return { ok: false, motivo: "assinatura_invalida" };

  const idade = Math.abs(agora.getTime() / 1000 - Number(t));
  if (idade > toleranciaSegundos) return { ok: false, motivo: "fora_da_tolerancia" };
  return { ok: true };
}

/** Gera o cabeçalho que o provedor geraria. Existe para os TESTES provarem a verificação. */
export function assinarParaTeste(corpo: string, segredo: string, t: number): string {
  const v1 = createHmac("sha256", segredo).update(`${t}.${corpo}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Evento → efeito
// ─────────────────────────────────────────────────────────────────────────────

export interface EventoDoStripe {
  id: string;
  type: string;
  /** Segundos desde a época. É a ordem do provedor, e a única que vale. */
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

export type Efeito =
  | { tipo: "vincular_checkout"; sessaoId: string; clienteId: string | null; assinaturaId: string | null }
  | { tipo: "assinatura"; assinaturaId: string; clienteId: string | null; status: string; periodoAte: Date | null }
  | { tipo: "fatura_paga"; assinaturaId: string | null; clienteId: string | null; periodoAte: Date | null }
  | { tipo: "fatura_falhou"; assinaturaId: string | null; clienteId: string | null }
  | { tipo: "ignorar"; porque: string };

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** O provedor manda o objeto expandido OU só o id, conforme a versão da API. */
const idDe = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : v && typeof v === "object" ? texto((v as { id?: unknown }).id) : null;
const dataDe = (segundos: unknown): Date | null =>
  typeof segundos === "number" && Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : null;

/**
 * O fim do período pago de uma ASSINATURA.
 *
 * A API do Stripe moveu `current_period_end` do objeto da assinatura para cada item
 * dela (versão `basil`, 2025). Lê os dois, e no caso de vários itens vale o MAIOR:
 * é até quando o cliente pagou por algo.
 */
export function fimDoPeriodoDaAssinatura(sub: Record<string, unknown>): Date | null {
  const direto = dataDe(sub.current_period_end);
  const itens = ((sub.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])
    .map((i) => dataDe(i.current_period_end))
    .filter((d): d is Date => d !== null);
  const todos = [...(direto ? [direto] : []), ...itens];
  return todos.length === 0 ? null : new Date(Math.max(...todos.map((d) => d.getTime())));
}

/** O fim do período que uma FATURA paga cobriu: o maior `period.end` das linhas. */
export function fimDoPeriodoDaFatura(fatura: Record<string, unknown>): Date | null {
  const linhas = ((fatura.lines as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])
    .map((l) => dataDe((l.period as { end?: unknown } | undefined)?.end))
    .filter((d): d is Date => d !== null);
  return linhas.length === 0 ? null : new Date(Math.max(...linhas.map((d) => d.getTime())));
}

/** A assinatura de uma fatura: campo direto (API antiga) ou dentro de `parent` (nova). */
function assinaturaDaFatura(fatura: Record<string, unknown>): string | null {
  const direto = idDe(fatura.subscription);
  if (direto) return direto;
  const pai = fatura.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return idDe(pai?.subscription_details?.subscription);
}

export function planejarEfeito(evento: EventoDoStripe): Efeito {
  const o = evento.data.object;
  switch (evento.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // Só VINCULA. Quem concede acesso é o estado da ASSINATURA (abaixo), nunca o
      // fim do checkout: com Pix, a sessão completa antes de o dinheiro entrar.
      if (o.mode !== "subscription") return { tipo: "ignorar", porque: "checkout_nao_e_assinatura" };
      const sessaoId = texto(o.id);
      if (!sessaoId) return { tipo: "ignorar", porque: "checkout_sem_id" };
      return { tipo: "vincular_checkout", sessaoId, clienteId: idDe(o.customer), assinaturaId: idDe(o.subscription) };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const assinaturaId = texto(o.id);
      if (!assinaturaId) return { tipo: "ignorar", porque: "assinatura_sem_id" };
      return {
        tipo: "assinatura",
        assinaturaId,
        clienteId: idDe(o.customer),
        // `deleted` chega com o status que a assinatura tinha; o EVENTO é que diz cancelada.
        status: evento.type === "customer.subscription.deleted" ? "canceled" : (texto(o.status) ?? "desconhecido"),
        periodoAte: fimDoPeriodoDaAssinatura(o),
      };
    }
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return { tipo: "fatura_paga", assinaturaId: assinaturaDaFatura(o), clienteId: idDe(o.customer), periodoAte: fimDoPeriodoDaFatura(o) };
    case "invoice.payment_failed":
      return { tipo: "fatura_falhou", assinaturaId: assinaturaDaFatura(o), clienteId: idDe(o.customer) };
    default:
      return { tipo: "ignorar", porque: "tipo_nao_tratado" };
  }
}

/**
 * O status do provedor → a situação nossa. `null` = sem efeito.
 *
 * `incomplete` é o checkout que ainda não fechou: não há o que conceder nem tirar.
 * `paused` cai em inadimplente porque quem pausou não está pagando.
 */
export function situacaoDoStatus(status: string): SituacaoDeAssinatura | null {
  switch (status) {
    case "active":
    case "trialing":
      return "ativa";
    case "past_due":
    case "unpaid":
    case "paused":
      return "inadimplente";
    case "canceled":
    case "incomplete_expired":
      return "cancelada";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. A máquina de estados
// ─────────────────────────────────────────────────────────────────────────────

export interface AssinaturaAtual {
  situacao: SituacaoDeAssinatura;
  liberadoAte: Date | null;
  carenciaAte: Date | null;
  canceladaEm: Date | null;
  ultimoEventoEm: Date | null;
}

export interface NovosValores {
  situacao: SituacaoDeAssinatura;
  liberadoAte: Date | null;
  carenciaAte: Date | null;
  canceladaEm: Date | null;
  ultimoEventoEm: Date;
}

export type Transicao =
  | { aplicar: true; valores: NovosValores }
  | { aplicar: false; motivo: "fora_de_ordem" | "sem_efeito" | "sem_periodo" | "sem_assinatura" };

const maisTardia = (a: Date | null, b: Date | null): Date | null =>
  a && b ? (a.getTime() >= b.getTime() ? a : b) : (a ?? b);

/**
 * O que um efeito faz com a assinatura.
 *
 * `atual = null` é "nunca houve linha", e nesse caso só uma assinatura ATIVA COM
 * FIM DE PERÍODO cria a linha (ver o cabeçalho).
 */
export function proximaAssinatura(entrada: {
  atual: AssinaturaAtual | null;
  efeito: Efeito;
  eventoCriadoEm: Date;
  agora: Date;
  carenciaDias: number;
}): Transicao {
  const { atual, efeito, eventoCriadoEm, agora, carenciaDias } = entrada;

  if (atual?.ultimoEventoEm && eventoCriadoEm.getTime() < atual.ultimoEventoEm.getTime()) {
    return { aplicar: false, motivo: "fora_de_ordem" };
  }
  const ultimoEventoEm = maisTardia(atual?.ultimoEventoEm ?? null, eventoCriadoEm) as Date;
  const carenciaNova = new Date(agora.getTime() + carenciaDias * 86_400_000);

  // Estado alvo, decidido pelo efeito.
  let situacao: SituacaoDeAssinatura | null;
  let periodoAte: Date | null = null;
  if (efeito.tipo === "assinatura") {
    situacao = situacaoDoStatus(efeito.status);
    periodoAte = efeito.periodoAte;
  } else if (efeito.tipo === "fatura_paga") {
    situacao = "ativa";
    periodoAte = efeito.periodoAte;
  } else if (efeito.tipo === "fatura_falhou") {
    situacao = "inadimplente";
  } else {
    return { aplicar: false, motivo: "sem_efeito" };
  }
  if (situacao === null) return { aplicar: false, motivo: "sem_efeito" };

  if (situacao === "ativa") {
    const fim = maisTardia(atual?.liberadoAte ?? null, periodoAte);
    // Sem fim de período não há o que registrar: uma linha `ativa` sem data seria
    // "sem prazo", que é vitalício.
    if (!fim) return { aplicar: false, motivo: "sem_periodo" };
    return {
      aplicar: true,
      valores: { situacao, liberadoAte: fim, carenciaAte: null, canceladaEm: null, ultimoEventoEm },
    };
  }

  // inadimplente e cancelada só mudam o que já existe: nunca criam linha, senão a
  // organização ficaria com `liberado_ate` nulo — acesso vitalício.
  if (!atual) return { aplicar: false, motivo: "sem_assinatura" };
  // Fatura que falha DEPOIS do cancelamento não ressuscita nada.
  if (atual.situacao === "cancelada" && situacao === "inadimplente") return { aplicar: false, motivo: "sem_efeito" };

  if (situacao === "inadimplente") {
    return {
      aplicar: true,
      valores: {
        situacao,
        liberadoAte: maisTardia(atual.liberadoAte, periodoAte),
        // A carência conta a partir da PRIMEIRA falha: cada evento de retentativa
        // não a estende, senão um cartão que nunca passa nunca vence.
        carenciaAte: atual.situacao === "inadimplente" && atual.carenciaAte ? atual.carenciaAte : carenciaNova,
        canceladaEm: null,
        ultimoEventoEm,
      },
    };
  }

  // cancelada: o acesso já pago continua até o fim do período (`liberado_ate` fica);
  // o que muda é que não renova. O gate nega `cancelada` mesmo dentro do prazo —
  // ver `decisao.ts` — então quem cancela perde o acesso na hora, como pediu.
  return {
    aplicar: true,
    valores: {
      situacao,
      liberadoAte: atual.liberadoAte,
      carenciaAte: null,
      canceladaEm: atual.canceladaEm ?? agora,
      ultimoEventoEm,
    },
  };
}
