/**
 * O WEBHOOK DO ASAAS (PURO) E A MÁQUINA DE ESTADOS QUE ELE ALIMENTA.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. O token do webhook é comparado por hash + `timingSafeEqual`; ausente ou
 *      errado nunca passa.
 *   2. O mapa evento → efeito cobre TODOS os eventos que o produto trata, e
 *      qualquer outro é ignorado (nunca vira acesso).
 *   3. O fim do acesso sai do VENCIMENTO da cobrança paga: o mesmo pagamento,
 *      entregue em `PAYMENT_CONFIRMED` e depois em `PAYMENT_RECEIVED`, dá o mesmo prazo.
 *   4. A URL da fatura só vira link se for `https:`.
 */
import { describe, expect, it } from "vitest";

import {
  chaveDoEvento,
  dataDeVencimentoValida,
  entradaSanitizada,
  eventoDaEntrada,
  lerEventoDoAsaas,
  planejarEventoDoAsaas,
  proximoVencimento,
  urlDeFaturaValida,
  verificarTokenDoAsaas,
  type EventoDoAsaas,
} from "@/lib/planos/asaas/webhook";
import { MARGEM_DE_RENOVACAO_MS, fimDoAcessoPago, proximaAssinatura } from "@/lib/planos/cobranca/maquina";

const PAYLOAD_PAGAMENTO = {
  id: "evt_05b708f961d739ea7eba7e4db318f621&368604920",
  event: "PAYMENT_RECEIVED",
  dateCreated: "2026-10-18 16:45:03",
  account: { id: "acc_1", ownerId: null },
  payment: {
    object: "payment",
    id: "pay_080225913252",
    customer: "cus_G7Dvo4iphUNk",
    subscription: "sub_VXJBYgP2u0eO",
    dueDate: "2026-10-18",
    value: 197,
    billingType: "PIX",
    externalReference: "dc_token_nosso",
    invoiceUrl: "https://www.asaas.com/i/080225913252",
  },
};

describe("lerEventoDoAsaas", () => {
  it("lê o id do EVENTO, o pagamento, a assinatura, o cliente, o token nosso, a fatura e o vencimento", () => {
    expect(lerEventoDoAsaas(PAYLOAD_PAGAMENTO)).toEqual({
      eventoId: "evt_05b708f961d739ea7eba7e4db318f621&368604920",
      evento: "PAYMENT_RECEIVED",
      pagamentoId: "pay_080225913252",
      assinaturaId: "sub_VXJBYgP2u0eO",
      clienteId: "cus_G7Dvo4iphUNk",
      referenciaExterna: "dc_token_nosso",
      faturaUrl: "https://www.asaas.com/i/080225913252",
      vencimento: "2026-10-18",
      billingType: "PIX",
    });
  });

  it("evento de assinatura: o id da assinatura é o do próprio objeto", () => {
    const e = lerEventoDoAsaas({
      id: "evt_2",
      event: "SUBSCRIPTION_DELETED",
      subscription: { id: "sub_9", customer: "cus_9", externalReference: "dc_x", deleted: true },
    });
    expect(e).toMatchObject({ assinaturaId: "sub_9", clienteId: "cus_9", referenciaExterna: "dc_x", pagamentoId: null });
  });

  it("sem id do evento ou sem `event`: null; lixo: null; nunca lança", () => {
    expect(lerEventoDoAsaas({ event: "PAYMENT_RECEIVED" })).toBeNull();
    expect(lerEventoDoAsaas({ id: "evt_1" })).toBeNull();
    expect(lerEventoDoAsaas(null)).toBeNull();
    expect(lerEventoDoAsaas("texto")).toBeNull();
    expect(lerEventoDoAsaas({ id: "evt_1", event: "PAYMENT_RECEIVED", payment: "não é objeto" })).toMatchObject({
      pagamentoId: null,
      assinaturaId: null,
    });
  });

  it("URL de fatura que não é https é DESCARTADA; vencimento que não existe também", () => {
    const e = lerEventoDoAsaas({
      id: "evt_3",
      event: "PAYMENT_CREATED",
      payment: { id: "pay_1", subscription: "sub_1", invoiceUrl: "javascript:alert(1)", dueDate: "2026-02-30" },
    });
    expect(e).toMatchObject({ faturaUrl: null, vencimento: null });
    expect(urlDeFaturaValida("http://www.asaas.com/i/1")).toBe(false);
    expect(urlDeFaturaValida("https://www.asaas.com/i/1")).toBe(true);
    expect(dataDeVencimentoValida("2026-02-29")).toBe(false);
    expect(dataDeVencimentoValida("2026-10-18")).toBe(true);
  });

  it("a chave do recibo é o id do evento", () => {
    expect(chaveDoEvento(lerEventoDoAsaas(PAYLOAD_PAGAMENTO)!)).toBe("evt_05b708f961d739ea7eba7e4db318f621&368604920");
  });

  it("entradaSanitizada e eventoDaEntrada são inversos", () => {
    const e = lerEventoDoAsaas(PAYLOAD_PAGAMENTO)!;
    expect(eventoDaEntrada(JSON.parse(JSON.stringify(entradaSanitizada(e))))).toEqual(e);
    expect(eventoDaEntrada({ evento: "x" })).toBeNull();
    expect(eventoDaEntrada(null)).toBeNull();
  });
});

describe("planejarEventoDoAsaas — o mapa de TODOS os eventos tratados", () => {
  const plano = (evento: string) => planejarEventoDoAsaas({ evento } as EventoDoAsaas);

  it.each([
    ["PAYMENT_RECEIVED", "pago"],
    ["PAYMENT_CONFIRMED", "pago"],
    ["PAYMENT_OVERDUE", "falhou"],
    ["PAYMENT_REFUNDED", "estornado"],
    ["PAYMENT_CHARGEBACK_REQUESTED", "estornado"],
    ["SUBSCRIPTION_DELETED", "nao_renova"],
    ["SUBSCRIPTION_INACTIVATED", "nao_renova"],
  ])("%s → efeito %s", (evento, tipo) => {
    expect(plano(evento)).toEqual({ acao: "efeito", efeito: { tipo } });
  });

  it("PAYMENT_CREATED só registra a fatura em aberto", () => {
    expect(plano("PAYMENT_CREATED")).toEqual({ acao: "fatura" });
  });

  it.each(["PAYMENT_UPDATED", "PAYMENT_DELETED", "PAYMENT_BANK_SLIP_VIEWED", "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED", "ALGO_NOVO"])(
    "%s é ignorado, com o motivo gravado",
    (evento) => {
      expect(plano(evento)).toEqual({ acao: "ignorar", motivo: `evento_nao_tratado:${evento}` });
    },
  );
});

describe("verificarTokenDoAsaas", () => {
  const SEGREDO = "s".repeat(40);

  it("token igual passa", () => {
    expect(verificarTokenDoAsaas(SEGREDO, SEGREDO)).toBe(true);
  });

  it("errado, ausente, vazio ou de outro tamanho nunca passa (e nunca lança)", () => {
    expect(verificarTokenDoAsaas("x".repeat(40), SEGREDO)).toBe(false);
    expect(verificarTokenDoAsaas("curto", SEGREDO)).toBe(false);
    expect(verificarTokenDoAsaas("", SEGREDO)).toBe(false);
    expect(verificarTokenDoAsaas(null, SEGREDO)).toBe(false);
    expect(verificarTokenDoAsaas(undefined, SEGREDO)).toBe(false);
    expect(verificarTokenDoAsaas(SEGREDO, "")).toBe(false);
  });
});

describe("proximoVencimento", () => {
  it("mensal: mais um mês, no fim do dia em São Paulo", () => {
    expect(proximoVencimento("2026-10-18", "mensal")!.toISOString()).toBe("2026-11-19T02:59:59.000Z");
  });

  it("anual: mais um ano", () => {
    expect(proximoVencimento("2026-10-18", "anual")!.toISOString()).toBe("2027-10-19T02:59:59.000Z");
  });

  it("31/jan + 1 mês cai no último dia de fevereiro, e dezembro vira janeiro", () => {
    expect(proximoVencimento("2026-01-31", "mensal")!.toISOString()).toBe("2026-03-01T02:59:59.000Z"); // 28/fev 23:59:59-03
    expect(proximoVencimento("2026-12-15", "mensal")!.toISOString()).toBe("2027-01-16T02:59:59.000Z");
  });

  it("data inexistente: null", () => {
    expect(proximoVencimento("2026-02-30", "mensal")).toBeNull();
    expect(proximoVencimento("amanhã", "mensal")).toBeNull();
  });
});

describe("o prazo liberado pelo pagamento", () => {
  const AGORA = new Date("2026-10-18T12:00:00Z");

  it("o MESMO pagamento (CONFIRMED e depois RECEIVED) dá o MESMO prazo — nada é somado duas vezes", () => {
    const periodo = fimDoAcessoPago({ proximaCobranca: proximoVencimento("2026-10-18", "mensal"), intervalo: "mensal", agora: AGORA });
    const primeira = proximaAssinatura({
      atual: null,
      efeito: { tipo: "pago", periodoAte: periodo },
      eventoCriadoEm: AGORA,
      agora: AGORA,
      carenciaDias: 5,
    });
    if (!primeira.aplicar) throw new Error("deveria aplicar");
    const depois = new Date(AGORA.getTime() + 60_000);
    const segunda = proximaAssinatura({
      atual: { ...primeira.valores },
      efeito: { tipo: "pago", periodoAte: periodo },
      eventoCriadoEm: depois,
      agora: depois,
      carenciaDias: 5,
    });
    if (!segunda.aplicar) throw new Error("deveria aplicar");
    expect(segunda.valores.liberadoAte!.getTime()).toBe(primeira.valores.liberadoAte!.getTime());
    expect(primeira.valores.liberadoAte!.getTime()).toBe(
      new Date("2026-11-18T23:59:59-03:00").getTime() + MARGEM_DE_RENOVACAO_MS,
    );
    expect(primeira.valores.situacao).toBe("ativa");
  });

  it("pagamento muito atrasado (próximo vencimento já passou): cai no intervalo a partir de agora", () => {
    const periodo = fimDoAcessoPago({
      proximaCobranca: proximoVencimento("2026-06-01", "mensal"),
      intervalo: "mensal",
      agora: AGORA,
    });
    expect(periodo!.getTime()).toBe(AGORA.getTime() + 30 * 86_400_000 + MARGEM_DE_RENOVACAO_MS);
  });

  it("sem vencimento nem intervalo não há período — nunca vira acesso vitalício", () => {
    expect(fimDoAcessoPago({ proximaCobranca: null, intervalo: null, agora: AGORA })).toBeNull();
  });
});
