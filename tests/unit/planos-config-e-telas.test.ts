/**
 * A CONFIGURAÇÃO DA COBRANÇA E A CONSISTÊNCIA ENTRE O QUE A TELA OFERECE E O QUE O GATE LÊ.
 *
 * O defeito que este arquivo previne é o do cabeçalho de `orcamento.ts:5-16`: a tela
 * edita um campo e o enforcement lê OUTRO, "e quem preenchia a tela acreditava estar
 * protegido e não estava". Aqui ele tem três formas, e cada uma tem um caso:
 *
 *   1. o vocabulário do formulário do /admin sai das MESMAS constantes que o gate consome;
 *   2. a chave que a tela grava é a MESMA que o gate lê (`COBRANCA_LIGADA` etc.);
 *   3. nenhuma porta de SAÍDA declara capacidade — desconectar não pode depender do plano.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CAPACIDADES_DE_PLANO } from "@/lib/planos/capacidades";
import {
  PADRAO_DA_COBRANCA,
  contarOrganizacoesVencidas,
  lerConfigDeCobranca,
  linhasDoPatch,
  validarTransicaoDeModo,
} from "@/lib/planos/config";
import {
  CHAVE_COBRANCA_LIGADA,
  CHAVE_LIMITES_MODO,
  lerChavesDaInstalacao,
} from "@/lib/planos/estado";
import { LIMITES_DE_PLANO } from "@/lib/planos/limites";
import { criarPlanoSchema, editarPlanoSchema, liberarAcessoSchema } from "@/lib/planos/schemas";

import { dbFalso } from "./helpers/db-falso-planos";

describe("validarTransicaoDeModo — a escada dos tetos", () => {
  it.each([
    ["off", "avisar"], ["avisar", "bloquear"],
    // Descer é SEMPRE livre: desligar um bloqueio que trancou gente não pode esperar degrau.
    ["bloquear", "avisar"], ["bloquear", "off"], ["avisar", "off"],
    ["off", "off"], ["avisar", "avisar"], ["bloquear", "bloquear"],
  ] as const)("%s → %s vale", (de, para) => {
    expect(validarTransicaoDeModo(de, para)).toBeNull();
  });

  it("off → bloquear NÃO vale: pularia o degrau de aviso", () => {
    // É o que transformaria "acabei de ligar os limites" em "metade dos clientes
    // recusados no primeiro clique".
    expect(validarTransicaoDeModo("off", "bloquear")).toMatch(/um degrau por vez/i);
  });
});

describe("linhasDoPatch", () => {
  it("só produz linha para o que veio no patch", () => {
    expect(linhasDoPatch({ ligada: true })).toEqual([{ chave: "COBRANCA_LIGADA", valor: "ligado" }]);
    expect(linhasDoPatch({ ligada: false })).toEqual([{ chave: "COBRANCA_LIGADA", valor: "desligado" }]);
  });
  it("um patch completo cobre as quatro chaves", () => {
    const chaves = linhasDoPatch({ ligada: true, diasDeTeste: 7, carenciaDias: 3, modoDeLimite: "avisar" }).map((l) => l.chave);
    expect(chaves.sort()).toEqual(["CARENCIA_DIAS", "COBRANCA_LIGADA", "DIAS_DE_TESTE", "LIMITES_MODO"]);
  });
  it("patch vazio não produz nada", () => {
    expect(linhasDoPatch({})).toEqual([]);
  });
});

describe("lerConfigDeCobranca", () => {
  const cfg = (linhas: Array<[string, string | null]>) => ({
    platform_config: { data: linhas.map(([chave, valor]) => ({ chave, valor })) },
  });

  it("lê as quatro chaves", async () => {
    const { db } = dbFalso(cfg([["COBRANCA_LIGADA", "ligado"], ["DIAS_DE_TESTE", "7"], ["CARENCIA_DIAS", "3"], ["LIMITES_MODO", "bloquear"]]));
    expect(await lerConfigDeCobranca(db)).toEqual({ ligada: true, diasDeTeste: 7, carenciaDias: 3, modoDeLimite: "bloquear" });
  });
  it("só o valor `ligado` liga — qualquer outro é desligado (a régua de modulos.ts)", async () => {
    for (const v of ["true", "1", "LIGADO", "on", "", null]) {
      const { db } = dbFalso(cfg([["COBRANCA_LIGADA", v]]));
      expect((await lerConfigDeCobranca(db)).ligada, `valor ${JSON.stringify(v)}`).toBe(false);
    }
  });
  it("valor ilegível cai no padrão, nunca lança", async () => {
    const { db } = dbFalso(cfg([["DIAS_DE_TESTE", "muitos"], ["CARENCIA_DIAS", "-4"], ["LIMITES_MODO", "explodir"]]));
    expect(await lerConfigDeCobranca(db)).toEqual(PADRAO_DA_COBRANCA);
  });
  it("erro de leitura devolve o padrão — que é DESLIGADO", async () => {
    const { db } = dbFalso({ platform_config: { error: { message: "boom" } } });
    expect(await lerConfigDeCobranca(db)).toEqual(PADRAO_DA_COBRANCA);
    expect(PADRAO_DA_COBRANCA.ligada).toBe(false);
    // E o modo padrão é o mais brando que ainda deixa rastro.
    expect(PADRAO_DA_COBRANCA.modoDeLimite).toBe("avisar");
  });
});

describe("contarOrganizacoesVencidas", () => {
  it("devolve a contagem", async () => {
    const { db } = dbFalso({ organizations: { count: 3 } });
    expect(await contarOrganizacoesVencidas(db)).toBe(3);
  });
  it("erro é NULL (não medido), nunca 0 — a tela diz que não mediu", async () => {
    const { db } = dbFalso({ organizations: { error: { message: "x" }, count: null } });
    expect(await contarOrganizacoesVencidas(db)).toBeNull();
  });
});

describe("a TELA e o GATE leem a mesma chave", () => {
  it("a chave que /admin/cobranca grava é a que estado.ts lê", async () => {
    // Se as duas divergissem, o dono ligaria a cobrança na tela e o gate leria outra
    // linha: a tela diria "ligada" com nada sendo cobrado.
    const gravadas = linhasDoPatch({ ligada: true, modoDeLimite: "bloquear" }).map((l) => l.chave);
    expect(gravadas).toContain(CHAVE_COBRANCA_LIGADA);
    expect(gravadas).toContain(CHAVE_LIMITES_MODO);

    const { db } = dbFalso({ platform_config: { data: [{ chave: CHAVE_COBRANCA_LIGADA, valor: "ligado" }, { chave: CHAVE_LIMITES_MODO, valor: "bloquear" }] } });
    expect(await lerChavesDaInstalacao(db)).toEqual({ ligada: true, modo: "bloquear" });
  });

  it("o gate e a tela concordam sobre o que é 'ligada' (mesma régua)", async () => {
    for (const valor of ["ligado", "desligado", "sim", null]) {
      const { db } = dbFalso({ platform_config: { data: [{ chave: "COBRANCA_LIGADA", valor }] } });
      expect((await lerChavesDaInstalacao(db)).ligada).toBe((await lerConfigDeCobranca(dbFalso({ platform_config: { data: [{ chave: "COBRANCA_LIGADA", valor }] } }).db)).ligada);
    }
  });
});

describe("o formulário do plano oferece exatamente o que o gate conhece", () => {
  const valido = { codigo: "pro", nome: "Pro" };

  it("aceita TODA capacidade da lista fechada", () => {
    expect(criarPlanoSchema.safeParse({ ...valido, capacidades: [...CAPACIDADES_DE_PLANO] }).success).toBe(true);
  });
  it("recusa capacidade que o gate não conhece", () => {
    expect(criarPlanoSchema.safeParse({ ...valido, capacidades: ["inventada"] }).success).toBe(false);
  });
  it("aceita todo limite da lista fechada, e recusa o que não é dela", () => {
    const todos = LIMITES_DE_PLANO.map((limite) => ({ limite, valor: 5 }));
    expect(criarPlanoSchema.safeParse({ ...valido, limites: todos }).success).toBe(true);
    expect(criarPlanoSchema.safeParse({ ...valido, limites: [{ limite: "ia_cents_por_mes", valor: 5 }] }).success).toBe(false);
  });
  it("limite ZERO é recusado — zero é 'não pode nada', não 'sem limite'", () => {
    expect(criarPlanoSchema.safeParse({ ...valido, limites: [{ limite: "usuarios", valor: 0 }] }).success).toBe(false);
  });
  it("código só aceita o formato do CHECK do banco", () => {
    for (const c of ["Pro", "1pro", "p", "pro plano", "pro-plano", "a".repeat(40)]) {
      expect(criarPlanoSchema.safeParse({ codigo: c, nome: "x" }).success, c).toBe(false);
    }
    expect(criarPlanoSchema.safeParse({ codigo: "pro_2", nome: "x" }).success).toBe(true);
  });
  it("a EDIÇÃO não aceita trocar o código — ele é o nome próprio do plano", () => {
    const r = editarPlanoSchema.safeParse({ codigo: "outro", nome: "Novo nome" });
    // `omit` remove o campo: ele é descartado, nunca chega ao update.
    expect(r.success && "codigo" in r.data).toBe(false);
  });
  it("preço em centavos INTEIROS e moeda ISO", () => {
    expect(criarPlanoSchema.safeParse({ ...valido, precos: [{ intervalo: "mensal", valor_cents: 19700, moeda: "BRL" }] }).success).toBe(true);
    expect(criarPlanoSchema.safeParse({ ...valido, precos: [{ intervalo: "mensal", valor_cents: 197.5, moeda: "BRL" }] }).success).toBe(false);
    expect(criarPlanoSchema.safeParse({ ...valido, precos: [{ intervalo: "mensal", valor_cents: -1, moeda: "BRL" }] }).success).toBe(false);
    expect(criarPlanoSchema.safeParse({ ...valido, precos: [{ intervalo: "semanal", valor_cents: 100, moeda: "BRL" }] }).success).toBe(false);
    expect(criarPlanoSchema.safeParse({ ...valido, precos: [{ intervalo: "mensal", valor_cents: 100, moeda: "real" }] }).success).toBe(false);
  });
});

describe("liberarAcessoSchema — a porta manual", () => {
  const base = { plano_id: null, liberado_ate: "2026-12-31T23:59:59Z", situacao: "cortesia", motivo: "cortesia combinada em reunião" };
  it("aceita uma liberação completa", () => {
    expect(liberarAcessoSchema.safeParse(base).success).toBe(true);
  });
  it("`liberado_ate: null` é SEM PRAZO e é aceito explicitamente", () => {
    expect(liberarAcessoSchema.safeParse({ ...base, liberado_ate: null }).success).toBe(true);
  });
  it("mas AUSENTE não é null: esquecer o campo não vira vitalício", () => {
    const { liberado_ate: _omitido, ...semData } = base;
    expect(liberarAcessoSchema.safeParse(semData).success).toBe(false);
  });
  it("o MOTIVO é obrigatório e tem tamanho mínimo", () => {
    expect(liberarAcessoSchema.safeParse({ ...base, motivo: "" }).success).toBe(false);
    expect(liberarAcessoSchema.safeParse({ ...base, motivo: "ok" }).success).toBe(false);
  });
  it("situação fora do vocabulário é recusada", () => {
    expect(liberarAcessoSchema.safeParse({ ...base, situacao: "talvez" }).success).toBe(false);
  });
});

describe("nenhuma PORTA DE SAÍDA declara capacidade", () => {
  // Desconectar, cancelar e sair não podem depender do plano: quem perdeu a
  // capacidade é justamente quem precisa poder desligá-la. Um plano sem a Agenda do
  // Google que também impedisse DESCONECTAR a agenda prenderia o cliente numa
  // integração que ele não pode mais usar nem desfazer.
  const SAIDAS = [
    "app/api/v1/agenda/google/desconectar/route.ts",
    "app/api/v1/cobranca/checkout/route.ts",
    "app/api/v1/cobranca/portal/route.ts",
    "app/api/v1/cobranca/assinatura/route.ts",
  ];
  it.each(SAIDAS)("%s não tem `capacidade:`", (rota) => {
    expect(readFileSync(rota, "utf8")).not.toMatch(/capacidade:\s*"/);
  });

  it("toda rota de cobrança declara `portaDeSaida` com razão escrita", () => {
    for (const rota of SAIDAS.filter((r) => r.includes("/cobranca/"))) {
      expect(readFileSync(rota, "utf8"), rota).toMatch(/portaDeSaida:\s*\n?\s*"[^"]{25,}"/);
    }
  });
});
