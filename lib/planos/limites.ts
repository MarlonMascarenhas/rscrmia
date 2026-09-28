/**
 * OS TETOS NUMÉRICOS DE UM PLANO — LISTA FECHADA, E A DECISÃO PURA.
 *
 * ═══ AUSÊNCIA DE TETO É "SEM TETO" (E A ASSIMETRIA COM CAPACIDADE É DE PROPÓSITO) ═══
 *
 * Em `plano_capacidades`, ausência de linha = NÃO liberado. Aqui, ausência de
 * linha = SEM LIMITE. Parece incoerente e não é: capacidade é uma CONCESSÃO
 * (sem concessão, não tem), e limite é uma RESTRIÇÃO (sem restrição, não há
 * teto). As duas leituras dizem a mesma coisa — "o que não foi declarado não
 * restringe nem concede".
 *
 * Foi escolhido contra um `ilimitado boolean` com XOR porque um teto ausente já
 * é a forma mais simples de dizer "sem teto"; a coluna extra criaria um segundo
 * jeito de dizer a mesma coisa, e é assim que dois leitores discordam.
 *
 * ═══ LIMITE FALHA ABERTO, E O ARGUMENTO É EMPRESTADO INTEIRO ═══
 *
 * `lib/agent-engine/edge/llm/orcamento.ts:24-28`, sem desconto: "errar frouxo
 * custa dinheiro de provedor, é visível na tela e é recuperável; errar duro mata
 * o WhatsApp de um negócio numa VPS onde não há para quem ligar, e a descoberta
 * vem pelo cliente dele". Um teto de mensagens/mês que bloqueia por engano causa
 * o mesmo dano — então uso que não pôde ser medido NÃO bloqueia.
 *
 * ═══ NINGUÉM É BLOQUEADO SEM TER SIDO AVISADO ═══
 *
 * `modo` nasce `avisar` e não `bloquear`, e a subida é um degrau por vez, pela
 * razão escrita no cabeçalho de `orcamento.ts:5-16`: a tela editava um campo e o
 * enforcement lia outro, e "quem preenchia a tela acreditava estar protegido e
 * não estava". Aqui o risco é o espelho — quem contratou um plano com teto
 * acreditaria estar protegido de estourar, e o estouro chegaria como uma parede.
 *
 * O vocabulário é espelhado no CHECK de `plano_limites` (migration 0393), e
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` reprova divergência.
 */

export const LIMITES_DE_PLANO = [
  "usuarios",
  "conexoes",
  "contatos",
  "mensagens_por_mes",
  "campanhas_por_mes",
  "tokens_de_api",
  "agentes",
] as const;

export type LimiteDePlano = (typeof LIMITES_DE_PLANO)[number];

interface FormaDoLimite {
  /** O que quem administra a instalação lê em /admin/planos. */
  readonly rotulo: string;
  /** Como o número é lido por um humano. Entra na frase da recusa. */
  readonly unidade: string;
  /** A mesma unidade para UM ("1 usuário", nunca "1 usuários"). */
  readonly unidadeNoSingular: string;
  /**
   * De onde o uso ATUAL é medido. Texto, não função: a medição mora na guarda
   * (que tem banco), e este campo existe para que a tela diga a régua e para que
   * um limite novo sem medidor seja visível na revisão — um teto que ninguém
   * mede é um teto que não existe, e é pior que nenhum, porque a tela promete.
   */
  readonly medidor: string;
  /** `true` quando o teto se renova a cada mês. Decide a frase e o medidor. */
  readonly mensal: boolean;
}

/**
 * O teto como um cliente o lê: "1 usuário", "5 usuários", "1000 mensagens por mês".
 * Sem o "por mês", um teto mensal pareceria um total para sempre.
 */
export function tetoPorExtenso(limite: LimiteDePlano, valor: number): string {
  const forma = FORMA_DO_LIMITE[limite];
  const unidade = valor === 1 ? forma.unidadeNoSingular : forma.unidade;
  return `${valor} ${unidade}${forma.mensal ? " por mês" : ""}`;
}

/** `Record` exaustivo: limite sem forma declarada não compila. */
export const FORMA_DO_LIMITE: Record<LimiteDePlano, FormaDoLimite> = {
  usuarios: {
    rotulo: "Usuários",
    unidade: "usuários",
    unidadeNoSingular: "usuário",
    medidor: "user_organizations ativos (revoked_at is null)",
    mensal: false,
  },
  conexoes: {
    rotulo: "Conexões de WhatsApp",
    unidade: "conexões",
    unidadeNoSingular: "conexão",
    medidor: "channel_sessions não arquivadas",
    mensal: false,
  },
  contatos: {
    rotulo: "Contatos",
    unidade: "contatos",
    unidadeNoSingular: "contato",
    medidor: "contacts não anonimizados",
    mensal: false,
  },
  mensagens_por_mes: {
    rotulo: "Mensagens enviadas por mês",
    unidade: "mensagens",
    unidadeNoSingular: "mensagem",
    // A régua já existe e é a única que conta envio de verdade.
    medidor: "pacing_ledger do mês corrente",
    mensal: true,
  },
  campanhas_por_mes: {
    rotulo: "Campanhas por mês",
    unidade: "campanhas",
    unidadeNoSingular: "campanha",
    medidor: "campaigns criadas no mês corrente",
    mensal: true,
  },
  tokens_de_api: {
    rotulo: "Tokens de API",
    unidade: "tokens",
    unidadeNoSingular: "token",
    medidor: "api_tokens não revogados",
    mensal: false,
  },
  agentes: {
    rotulo: "Agentes de IA",
    unidade: "agentes",
    unidadeNoSingular: "agente",
    medidor: "ai_agents não arquivados",
    mensal: false,
  },
};

export function ehLimiteDePlano(valor: unknown): valor is LimiteDePlano {
  return (
    typeof valor === "string" && (LIMITES_DE_PLANO as readonly string[]).includes(valor)
  );
}

/**
 * O que a instalação faz quando o teto é atingido.
 *
 * Nasce em `avisar`, nunca em `bloquear` — ver o cabeçalho. A escada sobe um
 * degrau por vez, e quem valida isso é a rota que grava (como
 * `app/api/v1/ai/budget/route.ts:153-168` faz para o orçamento).
 */
export type ModoDeLimite = "off" | "avisar" | "bloquear";

export type AcaoDoLimite = "seguir" | "avisar_e_seguir" | "bloquear";

export interface VereditoDeLimite {
  acao: AcaoDoLimite;
  /** Por que esta ação, em vocabulário fechado — é o que vai para o log. */
  porque:
    | "cobranca_desligada"
    | "sem_teto"
    | "modo_off"
    | "dentro_do_teto"
    | "nao_medido"
    | "teto_atingido_avisa"
    | "teto_atingido_bloqueia";
  /** Quanto falta. `null` quando não há teto ou não se mediu. */
  restante: number | null;
  /** O teto que valeu, para a frase da tela. */
  teto: number | null;
}

export interface EntradaDeLimite {
  cobrancaLigada: boolean;
  modo: ModoDeLimite;
  /** `null` = sem teto (nenhuma linha em `plano_limites`). */
  teto: number | null;
  /** `null` = NÃO MEDIDO. Nunca passe `0` para dizer "não sei". */
  uso: number | null;
}

/**
 * A decisão de teto, PURA.
 *
 * Toda ambiguidade resolve para "não bloqueia" — e a diferença entre `uso: null`
 * ("não medi") e `uso: 0` ("medi, e é zero") é o que impede uma consulta que
 * falhou de se disfarçar de organização sem uso. Passar `0` no lugar de `null`
 * é o erro que transformaria um defeito de leitura num teto que nunca dispara,
 * com a tela mostrando "0 de 1000" e o dinheiro saindo — exatamente o furo
 * `gasto_incompleto` que `lib/ai/budget/check.ts:59-76` documenta.
 */
export function decidirLimite(entrada: EntradaDeLimite): VereditoDeLimite {
  const { cobrancaLigada, modo, teto, uso } = entrada;

  if (!cobrancaLigada) {
    return { acao: "seguir", porque: "cobranca_desligada", restante: null, teto: null };
  }
  if (teto === null) {
    return { acao: "seguir", porque: "sem_teto", restante: null, teto: null };
  }
  if (modo === "off") {
    return { acao: "seguir", porque: "modo_off", restante: null, teto };
  }
  if (uso === null) {
    // Não medido nunca bloqueia, e nunca se disfarça de "dentro do teto".
    return { acao: "seguir", porque: "nao_medido", restante: null, teto };
  }

  const restante = teto - uso;
  if (restante > 0) {
    return { acao: "seguir", porque: "dentro_do_teto", restante, teto };
  }

  return modo === "bloquear"
    ? { acao: "bloquear", porque: "teto_atingido_bloqueia", restante: 0, teto }
    : { acao: "avisar_e_seguir", porque: "teto_atingido_avisa", restante: 0, teto };
}
