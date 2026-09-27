/**
 * A DECISÃO DE TETO E AS TRÊS GUARDAS — o que cada resposta do mundo vira.
 *
 * Três propriedades, em ordem de gravidade se quebrarem:
 *
 *   1. `uso: null` ("não medi") NUNCA bloqueia e NUNCA se disfarça de "dentro do
 *      teto". Se virasse `0`, um defeito de leitura faria o teto nunca disparar.
 *   2. O modo é escada: `avisar` nunca recusa. Ninguém é bloqueado sem antes ter
 *      sido avisado, e o modo nasce `avisar`.
 *   3. Capacidade falha FECHADO com 503 — e o 503 NUNCA afirma `plano_nao_inclui`,
 *      porque a recusa não pode AFIRMAR uma causa que ninguém mediu.
 */
import { describe, expect, it } from "vitest";

import { decidirAcesso } from "@/lib/planos/decisao";
import type { EstadoDeCobranca } from "@/lib/planos/estado";
import {
  exigirAcessoLiberado,
  exigirCapacidade,
  exigirFolgaNoLimite,
  negacaoDeAcesso,
  negacaoDeCapacidade,
} from "@/lib/planos/guarda";
import { decidirLimite } from "@/lib/planos/limites";

const AGORA = new Date("2026-09-26T12:00:00Z");
const emDias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000);

/** Um estado de cobrança LIGADA, plano com 2 capacidades e tetos, acesso em dia. */
function estado(patch: Partial<EstadoDeCobranca> = {}): EstadoDeCobranca {
  return {
    acesso: decidirAcesso({
      cobrancaLigada: true, liberadoAte: emDias(20), situacao: "ativa", carenciaAte: null, agora: AGORA,
    }),
    planoId: "plano-1",
    liberaTudo: false,
    capacidades: ["campanhas", "voz"],
    limites: { usuarios: 5, contatos: 1000 },
    cobrancaLigada: true,
    modoDeLimite: "bloquear",
    ...patch,
  };
}
const naoMedido = () =>
  estado({
    acesso: { liberado: true, motivo: "indeterminado", expiraEm: null, diasRestantes: null, naoMedido: true },
    liberaTudo: false,
  });
const vencido = () =>
  estado({
    acesso: decidirAcesso({
      cobrancaLigada: true, liberadoAte: emDias(-1), situacao: null, carenciaAte: null, agora: AGORA,
    }),
  });

async function corpo(r: Response | null): Promise<{ status: number; code: string } | null> {
  if (!r) return null;
  const j = (await r.json()) as { error: { code: string } };
  return { status: r.status, code: j.error.code };
}

describe("decidirLimite", () => {
  const b = { cobrancaLigada: true, modo: "bloquear" as const, teto: 5 };

  it("cobrança desligada: segue", () => {
    expect(decidirLimite({ ...b, cobrancaLigada: false, uso: 99 }).porque).toBe("cobranca_desligada");
  });
  it("sem teto no plano: segue, sem medir", () => {
    expect(decidirLimite({ ...b, teto: null, uso: 99 })).toMatchObject({ acao: "seguir", porque: "sem_teto" });
  });
  it("modo off: segue", () => {
    expect(decidirLimite({ ...b, modo: "off", uso: 99 }).acao).toBe("seguir");
  });
  it("NÃO MEDIDO nunca bloqueia, mesmo em modo bloquear", () => {
    const v = decidirLimite({ ...b, uso: null });
    expect(v.acao).toBe("seguir");
    expect(v.porque).toBe("nao_medido");
  });
  it("dentro do teto: segue, com o restante", () => {
    expect(decidirLimite({ ...b, uso: 3 })).toMatchObject({ acao: "seguir", restante: 2 });
  });
  it("no teto exato já é atingido (5 de 5 não cria o sexto)", () => {
    expect(decidirLimite({ ...b, uso: 5 }).acao).toBe("bloquear");
  });
  it("acima do teto bloqueia em modo bloquear", () => {
    expect(decidirLimite({ ...b, uso: 9 })).toMatchObject({ acao: "bloquear", restante: 0 });
  });
  it("em modo AVISAR, atingido só avisa e segue", () => {
    expect(decidirLimite({ ...b, modo: "avisar", uso: 9 }).acao).toBe("avisar_e_seguir");
  });
});

describe("exigirFolgaNoLimite", () => {
  it("dentro do teto: segue", async () => {
    expect(await exigirFolgaNoLimite("org", "usuarios", { estado: estado(), uso: 2 })).toBeNull();
  });
  it("no teto em modo bloquear: 409 plano_limite_atingido", async () => {
    expect(await corpo(await exigirFolgaNoLimite("org", "usuarios", { estado: estado(), uso: 5 }))).toEqual({
      status: 409, code: "plano_limite_atingido",
    });
  });
  it("no teto em modo avisar: SEGUE — ninguém é bloqueado sem aviso", async () => {
    const e = estado({ modoDeLimite: "avisar" });
    expect(await exigirFolgaNoLimite("org", "usuarios", { estado: e, uso: 50 })).toBeNull();
  });
  it("uso não medido (null) segue mesmo em bloquear", async () => {
    expect(await exigirFolgaNoLimite("org", "usuarios", { estado: estado(), uso: null })).toBeNull();
  });
  it("limite sem teto no plano segue", async () => {
    expect(await exigirFolgaNoLimite("org", "agentes", { estado: estado(), uso: 999 })).toBeNull();
  });
  it("plano que libera tudo ignora o teto", async () => {
    expect(await exigirFolgaNoLimite("org", "usuarios", { estado: estado({ liberaTudo: true }), uso: 99 })).toBeNull();
  });
  it("cobrança desligada nunca recusa", async () => {
    expect(await exigirFolgaNoLimite("org", "usuarios", { estado: estado({ cobrancaLigada: false }), uso: 99 })).toBeNull();
  });
  it("o modo da opts vence o da instalação (só para teste e para rotas que sabem)", async () => {
    expect(await exigirFolgaNoLimite("org", "usuarios", { estado: estado({ modoDeLimite: "off" }), uso: 99, modo: "bloquear" }))
      .not.toBeNull();
  });
});

describe("exigirCapacidade — falha FECHADO, com o código honesto", () => {
  it("capacidade no plano: segue", async () => {
    expect(await exigirCapacidade("org", "campanhas", { estado: estado() })).toBeNull();
  });
  it("capacidade fora do plano: 422 plano_nao_inclui", async () => {
    expect(await corpo(await exigirCapacidade("org", "banco_externo", { estado: estado() }))).toEqual({
      status: 422, code: "plano_nao_inclui",
    });
  });
  it("NÃO MEDIDO: 503 plano_estado_indeterminado — e NUNCA plano_nao_inclui", async () => {
    // A recusa não pode AFIRMAR uma causa que ninguém mediu: mandaria o admin
    // procurar um botão de upgrade para um problema de banco.
    expect(await corpo(await exigirCapacidade("org", "campanhas", { estado: naoMedido() }))).toEqual({
      status: 503, code: "plano_estado_indeterminado",
    });
  });
  it("libera_tudo passa em qualquer capacidade", async () => {
    expect(await exigirCapacidade("org", "voz", { estado: estado({ liberaTudo: true, capacidades: [] }) })).toBeNull();
  });
  it("cobrança desligada passa em qualquer capacidade", async () => {
    expect(await exigirCapacidade("org", "voz", { estado: estado({ cobrancaLigada: false, capacidades: [] }) })).toBeNull();
  });
});

describe("exigirAcessoLiberado — falha ABERTO, e alarma", () => {
  it("em dia: segue", async () => {
    expect(await exigirAcessoLiberado("org", { estado: estado() })).toBeNull();
  });
  it("teste vencido: 402 assinatura_vencida", async () => {
    expect(await corpo(await exigirAcessoLiberado("org", { estado: vencido() }))).toEqual({
      status: 402, code: "assinatura_vencida",
    });
  });
  it("inadimplente fora da carência: 402 assinatura_inadimplente (a ação é outra)", async () => {
    const e = estado({
      acesso: decidirAcesso({
        cobrancaLigada: true, liberadoAte: emDias(-9), situacao: "inadimplente", carenciaAte: emDias(-1), agora: AGORA,
      }),
    });
    expect(await corpo(await exigirAcessoLiberado("org", { estado: e }))).toEqual({
      status: 402, code: "assinatura_inadimplente",
    });
  });
  it("NÃO MEDIDO: LIBERA (o mesmo lado de orcamento.ts) — a assimetria com capacidade é de propósito", async () => {
    expect(await exigirAcessoLiberado("org", { estado: naoMedido() })).toBeNull();
  });
});

describe("negacaoDeAcesso / negacaoDeCapacidade — a mesma tabela para os dois protocolos", () => {
  const t = (s: string) => s;
  it("acesso: null quando em dia, dado quando vencido", () => {
    expect(negacaoDeAcesso(estado(), "org", t)).toBeNull();
    expect(negacaoDeAcesso(vencido(), "org", t)).toMatchObject({ code: "assinatura_vencida", status: 402 });
  });
  it("capacidade: o texto sai da frase da porta, não de uma cópia", () => {
    expect(negacaoDeCapacidade(estado(), "voz", t)).toBeNull();
    const n = negacaoDeCapacidade(estado(), "anuncios", t);
    expect(n).toMatchObject({ code: "plano_nao_inclui", status: 422 });
    expect(n?.mensagem).toContain("anúncio");
  });
});
