/**
 * O QUE A LP PODE DIZER SOBRE A OFERTA — LIDO DO BANCO, E SÓ O QUE É PÚBLICO.
 *
 * A vitrine de preços da LP não é texto: é a leitura dos planos que o dono publicou
 * em `/admin/planos`. Mudou o preço lá, mudou aqui — e um preço na LP diferente do
 * que o checkout cobra é o pior tipo de divergência, porque o cliente a descobre
 * pagando.
 *
 * ═══ POR QUE ESTA LEITURA USA O CLIENTE ADMIN NUMA ROTA PÚBLICA ═══
 *
 * `planos`, `plano_precos` e `plano_capacidades` são tabelas da INSTALAÇÃO, sem
 * `organization_id`, com RLS ligada e zero policies (migration 0393): nenhum papel
 * do PostgREST as lê. A LP é anônima, então só o servidor alcança. O que sai daqui
 * é uma projeção fechada — nome, descrição, preço, rótulos e tetos — e nada de
 * `id`, `stripe_price_id`, `updated_by` ou linha de rascunho.
 *
 * ═══ O TESTE GRÁTIS SÓ É PROMETIDO QUANDO EXISTE ═══
 *
 * O teste nasce por gatilho e só com `COBRANCA_LIGADA = ligado` (0393). Com a
 * cobrança desligada, quem se cadastra usa tudo, sem prazo e sem fim — e a LP
 * anunciar "7 dias grátis" seria prometer uma regra que o produto não aplica.
 * `testeGratisDias` é `null` nesse caso, e a página troca a promessa por uma
 * frase que continua verdadeira. Também é `null` com `cadastro === "so_convite"`:
 * quem entra por convite cai numa empresa que já existe, e não há teste para
 * oferecer a um visitante que a LP nem deixa se cadastrar.
 *
 * ═══ O CADASTRO SÓ É OFERECIDO QUANDO EXISTE ═══
 *
 * `/signup` obedece ao modo de cadastro da instalação (`lib/auth/politica-de-
 * cadastro.ts`): com `so_convite` ele recusa quem chega sem convite. Uma LP que
 * sempre mostrasse "Criar minha conta" estaria oferecendo um cadastro que a
 * própria porta de entrada nega — daí `cadastro` viajar na oferta, e as seções
 * decidirem o botão a partir dele.
 *
 * Nunca lança: banco fora do ar devolve a oferta vazia, e a LP renderiza sem a
 * seção de planos. A porta de entrada de um negócio não pode dar 500 por causa da
 * vitrine.
 */
import { PORTA_DA_CAPACIDADE, CAPACIDADES_DE_PLANO } from "@/lib/planos/capacidades";
import { lerConfigDeCobranca } from "@/lib/planos/config";
import { LIMITES_DE_PLANO, tetoPorExtenso } from "@/lib/planos/limites";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { modoDeCadastro, type ModoDeCadastro } from "@/lib/auth/politica-de-cadastro";

export interface PlanoDaLp {
  nome: string;
  descricao: string | null;
  liberaTudo: boolean;
  /** Preço vigente por intervalo, em centavos. Ausente = não se vende naquele intervalo. */
  precos: { mensal?: { valorCents: number; moeda: string }; anual?: { valorCents: number; moeda: string } };
  /** Rótulos do que o plano inclui. Vazio quando `liberaTudo`. */
  inclui: string[];
  /** "5 usuários", "1000 contatos". Só os tetos que o plano tem. */
  tetos: string[];
}

export interface OfertaDaLp {
  planos: PlanoDaLp[];
  /** `null` = não há teste grátis (cobrança desligada, ou cadastro "so_convite"). Nunca invente um número. */
  testeGratisDias: number | null;
  /** O que `/signup` aceita agora. Decide se — e qual — botão de cadastro a LP mostra. */
  cadastro: ModoDeCadastro;
}

/** A oferta vazia de uma falha na leitura dos planos: o modo de cadastro sobrevive a ela. */
function vazia(cadastro: ModoDeCadastro): OfertaDaLp {
  return { planos: [], testeGratisDias: null, cadastro };
}

let memo: { ate: number; valor: OfertaDaLp } | null = null;
/** Um minuto: a LP recebe tráfego anônimo (inclusive robôs), e o preço não muda por segundo. */
const TTL_MS = 60_000;

export async function lerOfertaDaLp(agora: number = Date.now()): Promise<OfertaDaLp> {
  if (memo && memo.ate > agora) return memo.valor;

  let cadastro: ModoDeCadastro;
  try {
    cadastro = await modoDeCadastro();
  } catch (erro) {
    logger.warn("lp: não foi possível ler o modo de cadastro — a LP segue como se fosse 'aberto'", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    cadastro = "aberto";
  }

  try {
    const db = createAdminClient();
    const [config, planosRes] = await Promise.all([
      lerConfigDeCobranca(db),
      db
        .from("planos")
        .select(
          "id, nome, descricao, libera_tudo, " +
            "plano_capacidades(capacidade), plano_limites(limite, valor), " +
            "plano_precos(intervalo, valor_cents, moeda, arquivado_em)",
        )
        .not("publicado_em", "is", null)
        .is("arquivado_em", null)
        .order("ordem", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);

    if (planosRes.error) {
      logger.warn("lp: leitura dos planos falhou — a LP segue sem a vitrine", { detalhe: planosRes.error.message });
      return vazia(cadastro);
    }

    const linhas = (planosRes.data ?? []) as unknown as Array<{
      nome: string;
      descricao: string | null;
      libera_tudo: boolean;
      plano_capacidades: Array<{ capacidade: string }>;
      plano_limites: Array<{ limite: string; valor: number | string }>;
      plano_precos: Array<{ intervalo: "mensal" | "anual"; valor_cents: number | string; moeda: string; arquivado_em: string | null }>;
    }>;

    const planos: PlanoDaLp[] = linhas
      // Plano sem preço vigente não é vendável: mostrá-lo com "R$ —" prometeria o que o
      // checkout recusa (`preco_indisponivel`).
      .filter((p) => p.plano_precos.some((x) => x.arquivado_em === null))
      .map((p) => {
        const precos: PlanoDaLp["precos"] = {};
        for (const x of p.plano_precos) {
          if (x.arquivado_em === null) precos[x.intervalo] = { valorCents: Number(x.valor_cents), moeda: x.moeda };
        }
        const doPlano = new Set(p.plano_capacidades.map((c) => c.capacidade));
        return {
          nome: p.nome,
          descricao: p.descricao,
          liberaTudo: p.libera_tudo,
          precos,
          inclui: p.libera_tudo
            ? []
            : CAPACIDADES_DE_PLANO.filter((c) => doPlano.has(c)).map((c) => PORTA_DA_CAPACIDADE[c].rotulo),
          tetos: p.libera_tudo
            ? []
            : LIMITES_DE_PLANO.flatMap((l) => {
                const linha = p.plano_limites.find((x) => x.limite === l);
                return linha ? [tetoPorExtenso(l, Number(linha.valor))] : [];
              }),
        };
      });

    const valor: OfertaDaLp = {
      planos,
      testeGratisDias: config.ligada && cadastro !== "so_convite" ? config.diasDeTeste : null,
      cadastro,
    };
    memo = { ate: agora + TTL_MS, valor };
    return valor;
  } catch (erro) {
    logger.warn("lp: não foi possível ler a oferta — a LP segue sem a vitrine", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return vazia(cadastro);
  }
}

/** Só para teste: zera o memo de processo. */
export function esquecerOfertaDaLp(): void {
  memo = null;
}
