/**
 * `lerEstadoDeCobranca` E `medirUso` — o que cada resposta do banco vira.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. ERRO de leitura da assinatura NÃO é "nunca assinou". Tratá-lo como ausência
 *      transformaria um cliente pagante em "em teste" — que tranca quando o prazo
 *      passa. É o não-medido, que libera e alarma.
 *   2. Cobrança desligada custa UMA leitura: nenhuma tabela de assinatura é
 *      tocada. É o caminho de toda instalação que só atualizou.
 *   3. Sem plano escolhido = o produto inteiro. Quem está em teste grátis precisa
 *      experimentar tudo, e ninguém é recusado por um plano que não escolheu.
 *   4. Uso que falhou é `null`, nunca `0`.
 */
import { describe, expect, it } from "vitest";

import { lerEstadoDeCobranca } from "@/lib/planos/estado";
import { medirUso } from "@/lib/planos/uso";

import { dbFalso } from "./helpers/db-falso-planos";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-09-26T12:00:00Z");
const emDias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000).toISOString();

const config = (ligada: boolean, modo = "avisar") => ({
  data: [
    { chave: "COBRANCA_LIGADA", valor: ligada ? "ligado" : "desligado" },
    { chave: "LIMITES_MODO", valor: modo },
  ],
});

describe("lerEstadoDeCobranca", () => {
  it("cobrança DESLIGADA: libera tudo e não toca em assinatura nenhuma", async () => {
    const { db, consultas } = dbFalso({ platform_config: config(false) });
    const e = await lerEstadoDeCobranca(db, ORG, AGORA);
    expect(e.acesso).toMatchObject({ liberado: true, motivo: "cobranca_desligada" });
    expect(e.liberaTudo).toBe(true);
    expect(e.cobrancaLigada).toBe(false);
    // O caminho comum de quem não vende custa UMA leitura de chave.
    expect(consultas).toEqual(["platform_config"]);
  });

  it("LIGADA, org em teste (sem assinatura) e sem plano: libera o produto inteiro", async () => {
    const { db } = dbFalso({
      platform_config: config(true),
      organizations: { data: { acesso_liberado_ate: emDias(7), plano_id: null } },
      assinaturas: { data: null },
    });
    const e = await lerEstadoDeCobranca(db, ORG, AGORA);
    expect(e.acesso).toMatchObject({ liberado: true, motivo: "em_teste", diasRestantes: 7 });
    expect(e.liberaTudo).toBe(true);
    expect(e.planoId).toBeNull();
  });

  it("LIGADA, teste vencido: tranca, com o motivo do teste", async () => {
    const { db } = dbFalso({
      platform_config: config(true),
      organizations: { data: { acesso_liberado_ate: emDias(-2), plano_id: null } },
      assinaturas: { data: null },
    });
    expect((await lerEstadoDeCobranca(db, ORG, AGORA)).acesso).toMatchObject({
      liberado: false, motivo: "teste_vencido",
    });
  });

  it("organização com prazo NULL (anterior à cobrança) nunca vence", async () => {
    const { db } = dbFalso({
      platform_config: config(true),
      organizations: { data: { acesso_liberado_ate: null, plano_id: null } },
      assinaturas: { data: null },
    });
    expect((await lerEstadoDeCobranca(db, ORG, AGORA)).acesso).toMatchObject({ liberado: true, motivo: "sem_prazo" });
  });

  it("ERRO ao ler a assinatura NÃO vira 'nunca assinou' — vira não medido, que libera e alarma", async () => {
    const { db } = dbFalso({
      platform_config: config(true),
      organizations: { data: { acesso_liberado_ate: emDias(-30), plano_id: null } },
      assinaturas: { error: { code: "57014", message: "statement timeout" } },
    });
    const e = await lerEstadoDeCobranca(db, ORG, AGORA);
    // Se isto virasse `teste_vencido`, um cliente PAGANTE seria trancado por um
    // timeout de banco.
    expect(e.acesso).toMatchObject({ liberado: true, motivo: "indeterminado", naoMedido: true });
    // E capacidade falha FECHADO: não libera tudo por não ter conseguido ler.
    expect(e.liberaTudo).toBe(false);
  });

  it("ERRO ao ler a organização também é não medido", async () => {
    const { db } = dbFalso({
      platform_config: config(true),
      organizations: { error: { message: "boom" } },
      assinaturas: { data: null },
    });
    expect((await lerEstadoDeCobranca(db, ORG, AGORA)).acesso.naoMedido).toBe(true);
  });

  it("LIGADA, com plano: traz capacidades, tetos e libera_tudo do plano", async () => {
    const { db } = dbFalso({
      platform_config: config(true, "bloquear"),
      organizations: { data: { acesso_liberado_ate: emDias(30), plano_id: "p1" } },
      assinaturas: { data: { situacao: "ativa", carencia_ate: null, plano_id: "p1" } },
      planos: { data: { libera_tudo: false } },
      plano_capacidades: { data: [{ capacidade: "campanhas" }, { capacidade: "voz" }] },
      plano_limites: { data: [{ limite: "usuarios", valor: 5 }, { limite: "contatos", valor: "1000" }] },
    });
    const e = await lerEstadoDeCobranca(db, ORG, AGORA);
    expect(e.planoId).toBe("p1");
    expect(e.liberaTudo).toBe(false);
    expect(e.capacidades).toEqual(["campanhas", "voz"]);
    // bigint chega como string do PostgREST; o estado entrega número.
    expect(e.limites).toEqual({ usuarios: 5, contatos: 1000 });
    expect(e.modoDeLimite).toBe("bloquear");
    expect(e.acesso).toMatchObject({ liberado: true, motivo: "assinatura_ativa" });
  });

  it("erro ao ler o PLANO devolve o acesso VERDADEIRO e zera o plano — não tranca quem pagou", async () => {
    const { db } = dbFalso({
      platform_config: config(true),
      organizations: { data: { acesso_liberado_ate: emDias(30), plano_id: "p1" } },
      assinaturas: { data: { situacao: "ativa", carencia_ate: null, plano_id: "p1" } },
      planos: { error: { message: "boom" } },
    });
    const e = await lerEstadoDeCobranca(db, ORG, AGORA);
    expect(e.acesso.liberado).toBe(true);
    expect(e.acesso.motivo).toBe("assinatura_ativa");
    expect(e.liberaTudo).toBe(false);
    expect(e.capacidades).toEqual([]);
  });

  it("o modo da instalação cai em `avisar` quando o valor é lixo — nunca em bloquear", async () => {
    const { db } = dbFalso({ platform_config: config(false, "explodir") });
    expect((await lerEstadoDeCobranca(db, ORG, AGORA)).modoDeLimite).toBe("avisar");
  });

  it("erro ao ler as chaves da instalação: cobrança desligada (falha fechada para o MECANISMO)", async () => {
    const { db } = dbFalso({ platform_config: { error: { message: "boom" } } });
    const e = await lerEstadoDeCobranca(db, ORG, AGORA);
    expect(e.cobrancaLigada).toBe(false);
    expect(e.acesso.liberado).toBe(true);
  });
});

describe("medirUso", () => {
  it("conta o que o banco devolve", async () => {
    const { db } = dbFalso({ contacts: { count: 42 } });
    expect(await medirUso(db, ORG, "contatos", AGORA)).toBe(42);
  });

  it("erro de leitura é NULL, nunca 0 — senão o teto nunca dispararia", async () => {
    const { db } = dbFalso({ contacts: { error: { message: "boom" }, count: null } });
    expect(await medirUso(db, ORG, "contatos", AGORA)).toBeNull();
  });

  it("count nulo também é não medido", async () => {
    const { db } = dbFalso({ ai_agents: { count: null } });
    expect(await medirUso(db, ORG, "agentes", AGORA)).toBeNull();
  });

  it("usuários = membros ativos + convites pendentes (o convite OCUPA a vaga)", async () => {
    const { db, consultas } = dbFalso({ user_organizations: { count: 3 }, team_invites: { count: 2 } });
    expect(await medirUso(db, ORG, "usuarios", AGORA)).toBe(5);
    expect(consultas.sort()).toEqual(["team_invites", "user_organizations"]);
  });

  it("usuários: se UMA das duas contagens falha, o resultado é não medido", async () => {
    const { db } = dbFalso({ user_organizations: { count: 3 }, team_invites: { error: { message: "x" }, count: null } });
    expect(await medirUso(db, ORG, "usuarios", AGORA)).toBeNull();
  });

  it.each([
    ["conexoes", "channel_sessions"],
    ["mensagens_por_mes", "pacing_ledger"],
    ["campanhas_por_mes", "campaigns"],
    ["tokens_de_api", "api_tokens"],
    ["agentes", "ai_agents"],
  ] as const)("%s mede em %s — a régua declarada", async (limite, tabela) => {
    const { db, consultas } = dbFalso({ [tabela]: { count: 7 } });
    expect(await medirUso(db, ORG, limite, AGORA)).toBe(7);
    expect(consultas).toEqual([tabela]);
  });

  it("nunca lança, nem quando o cliente explode", async () => {
    const quebrado = { from: () => { throw new Error("cliente morto"); } } as never;
    expect(await medirUso(quebrado, ORG, "contatos", AGORA)).toBeNull();
  });
});
