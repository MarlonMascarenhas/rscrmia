/**
 * O CHECKOUT E O CANCELAMENTO PELO ASAAS — COM BANCO E REDE DUBLADOS.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. O CPF/CNPJ vai ao Asaas e a mais lugar nenhum: não é gravado, e um documento
 *      inválido é recusado ANTES de qualquer chamada de rede ou escrita.
 *   2. O cliente é criado só quando a organização não tem um — e antes de criar
 *      busca o que uma tentativa anterior pode ter criado (a API aceita duplicado).
 *   3. A assinatura nasce com `UNDEFINED` (o cliente escolhe), ciclo, valor em
 *      reais e vencimento de hoje em São Paulo; o `externalReference` é o token
 *      do registro NOSSO, gravado ANTES.
 *   4. Rascunho, arquivado, sem preço ou em moeda que o Asaas não cobra não se compram.
 *   5. Cancelar é NA HORA no Asaas, mas o ACESSO (`liberado_ate`) não muda — e
 *      cancelar duas vezes não bate na rede na segunda.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CredenciaisDoAsaas } from "@/lib/planos/asaas/cliente";
import {
  buscarFaturaDaAssinatura,
  cancelarAssinaturaDaOrganizacao,
  centavosParaReais,
  clienteDoAsaasDaOrganizacao,
  criarCheckoutNoAsaas,
  hojeEmSaoPaulo,
} from "@/lib/planos/asaas/sessoes";

import { dbFalso } from "./helpers/db-falso-planos";

const CRED: CredenciaisDoAsaas = { apiKey: "$aact_hmlg_x", webhookToken: "t".repeat(40), ambiente: "sandbox" };
const ORG = "11111111-1111-4111-8111-111111111111";
const CPF = "529.982.247-25";
// 02:00Z de 18/10 ainda é 17/10 em São Paulo (UTC-3): o vencimento tem de ser o DIA de lá.
const AGORA = new Date("2026-10-18T02:00:00Z");
const FATURA = "https://www.asaas.com/i/080225913252";

interface Chamada {
  url: string;
  metodo: string;
  corpo: Record<string, unknown> | null;
}

/** Fetch dublado: cada regra casa por método + trecho do caminho e devolve o corpo dado. */
function asaasFalso(regras: Array<{ metodo: string; trecho: string; status?: number; corpo: unknown }>): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    chamadas.push({ url: String(url), metodo, corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const r = regras.find((x) => x.metodo === metodo && String(url).includes(x.trecho));
    if (!r) return new Response(JSON.stringify({ errors: [{ code: "x", description: "sem regra no teste" }] }), { status: 500 });
    return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200 });
  });
  return chamadas;
}

const plano = (extra: Partial<Record<string, unknown>> = {}) => ({
  data: { id: "plano-1", nome: "Pro", publicado_em: "2026-09-01", arquivado_em: null, ...extra },
});
const preco = (intervalo: "mensal" | "anual", extra: Partial<Record<string, unknown>> = {}) => ({
  data: { id: "preco-1", intervalo, valor_cents: "19700", moeda: "BRL", ...extra },
});

const base = {
  cred: CRED,
  organizationId: ORG,
  usuarioId: "u1",
  planoId: "plano-1",
  intervalo: "mensal" as const,
  agora: AGORA,
  esperaDaFaturaMs: 0,
};

const FETCH_FELIZ = [
  { metodo: "GET", trecho: "/customers?externalReference=", corpo: { data: [] } },
  { metodo: "POST", trecho: "/customers", corpo: { id: "cus_1" } },
  { metodo: "POST", trecho: "/subscriptions", corpo: { id: "sub_1" } },
  { metodo: "GET", trecho: "/subscriptions/sub_1/payments", corpo: { data: [{ id: "pay_1", invoiceUrl: FATURA, dueDate: "2026-10-17" }] } },
];

describe("criarCheckoutNoAsaas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("RASCUNHO, ARQUIVADO e sem preço vigente não se compram — e a rede nem é tocada", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ);
    const a = dbFalso({ planos: plano({ publicado_em: null }) });
    expect(await criarCheckoutNoAsaas({ ...base, db: a.db })).toEqual({ ok: false, falha: "plano_indisponivel" });
    const b = dbFalso({ planos: plano({ arquivado_em: "2026-09-20" }) });
    expect((await criarCheckoutNoAsaas({ ...base, db: b.db })).ok).toBe(false);
    const c = dbFalso({ planos: plano(), plano_precos: { data: null } });
    expect(await criarCheckoutNoAsaas({ ...base, db: c.db })).toEqual({ ok: false, falha: "preco_indisponivel" });
    expect(chamadas).toEqual([]);
  });

  it("preço em moeda que o Asaas não cobra, ou de valor zero, é indisponível", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ);
    const a = dbFalso({ planos: plano(), plano_precos: preco("mensal", { moeda: "USD" }) });
    expect(await criarCheckoutNoAsaas({ ...base, db: a.db })).toEqual({ ok: false, falha: "preco_indisponivel" });
    const b = dbFalso({ planos: plano(), plano_precos: preco("mensal", { valor_cents: "0" }) });
    expect(await criarCheckoutNoAsaas({ ...base, db: b.db })).toEqual({ ok: false, falha: "preco_indisponivel" });
    expect(chamadas).toEqual([]);
  });

  it("organização SEM cliente e SEM documento: pede o documento, sem rede nem escrita", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ);
    const { db, escritas } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    expect(await criarCheckoutNoAsaas({ ...base, db })).toEqual({ ok: false, falha: "documento_obrigatorio" });
    expect(await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana", documento: " " } })).toEqual({
      ok: false,
      falha: "documento_obrigatorio",
    });
    expect(chamadas).toEqual([]);
    expect(escritas).toEqual([]);
  });

  it("CPF/CNPJ INVÁLIDO é recusado e NÃO persistido — sem rede, sem escrita", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ);
    const { db, escritas } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    const r = await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana", documento: "529.982.247-24" } });
    expect(r).toEqual({ ok: false, falha: "documento_invalido" });
    expect(chamadas).toEqual([]);
    expect(escritas).toEqual([]);
  });

  it("1ª assinatura: busca o cliente, cria só se não achar, e a assinatura leva UNDEFINED/ciclo/valor em reais/vencimento de São Paulo", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ);
    const { db, escritas } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    const r = await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana Souza", documento: CPF } });
    expect(r).toEqual({ ok: true, url: FATURA });

    expect(chamadas.map((c) => `${c.metodo} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v3/customers",
      "POST /v3/customers",
      "POST /v3/subscriptions",
      "GET /v3/subscriptions/sub_1/payments",
    ]);
    expect(chamadas[0]!.url).toContain(`externalReference=${ORG}`);
    // O documento vai ao Asaas SÓ com dígitos.
    expect(chamadas[1]!.corpo).toEqual({ name: "Ana Souza", cpfCnpj: "52998224725", externalReference: ORG });

    const registro = escritas.find((e) => e.tabela === "cobranca_checkouts" && e.metodo === "insert")!.args[0] as Record<string, unknown>;
    expect(registro).toMatchObject({
      organization_id: ORG,
      plano_id: "plano-1",
      preco_id: "preco-1",
      provedor: "asaas",
      asaas_cliente_id: "cus_1",
      criado_por: "u1",
    });
    expect(String(registro.session_id)).toMatch(/^dc_[A-Za-z0-9_-]+$/);

    expect(chamadas[2]!.corpo).toEqual({
      customer: "cus_1",
      billingType: "UNDEFINED",
      value: 197,
      nextDueDate: "2026-10-17",
      cycle: "MONTHLY",
      description: "Pro (mensal)",
      externalReference: registro.session_id,
    });

    // O id da assinatura e a fatura são gravados no MESMO registro.
    const atualizacoes = escritas.filter((e) => e.tabela === "cobranca_checkouts" && e.metodo === "update").map((e) => e.args[0]);
    expect(atualizacoes).toEqual([{ asaas_assinatura_id: "sub_1" }, { asaas_pagamento_id: "pay_1" }]);
  });

  it("o CPF/CNPJ NÃO aparece em nenhuma escrita no banco", async () => {
    asaasFalso(FETCH_FELIZ);
    const { db, escritas } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana Souza", documento: CPF } });
    const texto = JSON.stringify(escritas);
    expect(texto).not.toContain("52998224725");
    expect(texto).not.toContain(CPF);
    expect(texto).not.toContain("Ana Souza");
  });

  it("plano anual: ciclo YEARLY", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ);
    const { db } = dbFalso({ planos: plano(), plano_precos: preco("anual", { valor_cents: "197000" }) });
    await criarCheckoutNoAsaas({ ...base, intervalo: "anual", db, pagador: { nome: "Ana", documento: CPF } });
    expect(chamadas.find((c) => c.url.endsWith("/subscriptions"))!.corpo).toMatchObject({ cycle: "YEARLY", value: 1970 });
  });

  it("cliente que uma tentativa anterior criou (achado por externalReference): NÃO recria", async () => {
    const chamadas = asaasFalso([
      { metodo: "GET", trecho: "/customers?externalReference=", corpo: { data: [{ id: "cus_antigo" }] } },
      ...FETCH_FELIZ.slice(2),
    ]);
    const { db, escritas } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    const r = await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana", documento: CPF } });
    expect(r.ok).toBe(true);
    expect(chamadas.some((c) => c.metodo === "POST" && c.url.endsWith("/customers"))).toBe(false);
    const registro = escritas.find((e) => e.tabela === "cobranca_checkouts" && e.metodo === "insert")!.args[0] as Record<string, unknown>;
    expect(registro.asaas_cliente_id).toBe("cus_antigo");
  });

  it("organização que JÁ tem cliente (assinatura anterior): não pede documento e não toca em /customers", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ.slice(2));
    const { db } = dbFalso({
      planos: plano(),
      plano_precos: preco("mensal"),
      assinaturas: { data: { asaas_cliente_id: "cus_da_assinatura" } },
    });
    const r = await criarCheckoutNoAsaas({ ...base, db });
    expect(r).toEqual({ ok: true, url: FATURA });
    expect(chamadas.some((c) => c.url.includes("/customers"))).toBe(false);
    expect(chamadas[0]!.corpo).toMatchObject({ customer: "cus_da_assinatura" });
  });

  it("cliente guardado só no checkout (ainda não pagou) também vale", async () => {
    const { db } = dbFalso({
      assinaturas: { data: null },
      cobranca_checkouts: { data: { asaas_cliente_id: "cus_do_checkout" } },
    });
    expect(await clienteDoAsaasDaOrganizacao(db, ORG)).toBe("cus_do_checkout");
    const { db: vazio } = dbFalso({});
    expect(await clienteDoAsaasDaOrganizacao(vazio, ORG)).toBeNull();
  });

  it("o Asaas recusa o cliente: provedor_recusou, e NADA é gravado", async () => {
    asaasFalso([
      { metodo: "GET", trecho: "/customers?externalReference=", corpo: { data: [] } },
      { metodo: "POST", trecho: "/customers", status: 400, corpo: { errors: [{ code: "invalid_cpfCnpj", description: "CPF/CNPJ inválido" }] } },
    ]);
    const { db, escritas } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    const r = await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana", documento: CPF } });
    expect(r).toEqual({ ok: false, falha: "provedor_recusou", detalhe: "CPF/CNPJ inválido" });
    expect(escritas).toEqual([]);
  });

  it("se o registro do checkout falha, NENHUMA assinatura é criada", async () => {
    const chamadas = asaasFalso(FETCH_FELIZ);
    const { db } = dbFalso({
      planos: plano(),
      plano_precos: preco("mensal"),
      // 1ª chamada: a leitura do cliente guardado (nada); 2ª: o INSERT do registro, que falha.
      cobranca_checkouts: [{ data: null }, { error: { message: "boom" } }],
    });
    const r = await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana", documento: CPF } });
    expect(r).toEqual({ ok: false, falha: "registro_falhou", detalhe: "boom" });
    expect(chamadas.some((c) => c.url.endsWith("/subscriptions"))).toBe(false);
  });

  it("o Asaas recusa a assinatura: provedor_recusou", async () => {
    asaasFalso([
      ...FETCH_FELIZ.slice(0, 2),
      { metodo: "POST", trecho: "/subscriptions", status: 400, corpo: { errors: [{ code: "invalid_value", description: "valor inválido" }] } },
    ]);
    const { db } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    const r = await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana", documento: CPF } });
    expect(r).toEqual({ ok: false, falha: "provedor_recusou", detalhe: "valor inválido" });
  });

  it("a fatura não aparece: fatura_indisponivel, a assinatura JÁ ficou registrada para o webhook", async () => {
    const chamadas = asaasFalso([
      ...FETCH_FELIZ.slice(0, 3),
      { metodo: "GET", trecho: "/subscriptions/sub_1/payments", corpo: { data: [] } },
    ]);
    const { db, escritas } = dbFalso({ planos: plano(), plano_precos: preco("mensal") });
    const r = await criarCheckoutNoAsaas({ ...base, db, pagador: { nome: "Ana", documento: CPF } });
    expect(r).toEqual({ ok: false, falha: "fatura_indisponivel" });
    expect(chamadas.filter((c) => c.url.includes("/payments"))).toHaveLength(4); // tentou algumas vezes
    expect(escritas.some((e) => e.tabela === "cobranca_checkouts" && JSON.stringify(e.args[0]) === '{"asaas_assinatura_id":"sub_1"}')).toBe(true);
  });
});

describe("buscarFaturaDaAssinatura", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acha na 2ª tentativa; escolhe a cobrança de vencimento mais antigo; ignora link que não é https", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      const corpo =
        n === 1
          ? { data: [] }
          : {
              data: [
                { id: "pay_novo", invoiceUrl: "https://www.asaas.com/i/2", dueDate: "2026-11-17" },
                { id: "pay_ruim", invoiceUrl: "javascript:alert(1)", dueDate: "2026-09-01" },
                { id: "pay_velho", invoiceUrl: "https://www.asaas.com/i/1", dueDate: "2026-10-17" },
              ],
            };
      return new Response(JSON.stringify(corpo), { status: 200 });
    });
    expect(await buscarFaturaDaAssinatura(CRED, "sub_1", { esperaMs: 0 })).toEqual({
      url: "https://www.asaas.com/i/1",
      pagamentoId: "pay_velho",
    });
    expect(n).toBe(2);
  });
});

describe("helpers puros", () => {
  it("hojeEmSaoPaulo usa o dia de São Paulo, não o de UTC", () => {
    expect(hojeEmSaoPaulo(new Date("2026-10-18T02:00:00Z"))).toBe("2026-10-17");
    expect(hojeEmSaoPaulo(new Date("2026-10-18T03:00:00Z"))).toBe("2026-10-18");
  });

  it("centavos viram reais decimais só na chamada ao Asaas", () => {
    expect(centavosParaReais(19700)).toBe(197);
    expect(centavosParaReais(1999)).toBe(19.99);
    expect(centavosParaReais(5)).toBe(0.05);
  });
});

describe("cancelarAssinaturaDaOrganizacao", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const liberadoAte = "2026-11-10T00:00:00.000Z";
  const linha = (extra: Partial<Record<string, unknown>> = {}) => ({
    data: {
      situacao: "ativa",
      liberado_ate: liberadoAte,
      carencia_ate: null,
      cancelada_em: null,
      ultimo_evento_em: "2026-10-10T00:00:00Z",
      asaas_assinatura_id: "sub_1",
      ...extra,
    },
  });

  it("sem assinatura no Asaas (liberação manual): recusa sem tocar a rede", async () => {
    const chamadas = asaasFalso([]);
    const { db } = dbFalso({ assinaturas: linha({ asaas_assinatura_id: null }) });
    expect(await cancelarAssinaturaDaOrganizacao({ db, cred: CRED, organizationId: ORG, agora: AGORA })).toEqual({
      ok: false,
      falha: "sem_assinatura_no_provedor",
    });
    expect(chamadas).toEqual([]);
  });

  it("remove NO ASAAS e marca nao_renova: liberado_ate NÃO muda", async () => {
    const chamadas = asaasFalso([{ metodo: "DELETE", trecho: "/subscriptions/sub_1", corpo: { deleted: true, id: "sub_1" } }]);
    const { db, escritas } = dbFalso({ assinaturas: linha() });
    const r = await cancelarAssinaturaDaOrganizacao({ db, cred: CRED, organizationId: ORG, agora: AGORA });
    expect(r).toEqual({ ok: true, acessoAte: new Date(liberadoAte) });
    expect(chamadas).toHaveLength(1);
    const update = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "update")!.args[0] as Record<string, unknown>;
    expect(update).toMatchObject({ situacao: "ativa", liberado_ate: liberadoAte, cancelada_em: AGORA.toISOString() });
  });

  it("cancelar DUAS vezes: a segunda não bate na rede", async () => {
    const chamadas = asaasFalso([]);
    const { db } = dbFalso({ assinaturas: linha({ cancelada_em: "2026-10-12T00:00:00Z" }) });
    const r = await cancelarAssinaturaDaOrganizacao({ db, cred: CRED, organizationId: ORG, agora: AGORA });
    expect(r).toEqual({ ok: true, acessoAte: new Date(liberadoAte) });
    expect(chamadas).toEqual([]);
  });

  it("o Asaas recusa a remoção: nada muda localmente", async () => {
    asaasFalso([{ metodo: "DELETE", trecho: "/subscriptions/sub_1", status: 404, corpo: { errors: [{ code: "x", description: "não existe" }] } }]);
    const { db, escritas } = dbFalso({ assinaturas: linha() });
    const r = await cancelarAssinaturaDaOrganizacao({ db, cred: CRED, organizationId: ORG, agora: AGORA });
    expect(r).toEqual({ ok: false, falha: "provedor_recusou", detalhe: "não existe" });
    expect(escritas).toEqual([]);
  });
});
