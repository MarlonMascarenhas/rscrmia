/**
 * O VOCABULÁRIO DO PLANO NÃO DIVERGE DE NENHUM DOS TRÊS LUGARES ONDE MORA.
 *
 * Capacidade e limite vivem em três lugares: as constantes TypeScript (que o gate
 * consome e a tela do /admin oferece), o CHECK da migration e o CHECK do apêndice
 * do baseline (que é o que o `install.sh`/`update.sh` aplicam). Divergência entre
 * eles é o defeito do cabeçalho de `orcamento.ts`: a tela oferece o que o gate não
 * conhece, ou o banco recusa o que a tela ofereceu.
 *
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` cobre o banco real,
 * mas só roda em `pnpm test:db`. Este é o gate ESTÁTICO, que roda em todo
 * `pnpm test:unit` — e é o que pega a divergência no PR, antes de haver banco.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CAPACIDADES_DE_PLANO,
  PORTA_DA_CAPACIDADE,
  destinosOcultosPeloPlano,
  ehCapacidadeDePlano,
  planoLibera,
} from "@/lib/planos/capacidades";
import { FORMA_DO_LIMITE, LIMITES_DE_PLANO, ehLimiteDePlano } from "@/lib/planos/limites";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";

const MIGRATION = readFileSync(
  "supabase/migrations/20260925120000_0393_planos_e_assinaturas.sql",
  "utf8",
);
const BASELINE = readFileSync("supabase/baseline.sql", "utf8");

/** As strings entre aspas simples do CHECK `<constraint> check (<coluna> in (...))`. */
function vocabularioDoCheck(sql: string, constraint: string): string[] {
  // Ancora na ÚLTIMA definição: o baseline é dump + apêndice, e quem vale é a última
  // (CLAUDE.md, migrations item 10 — `grep` no arquivo inteiro mede a errada).
  const i = sql.lastIndexOf(`add constraint ${constraint}`);
  if (i < 0) throw new Error(`constraint ${constraint} não achada`);
  const fim = sql.indexOf(";", i);
  return [...sql.slice(i, fim).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

const ordena = (v: readonly string[]) => [...v].sort();

describe("capacidades: TypeScript = migration = baseline", () => {
  const ts = ordena(CAPACIDADES_DE_PLANO);

  it("a migration tem exatamente as capacidades do TypeScript", () => {
    // A migration declara o CHECK inline no `create table`; extraímos do bloco dele.
    const i = MIGRATION.lastIndexOf("plano_capacidades_vocabulario");
    const bloco = MIGRATION.slice(i, MIGRATION.indexOf(")", MIGRATION.indexOf("in (", i) + 4));
    const doBanco = [...bloco.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(ordena(doBanco)).toEqual(ts);
  });

  it("o apêndice do baseline tem exatamente as capacidades do TypeScript", () => {
    expect(ordena(vocabularioDoCheck(BASELINE, "plano_capacidades_vocabulario"))).toEqual(ts);
  });
});

describe("limites: TypeScript = migration = baseline", () => {
  const ts = ordena(LIMITES_DE_PLANO);

  it("a migration tem exatamente os limites do TypeScript", () => {
    const i = MIGRATION.lastIndexOf("plano_limites_vocabulario");
    const bloco = MIGRATION.slice(i, MIGRATION.indexOf(")", MIGRATION.indexOf("in (", i) + 4));
    expect(ordena([...bloco.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!))).toEqual(ts);
  });

  it("o apêndice do baseline tem exatamente os limites do TypeScript", () => {
    expect(ordena(vocabularioDoCheck(BASELINE, "plano_limites_vocabulario"))).toEqual(ts);
  });

  it("todo limite tem forma declarada, com medidor e unidade", () => {
    for (const l of LIMITES_DE_PLANO) {
      const f = FORMA_DO_LIMITE[l];
      // Um teto que ninguém mede é um teto que não existe — e é pior que nenhum,
      // porque a tela promete. O medidor escrito é o que faz isso ser visível.
      expect(f.medidor.length, `${l}: sem medidor`).toBeGreaterThan(5);
      expect(f.unidade.length, `${l}: sem unidade`).toBeGreaterThan(2);
      expect(f.rotulo.length, `${l}: sem rótulo`).toBeGreaterThan(2);
    }
  });

  it("o gasto de IA NÃO é limite de plano — quem o governa é ai_budgets", () => {
    // Um teto no catálogo que nenhuma rota aplica é a tela prometendo e o
    // enforcement ausente: o defeito que este trabalho todo evita. Se um dia
    // entrar, entra com o enforcement no motor, no mesmo PR.
    expect(ehLimiteDePlano("ia_cents_por_mes")).toBe(false);
  });
});

describe("as portas do menu que o plano governa existem de verdade", () => {
  const hrefs = new Set((NAV_CATALOG as readonly { href: string }[]).map((d) => d.href));

  it.each(CAPACIDADES_DE_PLANO)("%s: todo destino declarado está no NAV_CATALOG", (cap) => {
    for (const d of PORTA_DA_CAPACIDADE[cap].destinos) {
      // Um href de memória que não existe esconde NADA e ninguém percebe: o filtro
      // roda, não acha a porta, e o plano "sem campanhas" segue mostrando Campanhas.
      expect(hrefs.has(d), `${cap} esconde ${d}, que não existe no menu`).toBe(true);
    }
  });

  it("toda capacidade tem rótulo e frase (a frase diz o que fazer, não o que faltou)", () => {
    for (const c of CAPACIDADES_DE_PLANO) {
      expect(PORTA_DA_CAPACIDADE[c].rotulo.length).toBeGreaterThan(3);
      expect(PORTA_DA_CAPACIDADE[c].frase.length).toBeGreaterThan(15);
    }
  });
});

describe("destinosOcultosPeloPlano — esconde só o que o plano não tem", () => {
  const base = { cobrancaLigada: true, liberaTudo: false, capacidades: [] as string[], naoMedido: false };

  it("plano sem nenhuma capacidade esconde as portas de todas", () => {
    const ocultos = destinosOcultosPeloPlano(base);
    expect(ocultos).toContain("/app/campaigns");
    expect(ocultos).toContain("/app/extensions");
    expect(ocultos).toContain("/app/integracao-dados");
  });

  it("uma capacidade no plano devolve a porta dela", () => {
    const ocultos = destinosOcultosPeloPlano({ ...base, capacidades: ["campanhas"] });
    expect(ocultos).not.toContain("/app/campaigns");
    expect(ocultos).toContain("/app/extensions");
  });

  it.each([
    ["cobrança desligada", { ...base, cobrancaLigada: false }],
    ["plano que libera tudo", { ...base, liberaTudo: true }],
    ["estado NÃO MEDIDO — esconder por engano é pior que mostrar demais", { ...base, naoMedido: true }],
  ])("%s: não esconde nada", (_n, estado) => {
    expect(destinosOcultosPeloPlano(estado)).toEqual([]);
  });
});

describe("planoLibera", () => {
  it("libera tudo quando a cobrança está desligada", () => {
    expect(planoLibera("voz", { cobrancaLigada: false, liberaTudo: false, capacidades: [] })).toBe(true);
  });
  it("libera_tudo inclui capacidade que nascer depois", () => {
    expect(planoLibera("campanhas", { cobrancaLigada: true, liberaTudo: true, capacidades: [] })).toBe(true);
  });
  it("sem a capacidade e sem libera_tudo, recusa", () => {
    expect(planoLibera("voz", { cobrancaLigada: true, liberaTudo: false, capacidades: ["campanhas"] })).toBe(false);
  });
  it("aceita a capacidade que o plano tem", () => {
    expect(planoLibera("voz", { cobrancaLigada: true, liberaTudo: false, capacidades: ["voz"] })).toBe(true);
  });
});

describe("ehCapacidadeDePlano recusa o que não é da lista", () => {
  it.each([undefined, null, 3, "", "inventada", "CAMPANHAS"])("%s", (v) => {
    expect(ehCapacidadeDePlano(v)).toBe(false);
  });
});
