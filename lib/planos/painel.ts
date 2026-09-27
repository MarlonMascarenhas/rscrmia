/**
 * TUDO O QUE A TELA DE COBRANÇA DO CLIENTE MOSTRA, MONTADO NUM LUGAR SÓ.
 *
 * A tela mostra o estado que o GATE enxerga (`lerEstadoDeCobranca`), e não uma
 * releitura das tabelas: duas leituras do mesmo fato é como a tela diz "ativa"
 * enquanto a rota responde 402. O uso vem de `medirUso`, a MESMA régua que a guarda
 * de limite executa — a tela dizendo "80 de 100" enquanto a rota recusa no 90 é o
 * defeito do cabeçalho de `orcamento.ts`.
 *
 * Nunca lança: o que não se conseguiu medir sai `null`, e a tela diz que não mediu
 * em vez de mostrar zero.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CAPACIDADES_DE_PLANO, PORTA_DA_CAPACIDADE, planoLibera } from "@/lib/planos/capacidades";
import { lerEstadoDeCobranca, type EstadoDeCobranca } from "@/lib/planos/estado";
import { FORMA_DO_LIMITE, LIMITES_DE_PLANO, type LimiteDePlano } from "@/lib/planos/limites";
import { medirUso } from "@/lib/planos/uso";

export interface PlanoDaVitrine {
  id: string;
  nome: string;
  descricao: string | null;
  liberaTudo: boolean;
  /** Preço vigente por intervalo, em centavos. Ausente = não se vende naquele intervalo. */
  precos: Partial<Record<"mensal" | "anual", { valorCents: number; moeda: string }>>;
  atual: boolean;
}

export interface LinhaDeUso {
  limite: LimiteDePlano;
  rotulo: string;
  teto: number;
  /** `null` = não medido. Nunca `0`. */
  uso: number | null;
}

export interface PainelDoCliente {
  estado: EstadoDeCobranca;
  situacao: string | null;
  planoAtual: { id: string; nome: string } | null;
  vitrine: PlanoDaVitrine[];
  uso: LinhaDeUso[];
  /** O que o plano inclui, para a tela listar. Vazio quando libera tudo. */
  incluidas: string[];
  temAssinaturaNoProvedor: boolean;
}

export async function lerPainelDoCliente(db: SupabaseClient, organizationId: string): Promise<PainelDoCliente> {
  const [estado, assinRes, planosRes] = await Promise.all([
    lerEstadoDeCobranca(db, organizationId),
    db
      .from("assinaturas")
      .select("situacao, plano_id, stripe_subscription_id")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    db
      .from("planos")
      .select("id, nome, descricao, libera_tudo, plano_precos(intervalo, valor_cents, moeda, arquivado_em)")
      .not("publicado_em", "is", null)
      .is("arquivado_em", null)
      .order("ordem", { ascending: true }),
  ]);

  const assin = assinRes.data as { situacao: string; plano_id: string | null; stripe_subscription_id: string | null } | null;
  const planoAtualId = estado.planoId ?? assin?.plano_id ?? null;

  const linhas = (planosRes.data ?? []) as unknown as Array<{
    id: string; nome: string; descricao: string | null; libera_tudo: boolean;
    plano_precos: Array<{ intervalo: "mensal" | "anual"; valor_cents: number; moeda: string; arquivado_em: string | null }>;
  }>;

  const vitrine: PlanoDaVitrine[] = linhas.map((p) => {
    const precos: PlanoDaVitrine["precos"] = {};
    for (const x of p.plano_precos) {
      if (x.arquivado_em === null) precos[x.intervalo] = { valorCents: Number(x.valor_cents), moeda: x.moeda };
    }
    return { id: p.id, nome: p.nome, descricao: p.descricao, liberaTudo: p.libera_tudo, precos, atual: p.id === planoAtualId };
  });

  // O plano ATUAL pode estar arquivado (quem já o tem continua com ele) e por isso
  // fora da vitrine: o nome vem de uma consulta própria.
  let planoAtual: PainelDoCliente["planoAtual"] = null;
  if (planoAtualId) {
    const naVitrine = vitrine.find((v) => v.id === planoAtualId);
    if (naVitrine) planoAtual = { id: naVitrine.id, nome: naVitrine.nome };
    else {
      const { data } = await db.from("planos").select("id, nome").eq("id", planoAtualId).maybeSingle();
      if (data) planoAtual = data as { id: string; nome: string };
    }
  }

  // Uso: só os limites que o plano TEM. Medir os outros seria consulta à toa.
  const uso: LinhaDeUso[] = estado.cobrancaLigada && !estado.liberaTudo
    ? await Promise.all(
        LIMITES_DE_PLANO.filter((l) => estado.limites[l] !== undefined).map(async (limite) => ({
          limite,
          rotulo: FORMA_DO_LIMITE[limite].rotulo,
          teto: estado.limites[limite]!,
          uso: await medirUso(db, organizationId, limite),
        })),
      )
    : [];

  const incluidas =
    estado.cobrancaLigada && !estado.liberaTudo
      ? CAPACIDADES_DE_PLANO.filter((c) =>
          planoLibera(c, { cobrancaLigada: true, liberaTudo: false, capacidades: estado.capacidades }),
        ).map((c) => PORTA_DA_CAPACIDADE[c].rotulo)
      : [];

  return {
    estado,
    situacao: assin?.situacao ?? null,
    planoAtual,
    vitrine,
    uso,
    incluidas,
    temAssinaturaNoProvedor: !!assin?.stripe_subscription_id,
  };
}
