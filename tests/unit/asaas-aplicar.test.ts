/**
 * O APLICADOR DE EVENTOS DO ASAAS — COM BANCO E REDE DUBLADOS.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. A organização sai de DADO NOSSO (token do checkout, id de assinatura
 *      gravado, ou consulta ao `externalReference`) — nunca do que o payload diz
 *      sobre o pagador. Sem dado nosso: `sem_organizacao`, registrado.
 *   2. Cobrança da conta que não é deste produto não vira pendência na tela.
 *   3. Evento de uma assinatura ANTIGA nunca toca a VIGENTE — exceto a única
 *      porta de troca (checkout nosso ainda não pago).
 *   4. `pago` sem período (nem vencimento, nem intervalo) não cria nem estende
 *      nada — seria "sem prazo" = acesso vitalício.
 *   5. O mesmo pagamento entregue duas vezes dá o mesmo prazo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

import { audit } from "@/lib/audit";
import { processarEventoDoAsaas } from "@/lib/planos/asaas/aplicar";
import type { CredenciaisDoAsaas } from "@/lib/planos/asaas/cliente";
import type { EventoDoAsaas } from "@/lib/planos/asaas/webhook";
import { MARGEM_DE_RENOVACAO_MS } from "@/lib/planos/cobranca/maquina";

import { dbFalso } from "./helpers/db-falso-planos";

const ORG = "11111111-1111-4111-8111-111111111111";
const CRED: CredenciaisDoAsaas = { apiKey: "$aact_hmlg_x", webhookToken: "t".repeat(40), ambiente: "sandbox" };
const AGORA = new Date("2026-10-18T12:00:00Z");
const FATURA = "https://www.asaas.com/i/080225913252";
const FIM_DO_MES_QUE_VEM = new Date("2026-11-18T23:59:59-03:00").getTime() + MARGEM_DE_RENOVACAO_MS;

function evento(over: Partial<EventoDoAsaas> = {}): EventoDoAsaas {
  return {
    eventoId: "evt_1",
    evento: "PAYMENT_RECEIVED",
    pagamentoId: "pay_1",
    assinaturaId: "sub_1",
    clienteId: "cus_1",
    referenciaExterna: null,
    faturaUrl: null,
    vencimento: "2026-10-18",
    billingType: "PIX",
    ...over,
  };
}

const OPTS = { agora: AGORA, eventoCriadoEm: AGORA, carenciaDias: 5, cred: CRED };

const checkout = (over: Partial<Record<string, unknown>> = {}) => ({
  data: {
    session_id: "dc_tok",
    organization_id: ORG,
    plano_id: "plano-1",
    preco_id: "preco-1",
    pago_em: null,
    asaas_assinatura_id: null,
    ...over,
  },
});

const assinaturaAtual = (over: Partial<Record<string, unknown>> = {}) => ({
  data: {
    situacao: "ativa",
    liberado_ate: "2026-10-20T00:00:00.000Z",
    carencia_ate: null,
    cancelada_em: null,
    ultimo_evento_em: "2026-09-18T00:00:00.000Z",
    asaas_assinatura_id: "sub_1",
    asaas_cliente_id: "cus_1",
    asaas_fatura_url: null,
    plano_id: "plano-1",
    preco_id: "preco-1",
    ...over,
  },
});

describe("processarEventoDoAsaas — de quem é o pagamento", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(audit).mockClear();
  });

  it("tipo que não tratamos: ignora sem tocar em nenhuma tabela", async () => {
    const { db, consultas } = dbFalso({});
    const r = await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_UPDATED" }), OPTS);
    expect(r).toEqual({ resultado: "ignorado_tipo", organizationId: null, via: null, detalhe: "evento_nao_tratado:PAYMENT_UPDATED" });
    expect(consultas).toEqual([]);
  });

  it("cobrança avulsa da conta (sem assinatura nem token nosso): ignora sem tocar em tabela nem rede", async () => {
    const fetchEspiao = vi.fn();
    vi.stubGlobal("fetch", fetchEspiao);
    const { db, consultas } = dbFalso({});
    const r = await processarEventoDoAsaas(db, evento({ assinaturaId: null, referenciaExterna: null }), OPTS);
    expect(r).toMatchObject({ resultado: "ignorado_tipo", detalhe: "sem_assinatura_nem_referencia" });
    expect(consultas).toEqual([]);
    expect(fetchEspiao).not.toHaveBeenCalled();
  });

  it("resolve pelo TOKEN do checkout: pago aplica, cria a assinatura e marca o checkout como pago", async () => {
    const { db, escritas } = dbFalso({
      cobranca_checkouts: checkout(),
      assinaturas: [{ data: null }, {}],
      plano_precos: { data: { plano_id: "plano-1", valor_cents: 19700, moeda: "BRL", intervalo: "mensal" } },
    });
    const r = await processarEventoDoAsaas(db, evento({ referenciaExterna: "dc_tok" }), OPTS);
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "token" });

    const upsert = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert")!.args[0] as Record<string, unknown>;
    expect(upsert).toMatchObject({
      organization_id: ORG,
      plano_id: "plano-1",
      preco_id: "preco-1",
      situacao: "ativa",
      carencia_ate: null,
      asaas_assinatura_id: "sub_1",
      asaas_cliente_id: "cus_1",
      valor_cents: 19700,
      moeda: "BRL",
      liberado_por: null,
      motivo: null,
    });
    expect(new Date(upsert.liberado_ate as string).getTime()).toBe(FIM_DO_MES_QUE_VEM);

    const atualizacaoDoCheckout = escritas.find((e) => e.tabela === "cobranca_checkouts" && e.metodo === "update")!.args[0];
    expect(atualizacaoDoCheckout).toMatchObject({
      pago_em: AGORA.toISOString(),
      asaas_pagamento_id: "pay_1",
      asaas_assinatura_id: "sub_1",
      asaas_cliente_id: "cus_1",
    });
  });

  it("resolve pelo id da ASSINATURA já vinculada à organização", async () => {
    const { db } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual(), {}],
      plano_precos: { data: { intervalo: "mensal" } },
    });
    const r = await processarEventoDoAsaas(db, evento(), OPTS);
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "assinatura" });
  });

  it("resolve pelo checkout que guarda o id da assinatura (antes de existir linha em assinaturas)", async () => {
    const { db } = dbFalso({
      assinaturas: [{ data: null }, { data: null }, {}],
      cobranca_checkouts: [checkout({ asaas_assinatura_id: "sub_1" }), {}],
      plano_precos: { data: { plano_id: "plano-1", valor_cents: 19700, moeda: "BRL", intervalo: "mensal" } },
    });
    const r = await processarEventoDoAsaas(db, evento(), OPTS);
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "checkout_por_assinatura" });
  });

  it("webhook que chega ANTES de o checkout guardar o id: consulta a assinatura e acha o checkout pelo externalReference", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      chamadas.push(String(url));
      return new Response(JSON.stringify({ id: "sub_1", externalReference: "dc_tok" }), { status: 200 });
    });
    const { db } = dbFalso({
      assinaturas: [{ data: null }, { data: null }, {}],
      // 1: por asaas_assinatura_id (nada); 2: por token (achou); 3: o update do pago
      cobranca_checkouts: [{ data: null }, checkout(), {}],
      plano_precos: { data: { plano_id: "plano-1", valor_cents: 19700, moeda: "BRL", intervalo: "mensal" } },
    });
    const r = await processarEventoDoAsaas(db, evento(), OPTS);
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "assinatura_consultada" });
    expect(chamadas).toEqual(["https://api-sandbox.asaas.com/v3/subscriptions/sub_1"]);
  });

  it("assinatura da conta que NÃO foi criada por nós (externalReference sem o prefixo dc_): ignora, não vira pendência", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "sub_1", externalReference: "pedido-123" }), { status: 200 }));
    const { db, escritas } = dbFalso({ assinaturas: { data: null }, cobranca_checkouts: { data: null } });
    const r = await processarEventoDoAsaas(db, evento(), OPTS);
    expect(r).toMatchObject({ resultado: "ignorado_tipo", detalhe: "assinatura_de_terceiro" });
    expect(escritas).toEqual([]);
  });

  it("nada nosso leva a uma organização (e a consulta falha): sem_organizacao, e NADA é escrito", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const { db, escritas } = dbFalso({ assinaturas: { data: null }, cobranca_checkouts: { data: null } });
    const r = await processarEventoDoAsaas(db, evento({ clienteId: "cus_que_o_payload_diz" }), OPTS);
    expect(r).toEqual({ resultado: "sem_organizacao", organizationId: null, via: null });
    expect(escritas).toEqual([]);
  });

  it("organizacaoForcada (ligação manual) resolve sem consultar tabela para achar a organização", async () => {
    const { db, consultas } = dbFalso({ assinaturas: { data: null } });
    const r = await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_CREATED", faturaUrl: FATURA }), {
      ...OPTS,
      organizacaoForcada: ORG,
    });
    expect(r).toMatchObject({ organizationId: ORG, via: "organizacaoForcada" });
    expect(consultas).toEqual(["assinaturas"]); // só a leitura da fatura
  });
});

describe("processarEventoDoAsaas — efeitos", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(audit).mockClear();
  });

  it("o MESMO pagamento em CONFIRMED e depois em RECEIVED dá o mesmo prazo", async () => {
    const aplicarUma = async (nome: string) => {
      const { db, escritas } = dbFalso({
        assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual({ liberado_ate: "2026-10-18T00:00:00.000Z" }), {}],
        plano_precos: { data: { intervalo: "mensal" } },
      });
      await processarEventoDoAsaas(db, evento({ evento: nome }), OPTS);
      const up = escritas.find((e) => e.metodo === "upsert")!.args[0] as Record<string, unknown>;
      return up.liberado_ate;
    };
    const confirmado = await aplicarUma("PAYMENT_CONFIRMED");
    const recebido = await aplicarUma("PAYMENT_RECEIVED");
    expect(confirmado).toBe(recebido);
    expect(new Date(confirmado as string).getTime()).toBe(FIM_DO_MES_QUE_VEM);
  });

  it("pago SEM vencimento e SEM intervalo: ignorado_sem_periodo — nada é escrito (seria acesso vitalício)", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual({ preco_id: null })],
    });
    const r = await processarEventoDoAsaas(db, evento({ vencimento: null }), OPTS);
    expect(r).toMatchObject({ resultado: "ignorado_sem_periodo", organizationId: ORG });
    expect(escritas).toEqual([]);
  });

  it("PAYMENT_OVERDUE: inadimplente, com carência, e guarda o link e o vencimento da fatura em aberto", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual(), {}],
    });
    const r = await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_OVERDUE", faturaUrl: FATURA, vencimento: "2026-10-15" }), OPTS);
    expect(r.resultado).toBe("aplicado");
    const up = escritas.find((e) => e.metodo === "upsert")!.args[0] as Record<string, unknown>;
    expect(up).toMatchObject({
      situacao: "inadimplente",
      asaas_fatura_url: FATURA,
      asaas_fatura_vencimento: "2026-10-15",
      carencia_ate: new Date(AGORA.getTime() + 5 * 86_400_000).toISOString(),
    });
    expect(up.liberado_ate).toBe("2026-10-20T00:00:00.000Z");
  });

  it("pago limpa a fatura em aberto SE era ela; não limpa a da próxima cobrança", async () => {
    const limpa = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual({ asaas_fatura_url: FATURA }), {}],
      plano_precos: { data: { intervalo: "mensal" } },
    });
    await processarEventoDoAsaas(limpa.db, evento({ faturaUrl: FATURA }), OPTS);
    expect(limpa.escritas.find((e) => e.metodo === "upsert")!.args[0]).toMatchObject({
      asaas_fatura_url: null,
      asaas_fatura_vencimento: null,
    });

    const intacta = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual({ asaas_fatura_url: "https://www.asaas.com/i/PROXIMA" }), {}],
      plano_precos: { data: { intervalo: "mensal" } },
    });
    await processarEventoDoAsaas(intacta.db, evento({ faturaUrl: FATURA }), OPTS);
    expect(intacta.escritas.find((e) => e.metodo === "upsert")!.args[0]).not.toHaveProperty("asaas_fatura_url");
  });

  it("estorno corta na hora e SUBSCRIPTION_DELETED mantém o prazo, os dois limpando a fatura", async () => {
    const estorno = dbFalso({ assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual(), {}] });
    await processarEventoDoAsaas(estorno.db, evento({ evento: "PAYMENT_REFUNDED" }), OPTS);
    expect(estorno.escritas.find((e) => e.metodo === "upsert")!.args[0]).toMatchObject({
      situacao: "cancelada",
      asaas_fatura_url: null,
    });

    const removida = dbFalso({ assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual(), {}] });
    await processarEventoDoAsaas(removida.db, evento({ evento: "SUBSCRIPTION_DELETED", pagamentoId: null }), OPTS);
    const up = removida.escritas.find((e) => e.metodo === "upsert")!.args[0] as Record<string, unknown>;
    expect(up).toMatchObject({ situacao: "ativa", liberado_ate: "2026-10-20T00:00:00.000Z", asaas_fatura_url: null });
    expect(up.cancelada_em).toBe(AGORA.toISOString());
  });

  it("falha/estorno sem linha de assinatura: sem_assinatura, nada escrito (nunca cria linha sem prazo)", async () => {
    const { db, escritas } = dbFalso({ assinaturas: [{ data: { organization_id: ORG } }, { data: null }] });
    const r = await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_OVERDUE" }), OPTS);
    expect(r.resultado).toBe("sem_assinatura");
    expect(escritas).toEqual([]);
  });

  it("evento mais velho que o último aplicado: fora_de_ordem", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, assinaturaAtual({ ultimo_evento_em: "2026-10-18T13:00:00.000Z" })],
      plano_precos: { data: { intervalo: "mensal" } },
    });
    const r = await processarEventoDoAsaas(db, evento(), OPTS);
    expect(r.resultado).toBe("fora_de_ordem");
    expect(escritas).toEqual([]);
  });
});

describe("processarEventoDoAsaas — PAYMENT_CREATED e a fatura em aberto", () => {
  it("guarda o link e o vencimento quando a organização já tem assinatura", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, { data: { asaas_assinatura_id: "sub_1" } }, {}],
    });
    const r = await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_CREATED", faturaUrl: FATURA, vencimento: "2026-11-17" }), OPTS);
    expect(r).toMatchObject({ resultado: "fatura_registrada", organizationId: ORG });
    expect(escritas.find((e) => e.metodo === "update")!.args[0]).toEqual({
      asaas_fatura_url: FATURA,
      asaas_fatura_vencimento: "2026-11-17",
    });
  });

  it("fatura de OUTRA assinatura que não a vigente não é guardada", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, { data: { asaas_assinatura_id: "sub_vigente" } }],
    });
    const r = await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_CREATED", faturaUrl: FATURA }), OPTS);
    expect(r).toMatchObject({ resultado: "sem_efeito", detalhe: "fatura_de_outra_assinatura" });
    expect(escritas).toEqual([]);
  });

  it("organização sem linha em assinaturas (ainda não pagou): sem_efeito — a linha só nasce com período pago", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, { data: null }],
    });
    const r = await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_CREATED", faturaUrl: FATURA }), OPTS);
    expect(r).toMatchObject({ resultado: "sem_efeito", detalhe: "sem_linha_de_assinatura" });
    expect(escritas.some((e) => e.tabela === "assinaturas")).toBe(false);
  });

  it("pelo checkout: grava o id do pagamento nele", async () => {
    const { db, escritas } = dbFalso({
      cobranca_checkouts: [checkout(), {}],
      assinaturas: { data: null },
    });
    await processarEventoDoAsaas(db, evento({ evento: "PAYMENT_CREATED", referenciaExterna: "dc_tok", faturaUrl: FATURA }), OPTS);
    expect(escritas.find((e) => e.tabela === "cobranca_checkouts")!.args[0]).toEqual({
      asaas_pagamento_id: "pay_1",
      asaas_assinatura_id: "sub_1",
    });
  });
});

describe("processarEventoDoAsaas — troca de plano", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(audit).mockClear();
  });

  const vigente = (over: Partial<Record<string, unknown>> = {}) => assinaturaAtual({ asaas_assinatura_id: "sub_antiga", ...over });

  it("falha/cancelamento/estorno da assinatura ANTIGA nunca toca a vigente", async () => {
    for (const nome of ["PAYMENT_OVERDUE", "PAYMENT_REFUNDED", "SUBSCRIPTION_DELETED"]) {
      const { db, escritas } = dbFalso({
        assinaturas: [{ data: { organization_id: ORG } }, vigente()],
      });
      const r = await processarEventoDoAsaas(db, evento({ evento: nome, assinaturaId: "sub_velha" }), OPTS);
      expect(r.resultado).toBe("ignorado_assinatura_antiga");
      expect(escritas).toEqual([]);
    }
  });

  it("pago de checkout nosso ainda não pago é TROCA: a nova vira vigente e a antiga é removida no Asaas", async () => {
    const chamadas: Array<{ url: string; metodo: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      chamadas.push({ url: String(url), metodo: init?.method ?? "GET" });
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    });
    const { db, escritas } = dbFalso({
      cobranca_checkouts: [checkout({ plano_id: "plano-2", preco_id: "preco-2" }), {}],
      assinaturas: [vigente(), {}],
      plano_precos: { data: { plano_id: "plano-2", valor_cents: 29700, moeda: "BRL", intervalo: "mensal" } },
    });
    const r = await processarEventoDoAsaas(db, evento({ referenciaExterna: "dc_tok", assinaturaId: "sub_nova" }), OPTS);
    expect(r).toMatchObject({ resultado: "aplicado", via: "token" });
    expect(r.detalhe).toBe("assinatura_antiga_cancelamento:ok");
    const up = escritas.find((e) => e.metodo === "upsert")!.args[0] as Record<string, unknown>;
    expect(up).toMatchObject({ asaas_assinatura_id: "sub_nova", plano_id: "plano-2", preco_id: "preco-2", valor_cents: 29700 });
    expect(chamadas).toEqual([{ url: "https://api-sandbox.asaas.com/v3/subscriptions/sub_antiga", metodo: "DELETE" }]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "assinatura.assinatura_antiga_cancelada" }));
  });

  it("pago da assinatura antiga SEM checkout novo: estende o período mas NÃO troca o id", async () => {
    const fetchEspiao = vi.fn();
    vi.stubGlobal("fetch", fetchEspiao);
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: { organization_id: ORG } }, vigente(), {}],
      plano_precos: { data: { intervalo: "mensal" } },
    });
    const r = await processarEventoDoAsaas(db, evento({ assinaturaId: "sub_velha" }), OPTS);
    expect(r).toMatchObject({ resultado: "aplicado", detalhe: "assinatura_antiga_cobrou" });
    expect(escritas.find((e) => e.metodo === "upsert")!.args[0]).toMatchObject({ asaas_assinatura_id: "sub_antiga" });
    expect(fetchEspiao).not.toHaveBeenCalled();
  });
});
