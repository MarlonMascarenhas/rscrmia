/**
 * A DECISÃO DE ACESSO — PURA, SEM I/O, SEM RELÓGIO PRÓPRIO.
 *
 * `agora` é argumento, nunca `new Date()` aqui dentro: é o que torna a escada
 * inteira testável sem banco, sem rede e sem esperar o tempo passar. O contrato é
 * o de `lib/agent-engine/edge/llm/orcamento.ts:17-22`, e a razão é a mesma — uma
 * decisão que lê o mundo não pode ser provada, e esta decide se um negócio
 * trabalha hoje.
 *
 * ═══ A ASSIMETRIA: ACESSO FALHA ABERTO, CAPACIDADE FALHA FECHADO ═══
 *
 * Não há simetria aqui, e a falta dela é deliberada. Cada lado é escolhido pelo
 * RAIO DO ESTRAGO, nunca por elegância:
 *
 *   ACESSO (este arquivo) → falha ABERTO.
 *     Errar fechado num soluço de banco tranca TODAS as organizações da
 *     instalação de uma vez: produto escuro, WhatsApp sem resposta, e quem
 *     consertaria também não abre a tela. Numa VPS self-host não há para quem
 *     ligar. Errar aberto dá alguns minutos a quem venceu, custa centavos de
 *     hospedagem, e o próximo render corrige. Duas ordens de magnitude de
 *     diferença — o mesmo lado de `orcamento.ts:24-28`.
 *
 *   CAPACIDADE (`capacidades.ts` + a guarda) → falha FECHADO, com 503.
 *     Ali o raio é UMA feature, não o produto. Errar aberto entrega em silêncio
 *     o que diferencia os planos, e o silêncio é permanente porque nada fica
 *     vermelho. Errar fechado custa uma feature indisponível por instantes, com
 *     uma frase que manda tentar de novo — e se cura sozinho.
 *
 * ═══ FALHAR ABERTO NÃO É FALHAR CALADO ═══
 *
 * `motivo: "indeterminado"` **libera**, e carrega `naoMedido: true` para obrigar
 * quem chama a alarmar. É `lib/voice/guarda.ts:96-107` aplicado na direção
 * oposta: lá a ação é recusar e o código não pode AFIRMAR uma causa que ninguém
 * mediu; aqui a ação é permitir, e a tela não pode afirmar que a conta está em
 * dia. Ela não diz nada.
 *
 * Um gate que falha aberto em silêncio é um interruptor invisível: um defeito no
 * caminho de leitura vira produto grátis para sempre, com a suíte toda verde. Por
 * isso `naoMedido` existe no tipo — para que esquecê-lo seja uma decisão visível
 * no código de quem chama, e não um descuido.
 *
 * ═══ AUSÊNCIA DE LINHA É TESTE GRÁTIS ═══
 *
 * `situacao: null` significa "nunca assinou", e "nunca assinou + prazo no futuro"
 * é exatamente um teste grátis. Não há linha a gravar no nascimento de uma
 * organização, então nenhum dos quatro berços (`ensureTenantForUser`,
 * `provisionExternalTenant`, `fn_create_tenant_with_owner`,
 * `scripts/bootstrap-owner.ts`) precisa ser emendado — e o quinto não pode nascer
 * errado.
 *
 * Contraste deliberado com `lib/voice/opt-in.ts:25-30`, onde ausência é
 * "desligado": lá a capacidade era nova e ninguém a tinha; aqui a ausência
 * descreve o estado normal de quem acabou de chegar.
 */

/** O que a coluna `assinaturas.situacao` pode dizer. Espelha o CHECK da 0393. */
export type SituacaoDeAssinatura =
  | "ativa"
  | "cortesia"
  | "inadimplente"
  | "cancelada"
  | "expirada";

export type MotivoDoAcesso =
  // ── libera ──────────────────────────────────────────────────────────────────
  /** A instalação não vende. Primeiro degrau, e o mais comum de todos. */
  | "cobranca_desligada"
  /** `acesso_liberado_ate` é null: sem prazo. Organização anterior à cobrança,
   *  ou marcada de propósito para nunca vencer. */
  | "sem_prazo"
  /** Nunca assinou e o prazo do teste não acabou. */
  | "em_teste"
  /** Assinatura em dia. */
  | "assinatura_ativa"
  /** Liberada à mão por quem administra (Pix por fora, cortesia, acordo). */
  | "cortesia"
  /** Pagamento falhou, mas a carência não acabou. Não se corta cliente bom por
   *  um cartão recusado que se resolve em dias. */
  | "em_carencia"
  /** ⚠️ NÃO MEDIDO. Libera, e quem chama DEVE alarmar. */
  | "indeterminado"
  // ── tranca ──────────────────────────────────────────────────────────────────
  | "teste_vencido"
  | "assinatura_vencida"
  | "inadimplente"
  | "cancelada";

export interface EntradaDeAcesso {
  /**
   * `platform_config.COBRANCA_LIGADA === 'ligado'`. Só esse valor liga — linha
   * ausente, outro valor, ou banco que não respondeu é `false`
   * (`lib/instalacao/modulos.ts:23-29`). Falha fechada para o MECANISMO, e por
   * consequência aberta para o usuário: ninguém é trancado por acidente.
   */
  cobrancaLigada: boolean;
  /** `organizations.acesso_liberado_ate`. **null = SEM PRAZO**, nunca "vencido". */
  liberadoAte: Date | null;
  /** `assinaturas.situacao`, ou **null quando não há linha** — e isso é teste. */
  situacao: SituacaoDeAssinatura | null;
  /** `assinaturas.carencia_ate`. Só pesa quando a situação é `inadimplente`. */
  carenciaAte: Date | null;
  /** Injetado sempre. Nunca `new Date()` dentro da decisão. */
  agora: Date;
}

export interface EstadoDeAcesso {
  liberado: boolean;
  /**
   * Três respostas, não um booleano — a razão está em `lib/voice/opt-in.ts:50-56`:
   * é a diferença entre a tela dizer "clique aqui para assinar", "seu pagamento
   * falhou, atualize o cartão" e "fale com quem administra o servidor".
   */
  motivo: MotivoDoAcesso;
  /** Quando o acesso termina. `null` = não há prazo a mostrar. */
  expiraEm: Date | null;
  /** Para a faixa de aviso. `null` quando não há contagem. Nunca negativo. */
  diasRestantes: number | null;
  /** `true` só em `indeterminado`. Quem chama tem de alarmar (Sentry + log). */
  naoMedido: boolean;
}

const DIA_EM_MS = 86_400_000;

function diasAte(alvo: Date, agora: Date): number {
  return Math.max(0, Math.ceil((alvo.getTime() - agora.getTime()) / DIA_EM_MS));
}

/**
 * O construtor honesto do "não sei".
 *
 * Existe como função e não como objeto literal solto para que todo caminho de
 * erro devolva a MESMA coisa — e para que `grep estadoDeAcessoIndeterminado`
 * mostre, numa linha, todos os lugares onde a leitura pode não ter voltado.
 */
export function estadoDeAcessoIndeterminado(): EstadoDeAcesso {
  return {
    liberado: true,
    motivo: "indeterminado",
    expiraEm: null,
    diasRestantes: null,
    naoMedido: true,
  };
}

/**
 * A escada. Cada degrau que libera devolve na hora; o que sobra tranca, com o
 * motivo específico de quem sobrou.
 *
 * A ordem não é arbitrária — ela é o que garante que a recusa nomeie a causa que
 * a pessoa pode resolver. Perguntar "venceu?" antes de "a instalação vende?"
 * mandaria metade das instalações do mundo para uma tela de pagamento que não
 * tem o que cobrar.
 */
export function decidirAcesso(entrada: EntradaDeAcesso): EstadoDeAcesso {
  const { cobrancaLigada, liberadoAte, situacao, carenciaAte, agora } = entrada;

  // 1. A instalação não vende. Retorno mais cedo de todos: para toda instalação
  //    que apenas atualizou, o gate nem olha assinatura.
  if (!cobrancaLigada) {
    return {
      liberado: true,
      motivo: "cobranca_desligada",
      expiraEm: null,
      diasRestantes: null,
      naoMedido: false,
    };
  }

  // 2. Cortesia não tem prazo a discutir. Vem ANTES da checagem de data porque é
  //    uma decisão humana explícita, e ela vence o relógio: quem liberou à mão
  //    sabia o que estava fazendo.
  if (situacao === "cortesia") {
    return {
      liberado: true,
      motivo: "cortesia",
      expiraEm: liberadoAte,
      diasRestantes: liberadoAte ? diasAte(liberadoAte, agora) : null,
      naoMedido: false,
    };
  }

  // 3. Sem prazo. Organização anterior à cobrança, ou marcada para nunca vencer.
  if (liberadoAte === null) {
    return {
      liberado: true,
      motivo: "sem_prazo",
      expiraEm: null,
      diasRestantes: null,
      naoMedido: false,
    };
  }

  const dentroDoPrazo = agora.getTime() < liberadoAte.getTime();

  // 4. Dentro do prazo. Sem linha de assinatura é TESTE; com linha é assinatura
  //    em dia. Os dois liberam, e a distinção existe porque a tela diz frases
  //    diferentes ("faltam 5 dias de teste" vs nada).
  if (dentroDoPrazo && situacao !== "cancelada" && situacao !== "expirada") {
    return {
      liberado: true,
      motivo: situacao === null ? "em_teste" : "assinatura_ativa",
      expiraEm: liberadoAte,
      diasRestantes: diasAte(liberadoAte, agora),
      naoMedido: false,
    };
  }

  // 5. Pagamento falhou e a carência não acabou. Cartão recusado por limite se
  //    resolve em dias; cortar no primeiro `payment_failed` derruba cliente bom.
  if (
    situacao === "inadimplente" &&
    carenciaAte !== null &&
    agora.getTime() < carenciaAte.getTime()
  ) {
    return {
      liberado: true,
      motivo: "em_carencia",
      expiraEm: carenciaAte,
      diasRestantes: diasAte(carenciaAte, agora),
      naoMedido: false,
    };
  }

  // 6. Daqui para baixo tranca. O motivo é o que decide a tela e a frase, então
  //    ele nomeia quem sobrou — nunca um "vencido" genérico.
  const motivo: MotivoDoAcesso =
    situacao === null
      ? "teste_vencido"
      : situacao === "cancelada"
        ? "cancelada"
        : situacao === "inadimplente"
          ? "inadimplente"
          : "assinatura_vencida";

  return {
    liberado: false,
    motivo,
    expiraEm: liberadoAte,
    diasRestantes: 0,
    naoMedido: false,
  };
}

/**
 * A organização está perto de perder acesso?
 *
 * Serve à faixa de aviso e ao cron que avisa — não ao gate. Separada de
 * `decidirAcesso` de propósito: misturar "está liberado?" com "devo avisar?" num
 * retorno só foi como a tela do orçamento passou a mostrar cinco coisas que não
 * eram verdade (`lib/agent-engine/edge/llm/orcamento.ts`, e o cabeçalho de
 * `components/ai/BudgetCard.tsx:5-32`).
 */
export function precisaAvisar(
  estado: EstadoDeAcesso,
  limiteDeDias = 3,
): boolean {
  if (!estado.liberado || estado.naoMedido) return false;
  if (estado.motivo === "cobranca_desligada" || estado.motivo === "sem_prazo") {
    return false;
  }
  return estado.diasRestantes !== null && estado.diasRestantes <= limiteDeDias;
}
