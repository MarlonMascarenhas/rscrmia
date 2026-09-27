/**
 * A CONFIGURAÇÃO DA COBRANÇA DA INSTALAÇÃO — O QUE O DONO LIGA E AJUSTA PELA TELA.
 *
 * Quatro chaves em `platform_config` (0393): `COBRANCA_LIGADA`, `DIAS_DE_TESTE`,
 * `CARENCIA_DIAS` e `LIMITES_MODO`. Nenhuma é segredo, e nenhuma vive no catálogo de
 * credenciais: cada uma tem uma REGRA de validação que o catálogo genérico não sabe
 * (a escada do modo, o teto de dias), e é por isso que têm tela e rota próprias.
 *
 * ═══ LIGAR A COBRANÇA É UMA DECISÃO, E A TELA MOSTRA O PREÇO ANTES ═══
 *
 * O valor fica inerte até alguém declarar a intenção — a lição de `orcamento.ts:5-16`.
 * E declarar a intenção às cegas é o erro caro: `contarOrganizacoesVencidas` diz,
 * ANTES do clique, quantas organizações já estão com o prazo no passado e seriam
 * trancadas agora. Zero é o caso comum (organizações anteriores à cobrança não têm
 * prazo); não zero é alguém a quem o dono deve avisar antes.
 *
 * ═══ O MODO DOS TETOS É UMA ESCADA ═══
 *
 * `off` → `avisar` → `bloquear`, um degrau por vez, e descer é sempre livre. Pular
 * de `off` direto a `bloquear` é o que transformaria "acabei de ligar os limites"
 * em "metade dos clientes recusados no primeiro clique" — o mesmo defeito que a
 * carência de 72h de `ai_budgets` existe para impedir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ModoDeLimite } from "@/lib/planos/limites";

export interface ConfigDeCobranca {
  ligada: boolean;
  diasDeTeste: number;
  carenciaDias: number;
  modoDeLimite: ModoDeLimite;
}

export const PADRAO_DA_COBRANCA: ConfigDeCobranca = {
  ligada: false,
  diasDeTeste: 14,
  carenciaDias: 5,
  modoDeLimite: "avisar",
};

const inteiro = (v: string | null | undefined, min: number, max: number, padrao: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
};

/** Nunca lança: erro de leitura devolve o padrão (que é DESLIGADO). */
export async function lerConfigDeCobranca(db: SupabaseClient): Promise<ConfigDeCobranca> {
  try {
    const { data, error } = await db
      .from("platform_config")
      .select("chave, valor")
      .in("chave", ["COBRANCA_LIGADA", "DIAS_DE_TESTE", "CARENCIA_DIAS", "LIMITES_MODO"]);
    if (error) return PADRAO_DA_COBRANCA;
    const v = (c: string) => (data as Array<{ chave: string; valor: string | null }>).find((l) => l.chave === c)?.valor;
    const modo = v("LIMITES_MODO");
    return {
      ligada: v("COBRANCA_LIGADA") === "ligado",
      diasDeTeste: inteiro(v("DIAS_DE_TESTE"), 1, 365, PADRAO_DA_COBRANCA.diasDeTeste),
      carenciaDias: inteiro(v("CARENCIA_DIAS"), 0, 90, PADRAO_DA_COBRANCA.carenciaDias),
      modoDeLimite: modo === "off" || modo === "avisar" || modo === "bloquear" ? modo : PADRAO_DA_COBRANCA.modoDeLimite,
    };
  } catch {
    return PADRAO_DA_COBRANCA;
  }
}

/**
 * Quantas organizações ativas já estão com o prazo no passado — as que seriam
 * trancadas no instante em que a cobrança fosse ligada.
 *
 * É um LIMITE SUPERIOR: uma organização em `cortesia` com prazo antigo também conta e
 * NÃO seria trancada (a cortesia vence o relógio). Melhor o dono ver um número que
 * pode ser maior que o real do que menor — o erro para o outro lado é uma surpresa.
 * `null` = não medido, e a tela diz que não mediu.
 */
export async function contarOrganizacoesVencidas(db: SupabaseClient, agora: Date = new Date()): Promise<number | null> {
  try {
    const { count, error } = await db
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .not("acesso_liberado_ate", "is", null)
      .lt("acesso_liberado_ate", agora.toISOString());
    return error ? null : count;
  } catch {
    return null;
  }
}

/**
 * A escada do modo dos tetos. Descer é sempre livre; subir é um degrau por vez.
 * Devolve `null` quando a transição vale, ou o motivo em português quando não.
 */
export function validarTransicaoDeModo(atual: ModoDeLimite, novo: ModoDeLimite): string | null {
  if (atual === novo) return null;
  const degrau: Record<ModoDeLimite, number> = { off: 0, avisar: 1, bloquear: 2 };
  if (degrau[novo] < degrau[atual]) return null;
  if (degrau[novo] - degrau[atual] > 1) {
    return "Suba um degrau por vez: primeiro avisar, e só depois bloquear. Assim ninguém é recusado sem ter sido avisado.";
  }
  return null;
}

export type PatchDaCobranca = Partial<ConfigDeCobranca>;

/** As linhas de `platform_config` que um patch produz. Só o que veio no patch. */
export function linhasDoPatch(patch: PatchDaCobranca): Array<{ chave: string; valor: string }> {
  const linhas: Array<{ chave: string; valor: string }> = [];
  if (patch.ligada !== undefined) linhas.push({ chave: "COBRANCA_LIGADA", valor: patch.ligada ? "ligado" : "desligado" });
  if (patch.diasDeTeste !== undefined) linhas.push({ chave: "DIAS_DE_TESTE", valor: String(patch.diasDeTeste) });
  if (patch.carenciaDias !== undefined) linhas.push({ chave: "CARENCIA_DIAS", valor: String(patch.carenciaDias) });
  if (patch.modoDeLimite !== undefined) linhas.push({ chave: "LIMITES_MODO", valor: patch.modoDeLimite });
  return linhas;
}
