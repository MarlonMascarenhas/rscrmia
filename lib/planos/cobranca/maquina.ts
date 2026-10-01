/**
 * A MÁQUINA DE ESTADOS DE ASSINATURA — NEUTRA DE PROVEDOR. PURA.
 *
 * Cópia de `lib/planos/stripe/webhook.ts` (seção 3), com o EFEITO trocado por um
 * vocabulário que não fala Stripe — porque a Cakto não manda status de assinatura
 * do jeito do Stripe (`active`/`past_due`/`canceled`...); manda EVENTOS
 * (`purchase_approved`, `subscription_renewal_refused`...), e cada evento já É o
 * efeito. Ver `lib/planos/cakto/webhook.ts` para o mapeamento evento → efeito.
 *
 * Nada aqui toca rede, banco ou relógio próprio (`agora` é argumento) — o mesmo
 * contrato do arquivo copiado, pela mesma razão: provar a máquina inteira sem
 * subir nada.
 */
import type { SituacaoDeAssinatura } from "@/lib/planos/decisao";

// ─────────────────────────────────────────────────────────────────────────────
// 1. O efeito, neutro de provedor
// ─────────────────────────────────────────────────────────────────────────────

export type EfeitoNaAssinatura =
  | { tipo: "pago"; periodoAte: Date | null }
  | { tipo: "falhou" }
  | { tipo: "nao_renova" }
  | { tipo: "estornado" };

// ─────────────────────────────────────────────────────────────────────────────
// 2. A máquina de estados
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

export const maisTardia = (a: Date | null, b: Date | null): Date | null =>
  a && b ? (a.getTime() >= b.getTime() ? a : b) : (a ?? b);

/**
 * O que um efeito faz com a assinatura.
 *
 * `atual = null` é "nunca houve linha", e nesse caso só um efeito `pago` COM FIM
 * DE PERÍODO cria a linha — o mesmo motivo do Stripe: uma linha `ativa` sem data
 * de fim seria "sem prazo" = acesso vitalício.
 */
export function proximaAssinatura(entrada: {
  atual: AssinaturaAtual | null;
  efeito: EfeitoNaAssinatura;
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

  if (efeito.tipo === "pago") {
    const fim = maisTardia(atual?.liberadoAte ?? null, efeito.periodoAte);
    // Sem fim de período não há o que registrar: uma linha `ativa` sem data seria
    // "sem prazo", que é vitalício.
    if (!fim) return { aplicar: false, motivo: "sem_periodo" };
    return {
      aplicar: true,
      valores: { situacao: "ativa", liberadoAte: fim, carenciaAte: null, canceladaEm: null, ultimoEventoEm },
    };
  }

  if (efeito.tipo === "falhou") {
    // inadimplente só muda o que já existe: nunca cria linha, senão a organização
    // ficaria com `liberado_ate` nulo — acesso vitalício.
    if (!atual) return { aplicar: false, motivo: "sem_assinatura" };
    // Fatura que falha DEPOIS do cancelamento não ressuscita nada.
    if (atual.situacao === "cancelada" || atual.canceladaEm !== null) {
      return { aplicar: false, motivo: "sem_efeito" };
    }
    return {
      aplicar: true,
      valores: {
        situacao: "inadimplente",
        liberadoAte: atual.liberadoAte,
        // A carência conta a partir da PRIMEIRA falha: cada evento de retentativa
        // não a estende, senão um cartão que nunca passa nunca vence.
        carenciaAte: atual.situacao === "inadimplente" && atual.carenciaAte ? atual.carenciaAte : carenciaNova,
        canceladaEm: null,
        ultimoEventoEm,
      },
    };
  }

  if (efeito.tipo === "nao_renova") {
    if (!atual) return { aplicar: false, motivo: "sem_assinatura" };
    if (atual.situacao === "cancelada") return { aplicar: false, motivo: "sem_efeito" };
    // Mantém situação, liberadoAte e carenciaAte: só marca que não vai renovar.
    return {
      aplicar: true,
      valores: {
        situacao: atual.situacao,
        liberadoAte: atual.liberadoAte,
        carenciaAte: atual.carenciaAte,
        canceladaEm: atual.canceladaEm ?? agora,
        ultimoEventoEm,
      },
    };
  }

  // estornado: cancela na hora, sem carência — dinheiro devolvido não é acesso
  // pago em dia. `liberadoAte` do Stripe fica; aqui não há linha "ativa" a
  // preservar além disso.
  if (!atual) return { aplicar: false, motivo: "sem_assinatura" };
  return {
    aplicar: true,
    valores: {
      situacao: "cancelada",
      liberadoAte: atual.liberadoAte,
      carenciaAte: null,
      canceladaEm: atual.canceladaEm ?? agora,
      ultimoEventoEm,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. O fim do acesso pago — a partir da PRÓXIMA COBRANÇA, nunca do carimbo antigo
// ─────────────────────────────────────────────────────────────────────────────

/** Dias do intervalo de cobrança, quando a Cakto não manda a próxima data válida. */
export const DIAS_DO_INTERVALO = { mensal: 30, anual: 365 } as const;

/** 1 dia de margem sobre o prazo — para a renovação seguinte não achar a conta
 *  vencida por segundos de diferença de relógio entre o gateway e este servidor. */
export const MARGEM_DE_RENOVACAO_MS = 86_400_000;

/**
 * O novo `liberadoAte`, calculado a partir do que o EVENTO ATUAL diz — nunca a
 * partir do `liberadoAte` anterior. Dois eventos da mesma renovação (ex.: a Cakto
 * reentrega) estenderiam o prazo duas vezes se somássemos à data antiga; somar à
 * `proximaCobranca` do próprio evento é idempotente: reentregar o mesmo evento dá
 * o mesmo resultado.
 *
 * NUNCA soma carência aqui: carência é do lado de `falhou`, não de `pago`.
 */
export function fimDoAcessoPago(e: {
  proximaCobranca: Date | null;
  intervalo: "mensal" | "anual" | null;
  agora: Date;
}): Date | null {
  const { proximaCobranca, intervalo, agora } = e;
  const QUATROCENTOS_DIAS_MS = 400 * 86_400_000;
  const proximaValida =
    proximaCobranca !== null &&
    proximaCobranca.getTime() > agora.getTime() &&
    proximaCobranca.getTime() < agora.getTime() + QUATROCENTOS_DIAS_MS;

  let base: Date;
  if (proximaValida) {
    base = proximaCobranca as Date;
  } else if (intervalo !== null) {
    base = new Date(agora.getTime() + DIAS_DO_INTERVALO[intervalo] * 86_400_000);
  } else {
    return null;
  }
  return new Date(base.getTime() + MARGEM_DE_RENOVACAO_MS);
}
