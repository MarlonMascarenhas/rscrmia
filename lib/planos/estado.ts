/**
 * O ESTADO DE COBRANÇA DE UMA ORGANIZAÇÃO, LIDO DO BANCO.
 *
 * Este é o único módulo de `lib/planos/` que toca I/O. A decisão continua pura
 * em `decisao.ts`, `capacidades.ts` e `limites.ts` — aqui só se BUSCA o que elas
 * precisam, e o resultado é passado para elas.
 *
 * ═══ NUNCA LANÇA, E O SILÊNCIO É PROIBIDO ═══
 *
 * Leitura recusada devolve `estadoIndeterminado()`, que **libera** e carrega
 * `naoMedido: true`. Isso NÃO é tolerância a defeito — é a escolha de lado
 * argumentada em `decisao.ts`, e ela vem acompanhada de `logger.error`, porque um
 * gate que falha aberto calado é um interruptor invisível: um defeito no caminho
 * de leitura viraria produto grátis para sempre, com a suíte toda verde.
 *
 * ═══ POR QUE `cobrancaLigada` É LIDO AQUI, E NÃO NO CHAMADOR ═══
 *
 * Porque esquecê-lo é o defeito mais caro possível: sem ele, uma instalação que
 * nunca quis vender começa a trancar organizações. Lendo-o dentro do resolvedor,
 * nenhum chamador consegue montar um estado sem ele.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  decidirAcesso,
  estadoDeAcessoIndeterminado,
  type EstadoDeAcesso,
  type SituacaoDeAssinatura,
} from "@/lib/planos/decisao";
import { logger } from "@/lib/logger";
import type { ModoDeLimite } from "@/lib/planos/limites";

/** A chave da instalação. Só o valor `ligado` liga — régua de `modulos.ts:23-29`. */
export const CHAVE_COBRANCA_LIGADA = "COBRANCA_LIGADA";
export const CHAVE_DIAS_DE_TESTE = "DIAS_DE_TESTE";
export const CHAVE_CARENCIA_DIAS = "CARENCIA_DIAS";
/** `off` | `avisar` | `bloquear`. Nasce `avisar`: ninguém é bloqueado sem ter sido avisado. */
export const CHAVE_LIMITES_MODO = "LIMITES_MODO";
const MODO_PADRAO: ModoDeLimite = "avisar";
const LIGADO = "ligado";

export interface EstadoDeCobranca {
  acesso: EstadoDeAcesso;
  /** `null` = sem plano contratado (teste, ou liberação manual sem plano). */
  planoId: string | null;
  /** O plano libera toda capacidade, inclusive as que nascerem depois. */
  liberaTudo: boolean;
  /** Capacidades do plano, strings cruas (o banco é vocabulário aberto). */
  capacidades: readonly string[];
  /** Tetos do plano. Chave ausente = sem teto. */
  limites: Readonly<Record<string, number>>;
  cobrancaLigada: boolean;
  /** O que a instalação faz quando um teto é atingido. Vale para todos os planos. */
  modoDeLimite: ModoDeLimite;
}

/**
 * A cobrança está ligada nesta instalação?
 *
 * Nunca lança. Erro de banco devolve `false` — falha fechada para o MECANISMO e,
 * por consequência, aberta para o usuário: ninguém é trancado por um soluço de
 * leitura, que é o lado certo de errar aqui.
 */
export async function cobrancaLigada(db: SupabaseClient): Promise<boolean> {
  return (await lerChavesDaInstalacao(db)).ligada;
}

/**
 * As duas chaves da instalação que decidem o comportamento, numa consulta só.
 *
 * Nunca lança. Erro de banco devolve `ligada: false` — falha fechada para o
 * MECANISMO e, por consequência, aberta para o usuário: ninguém é trancado por um
 * soluço de leitura. E o modo cai em `avisar`, o mais brando que ainda deixa
 * rastro: nunca em `bloquear` por não ter conseguido ler.
 */
export async function lerChavesDaInstalacao(
  db: SupabaseClient,
): Promise<{ ligada: boolean; modo: ModoDeLimite }> {
  try {
    const { data, error } = await db
      .from("platform_config")
      .select("chave, valor")
      .in("chave", [CHAVE_COBRANCA_LIGADA, CHAVE_LIMITES_MODO]);
    if (error) {
      logger.warn("cobrança: leitura das chaves da instalação recusada — tratando como desligada", {
        codigo: error.code,
        detalhe: error.message,
      });
      return { ligada: false, modo: MODO_PADRAO };
    }
    const linhas = (data ?? []) as Array<{ chave: string; valor: string | null }>;
    const valorDe = (c: string) => linhas.find((l) => l.chave === c)?.valor ?? null;
    const bruto = valorDe(CHAVE_LIMITES_MODO);
    const modo: ModoDeLimite =
      bruto === "off" || bruto === "avisar" || bruto === "bloquear" ? bruto : MODO_PADRAO;
    return { ligada: valorDe(CHAVE_COBRANCA_LIGADA) === LIGADO, modo };
  } catch (erro) {
    logger.warn("cobrança: leitura das chaves da instalação falhou — tratando como desligada", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return { ligada: false, modo: MODO_PADRAO };
  }
}

/**
 * O estado indeterminado completo: libera, e diz que não mediu.
 *
 * Exportada para que `pedido.ts` devolva EXATAMENTE a mesma coisa quando nem o
 * cliente pôde ser obtido — dois "não sei" diferentes fariam quem chama tratar
 * um deles como medido.
 */
export function estadoDeCobrancaIndeterminado(cobranca = false): EstadoDeCobranca {
  return estadoIndeterminado(cobranca);
}

function estadoIndeterminado(cobranca: boolean): EstadoDeCobranca {
  return {
    acesso: estadoDeAcessoIndeterminado(),
    planoId: null,
    // `false`, e não `true`: capacidade falha FECHADO (o raio é uma feature, não
    // o produto), e quem pergunta por capacidade recebe 503 pela guarda, não uma
    // liberação silenciosa. A assimetria está argumentada em `decisao.ts`.
    liberaTudo: false,
    capacidades: [],
    limites: {},
    cobrancaLigada: cobranca,
    modoDeLimite: MODO_PADRAO,
  };
}

interface LinhaDeAcesso {
  acesso_liberado_ate: string | null;
  plano_id: string | null;
}

/**
 * Resolve o estado inteiro numa organização.
 *
 * Três consultas em paralelo, e a primeira decide: com a cobrança desligada, as
 * outras duas nem são feitas — o caminho comum de toda instalação que só
 * atualizou o produto custa UMA leitura de chave, que é memoizável pelo chamador.
 */
export async function lerEstadoDeCobranca(
  db: SupabaseClient,
  organizationId: string,
  agora: Date = new Date(),
): Promise<EstadoDeCobranca> {
  const { ligada, modo } = await lerChavesDaInstalacao(db);

  if (!ligada) {
    // Curto-circuito honesto: a decisão pura já devolve `cobranca_desligada`, e
    // não há por que consultar assinatura de quem não vende.
    return {
      acesso: decidirAcesso({
        cobrancaLigada: false,
        liberadoAte: null,
        situacao: null,
        carenciaAte: null,
        agora,
      }),
      planoId: null,
      liberaTudo: true,
      capacidades: [],
      limites: {},
      cobrancaLigada: false,
      modoDeLimite: modo,
    };
  }

  try {
    const [orgRes, assinRes] = await Promise.all([
      db
        .from("organizations")
        .select("acesso_liberado_ate, plano_id")
        .eq("id", organizationId)
        .maybeSingle(),
      db
        .from("assinaturas")
        .select("situacao, carencia_ate, plano_id")
        .eq("organization_id", organizationId)
        .maybeSingle(),
    ]);

    if (orgRes.error) {
      logger.error("cobrança: leitura do prazo da organização recusada — estado NÃO MEDIDO", {
        organization_id: organizationId,
        codigo: orgRes.error.code,
        detalhe: orgRes.error.message,
      });
      return estadoIndeterminado(ligada);
    }
    // A assinatura pode legitimamente não existir (é o teste grátis), mas um
    // ERRO de leitura é outra coisa, e tratá-lo como ausência transformaria um
    // cliente pagante em "nunca assinou" — que tranca quando o teste expira.
    if (assinRes.error) {
      logger.error("cobrança: leitura da assinatura recusada — estado NÃO MEDIDO", {
        organization_id: organizationId,
        codigo: assinRes.error.code,
        detalhe: assinRes.error.message,
      });
      return estadoIndeterminado(ligada);
    }

    const org = orgRes.data as LinhaDeAcesso | null;
    const assin = assinRes.data as {
      situacao: string | null;
      carencia_ate: string | null;
      plano_id: string | null;
    } | null;

    const planoId = assin?.plano_id ?? org?.plano_id ?? null;

    const acesso = decidirAcesso({
      cobrancaLigada: true,
      liberadoAte: org?.acesso_liberado_ate ? new Date(org.acesso_liberado_ate) : null,
      situacao: (assin?.situacao as SituacaoDeAssinatura | null) ?? null,
      carenciaAte: assin?.carencia_ate ? new Date(assin.carencia_ate) : null,
      agora,
    });

    if (!planoId) {
      // SEM PLANO ESCOLHIDO = O PRODUTO INTEIRO, SEM TETO.
      //
      // Quem está em teste grátis (ou recebeu uma liberação manual sem plano) não
      // tem plano, e é justamente quem mais precisa experimentar tudo: dar-lhe
      // "nenhuma capacidade" faria o teste mostrar um produto capado, e a pessoa
      // decidiria o que comprar sem ter visto o que compraria. Ninguém pode ser
      // recusado por um plano que ainda não escolheu.
      //
      // O aperto vem DEPOIS, ao assinar um plano — e é nesse momento que a
      // capacidade e o teto passam a valer. Antes disso `acesso` já cuida de quem
      // venceu; capacidade é só sobre o que o plano contratado inclui.
      return {
        acesso,
        planoId: null,
        liberaTudo: true,
        capacidades: [],
        limites: {},
        cobrancaLigada: true,
        modoDeLimite: modo,
      };
    }

    const [planoRes, capRes, limRes] = await Promise.all([
      db.from("planos").select("libera_tudo").eq("id", planoId).maybeSingle(),
      db.from("plano_capacidades").select("capacidade").eq("plano_id", planoId),
      db.from("plano_limites").select("limite, valor").eq("plano_id", planoId),
    ]);

    if (planoRes.error || capRes.error || limRes.error) {
      const e = planoRes.error ?? capRes.error ?? limRes.error;
      logger.error("cobrança: leitura do plano recusada — estado NÃO MEDIDO", {
        organization_id: organizationId,
        plano_id: planoId,
        codigo: e?.code,
        detalhe: e?.message,
      });
      // O ACESSO foi medido; o PLANO não. Devolve o acesso verdadeiro e zera o
      // plano — trancar quem pagou por não saber as capacidades seria o pior dos
      // dois erros.
      return { ...estadoIndeterminado(ligada), acesso, modoDeLimite: modo };
    }

    const limites: Record<string, number> = {};
    for (const l of (limRes.data ?? []) as Array<{ limite: string; valor: number }>) {
      limites[l.limite] = Number(l.valor);
    }

    return {
      acesso,
      planoId,
      liberaTudo: (planoRes.data as { libera_tudo: boolean } | null)?.libera_tudo ?? false,
      capacidades: ((capRes.data ?? []) as Array<{ capacidade: string }>).map(
        (c) => c.capacidade,
      ),
      limites,
      cobrancaLigada: true,
      modoDeLimite: modo,
    };
  } catch (erro) {
    logger.error("cobrança: resolução do estado falhou — estado NÃO MEDIDO", {
      organization_id: organizationId,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return estadoIndeterminado(ligada);
  }
}
