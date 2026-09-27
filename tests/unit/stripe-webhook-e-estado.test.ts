/**
 * O WEBHOOK DO STRIPE: ASSINATURA, MAPEAMENTO E A MÁQUINA DE ESTADOS.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. Corpo alterado ou assinado com outro segredo NUNCA passa. É a única coisa
 *      entre a internet e "conceder acesso pago a qualquer organização".
 *   2. Evento fora de ordem NÃO desfaz o estado. O provedor não garante ordem.
 *   3. Nenhum evento cria uma linha SEM prazo. `liberado_ate` nulo é "sem prazo" =
 *      acesso vitalício, e um evento de falha ou cancelamento sem linha prévia não
 *      pode produzi-lo.
 *   4. A carência conta da PRIMEIRA falha — retentativa não a estende.
 */
import { describe, expect, it } from "vitest";

import {
  assinarParaTeste,
  fimDoPeriodoDaAssinatura,
  fimDoPeriodoDaFatura,
  planejarEfeito,
  proximaAssinatura,
  situacaoDoStatus,
  verificarAssinaturaDoStripe,
  type AssinaturaAtual,
  type EventoDoStripe,
} from "@/lib/planos/stripe/webhook";

const SEGREDO = "whsec_teste_segredo";
const AGORA = new Date("2026-09-26T12:00:00Z");
const T = Math.floor(AGORA.getTime() / 1000);
const s = (d: Date) => Math.floor(d.getTime() / 1000);
const emDias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000);

describe("verificarAssinaturaDoStripe", () => {
  const corpo = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const bom = assinarParaTeste(corpo, SEGREDO, T);
  const v = (o: Partial<Parameters<typeof verificarAssinaturaDoStripe>[0]> = {}) =>
    verificarAssinaturaDoStripe({ corpo, cabecalho: bom, segredo: SEGREDO, agora: AGORA, ...o });

  it("aceita a assinatura correta", () => {
    expect(v()).toEqual({ ok: true });
  });
  it("recusa corpo alterado por UM caractere", () => {
    expect(v({ corpo: corpo.replace("evt_1", "evt_2") })).toEqual({ ok: false, motivo: "assinatura_invalida" });
  });
  it("recusa outro segredo", () => {
    expect(v({ segredo: "whsec_outro" })).toEqual({ ok: false, motivo: "assinatura_invalida" });
  });
  it("recusa cabeçalho ausente", () => {
    expect(v({ cabecalho: null })).toEqual({ ok: false, motivo: "cabecalho_ausente" });
  });
  it.each(["", "lixo", "t=abc,v1=00", "t=123", "v1=abcd", "t=123,v1=nao-hex"])(
    "recusa cabeçalho malformado %j sem lançar",
    (c) => {
      expect(v({ cabecalho: c }).ok).toBe(false);
    },
  );
  it("hex de tamanho errado NÃO lança (timingSafeEqual lançaria) — é entrada hostil, não 500", () => {
    expect(() => v({ cabecalho: `t=${T},v1=abcd` })).not.toThrow();
    expect(v({ cabecalho: `t=${T},v1=abcd` })).toEqual({ ok: false, motivo: "assinatura_invalida" });
  });
  it("recusa replay: assinatura válida, mas de 10 minutos atrás", () => {
    const velho = assinarParaTeste(corpo, SEGREDO, T - 600);
    expect(v({ cabecalho: velho })).toEqual({ ok: false, motivo: "fora_da_tolerancia" });
  });
  it("recusa timestamp do FUTURO além da tolerância", () => {
    expect(v({ cabecalho: assinarParaTeste(corpo, SEGREDO, T + 600) })).toEqual({ ok: false, motivo: "fora_da_tolerancia" });
  });
  it("aceita dentro da tolerância", () => {
    expect(v({ cabecalho: assinarParaTeste(corpo, SEGREDO, T - 120) })).toEqual({ ok: true });
  });
  it("aceita QUALQUER um dos v1 (rotação de segredo)", () => {
    const cab = `t=${T},v1=${"0".repeat(64)},v1=${bom.split("v1=")[1]}`;
    expect(v({ cabecalho: cab })).toEqual({ ok: true });
  });
  it("o corpo reserializado NÃO casa — é por isso que a rota lê o texto cru", () => {
    // O caso clássico: parsear e serializar de volta muda espaços e ordem.
    const reserializado = JSON.stringify(JSON.parse(`{ "id": "evt_1",  "type": "invoice.paid" }`));
    const assinadoNoBrutoComEspacos = assinarParaTeste(`{ "id": "evt_1",  "type": "invoice.paid" }`, SEGREDO, T);
    expect(v({ corpo: reserializado, cabecalho: assinadoNoBrutoComEspacos }).ok).toBe(false);
  });
});

function evento(type: string, objeto: Record<string, unknown>, criado = T): EventoDoStripe {
  return { id: `evt_${type}_${criado}`, type, created: criado, livemode: false, data: { object: objeto } };
}

describe("planejarEfeito", () => {
  it("checkout de assinatura só VINCULA — não concede acesso (Pix completa antes do dinheiro)", () => {
    const e = planejarEfeito(evento("checkout.session.completed", { id: "cs_1", mode: "subscription", customer: "cus_1", subscription: "sub_1" }));
    expect(e).toEqual({ tipo: "vincular_checkout", sessaoId: "cs_1", clienteId: "cus_1", assinaturaId: "sub_1" });
  });
  it("checkout que não é de assinatura é ignorado", () => {
    expect(planejarEfeito(evento("checkout.session.completed", { id: "cs_1", mode: "payment" })).tipo).toBe("ignorar");
  });
  it("aceita customer/subscription tanto como id quanto como objeto expandido", () => {
    const e = planejarEfeito(evento("checkout.session.completed", { id: "cs_1", mode: "subscription", customer: { id: "cus_9" }, subscription: { id: "sub_9" } }));
    expect(e).toMatchObject({ clienteId: "cus_9", assinaturaId: "sub_9" });
  });
  it("subscription.deleted vira status canceled, qualquer que fosse o status no objeto", () => {
    const e = planejarEfeito(evento("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "active" }));
    expect(e).toMatchObject({ tipo: "assinatura", status: "canceled" });
  });
  it("invoice: a assinatura vem do campo direto (API antiga)", () => {
    const e = planejarEfeito(evento("invoice.paid", { id: "in_1", customer: "cus_1", subscription: "sub_1", lines: { data: [{ period: { end: s(emDias(30)) } }] } }));
    expect(e).toMatchObject({ tipo: "fatura_paga", assinaturaId: "sub_1" });
  });
  it("invoice: a assinatura vem de parent.subscription_details (API nova)", () => {
    const e = planejarEfeito(evento("invoice.paid", { id: "in_1", customer: "cus_1", parent: { subscription_details: { subscription: "sub_7" } }, lines: { data: [] } }));
    expect(e).toMatchObject({ assinaturaId: "sub_7" });
  });
  it("tipo desconhecido é ignorado, nunca lança", () => {
    expect(planejarEfeito(evento("charge.refunded", {}))).toEqual({ tipo: "ignorar", porque: "tipo_nao_tratado" });
  });
});

describe("os fins de período — as duas formas da API", () => {
  it("current_period_end no objeto (API antiga)", () => {
    expect(fimDoPeriodoDaAssinatura({ current_period_end: s(emDias(30)) })?.toISOString()).toBe(emDias(30).toISOString().replace(/\.\d+Z$/, ".000Z"));
  });
  it("current_period_end nos ITENS (API nova); vale o MAIOR", () => {
    const f = fimDoPeriodoDaAssinatura({ items: { data: [{ current_period_end: s(emDias(10)) }, { current_period_end: s(emDias(40)) }] } });
    expect(Math.round((f!.getTime() - AGORA.getTime()) / 86_400_000)).toBe(40);
  });
  it("sem nenhuma data: null (e a máquina recusa criar linha)", () => {
    expect(fimDoPeriodoDaAssinatura({})).toBeNull();
    expect(fimDoPeriodoDaFatura({ lines: { data: [] } })).toBeNull();
  });
  it("fatura: o maior period.end das linhas", () => {
    const f = fimDoPeriodoDaFatura({ lines: { data: [{ period: { end: s(emDias(5)) } }, { period: { end: s(emDias(35)) } }] } });
    expect(Math.round((f!.getTime() - AGORA.getTime()) / 86_400_000)).toBe(35);
  });
});

describe("situacaoDoStatus", () => {
  it.each([
    ["active", "ativa"], ["trialing", "ativa"],
    ["past_due", "inadimplente"], ["unpaid", "inadimplente"], ["paused", "inadimplente"],
    ["canceled", "cancelada"], ["incomplete_expired", "cancelada"],
    ["incomplete", null], ["desconhecido", null],
  ] as const)("%s → %s", (status, esperado) => {
    expect(situacaoDoStatus(status)).toBe(esperado);
  });
});

describe("proximaAssinatura — a máquina de estados", () => {
  const atual = (p: Partial<AssinaturaAtual> = {}): AssinaturaAtual => ({
    situacao: "ativa", liberadoAte: emDias(10), carenciaAte: null, canceladaEm: null, ultimoEventoEm: new Date(AGORA.getTime() - 3_600_000), ...p,
  });
  const roda = (a: AssinaturaAtual | null, efeito: Parameters<typeof proximaAssinatura>[0]["efeito"], criado = AGORA) =>
    proximaAssinatura({ atual: a, efeito, eventoCriadoEm: criado, agora: AGORA, carenciaDias: 5 });

  it("1ª ativação: SEM linha, assinatura ativa COM período cria a linha com o prazo", () => {
    const t = roda(null, { tipo: "assinatura", assinaturaId: "sub_1", clienteId: "cus_1", status: "active", periodoAte: emDias(30) });
    expect(t).toMatchObject({ aplicar: true, valores: { situacao: "ativa", carenciaAte: null } });
    if (t.aplicar) expect(t.valores.liberadoAte?.toISOString()).toBe(emDias(30).toISOString());
  });

  it("SEM linha e SEM período: recusa criar — uma linha ativa sem data seria vitalícia", () => {
    expect(roda(null, { tipo: "assinatura", assinaturaId: "s", clienteId: null, status: "active", periodoAte: null }))
      .toEqual({ aplicar: false, motivo: "sem_periodo" });
  });

  it.each([
    ["falha de pagamento", { tipo: "fatura_falhou", assinaturaId: "s", clienteId: null } as const],
    ["cancelamento", { tipo: "assinatura", assinaturaId: "s", clienteId: null, status: "canceled", periodoAte: null } as const],
    ["past_due", { tipo: "assinatura", assinaturaId: "s", clienteId: null, status: "past_due", periodoAte: emDias(5) } as const],
  ])("SEM linha, %s NÃO cria linha (nasceria sem prazo = vitalício)", (_n, efeito) => {
    expect(roda(null, efeito)).toEqual({ aplicar: false, motivo: "sem_assinatura" });
  });

  it("renovação: invoice.paid empurra o prazo para o novo fim", () => {
    const t = roda(atual(), { tipo: "fatura_paga", assinaturaId: "s", clienteId: null, periodoAte: emDias(40) });
    expect(t.aplicar && t.valores.liberadoAte?.toISOString()).toBe(emDias(40).toISOString());
  });

  it("invoice.paid ATRASADA nunca ENCURTA o prazo (vale o maior)", () => {
    const t = roda(atual({ liberadoAte: emDias(60) }), { tipo: "fatura_paga", assinaturaId: "s", clienteId: null, periodoAte: emDias(30) });
    expect(t.aplicar && t.valores.liberadoAte?.toISOString()).toBe(emDias(60).toISOString());
  });

  it("pagamento que volta LIMPA a carência e volta a ativa", () => {
    const t = roda(atual({ situacao: "inadimplente", carenciaAte: emDias(2) }), { tipo: "fatura_paga", assinaturaId: "s", clienteId: null, periodoAte: emDias(30) });
    expect(t).toMatchObject({ aplicar: true, valores: { situacao: "ativa", carenciaAte: null } });
  });

  it("1ª falha: abre a carência de N dias a partir de AGORA", () => {
    const t = roda(atual(), { tipo: "fatura_falhou", assinaturaId: "s", clienteId: null });
    expect(t).toMatchObject({ aplicar: true, valores: { situacao: "inadimplente" } });
    if (t.aplicar) expect(t.valores.carenciaAte?.toISOString()).toBe(emDias(5).toISOString());
  });

  it("RETENTATIVA não estende a carência — senão um cartão que nunca passa nunca vence", () => {
    const original = emDias(2);
    const t = roda(atual({ situacao: "inadimplente", carenciaAte: original }), { tipo: "fatura_falhou", assinaturaId: "s", clienteId: null });
    expect(t.aplicar && t.valores.carenciaAte?.toISOString()).toBe(original.toISOString());
  });

  it("cancelamento: mantém liberado_ate (não concede mais) e carimba cancelada_em", () => {
    const t = roda(atual(), { tipo: "assinatura", assinaturaId: "s", clienteId: null, status: "canceled", periodoAte: null });
    expect(t).toMatchObject({ aplicar: true, valores: { situacao: "cancelada", carenciaAte: null } });
    if (t.aplicar) {
      expect(t.valores.liberadoAte?.toISOString()).toBe(emDias(10).toISOString());
      expect(t.valores.canceladaEm?.toISOString()).toBe(AGORA.toISOString());
    }
  });

  it("falha de fatura DEPOIS do cancelamento não ressuscita nada", () => {
    expect(roda(atual({ situacao: "cancelada" }), { tipo: "fatura_falhou", assinaturaId: "s", clienteId: null }))
      .toEqual({ aplicar: false, motivo: "sem_efeito" });
  });

  it("EVENTO FORA DE ORDEM é ignorado: subscription.updated atrasado não descancela", () => {
    const cancelada = atual({ situacao: "cancelada", ultimoEventoEm: AGORA });
    const antigo = new Date(AGORA.getTime() - 60_000);
    expect(roda(cancelada, { tipo: "assinatura", assinaturaId: "s", clienteId: null, status: "active", periodoAte: emDias(30) }, antigo))
      .toEqual({ aplicar: false, motivo: "fora_de_ordem" });
  });

  it("evento com o MESMO timestamp do último é aplicado (empate não é fora de ordem)", () => {
    const t = roda(atual({ ultimoEventoEm: AGORA }), { tipo: "fatura_paga", assinaturaId: "s", clienteId: null, periodoAte: emDias(30) }, AGORA);
    expect(t.aplicar).toBe(true);
  });

  it("ultimo_evento_em nunca anda para trás", () => {
    const t = roda(atual({ ultimoEventoEm: emDias(1) }), { tipo: "fatura_paga", assinaturaId: "s", clienteId: null, periodoAte: emDias(30) }, emDias(2));
    expect(t.aplicar && t.valores.ultimoEventoEm.toISOString()).toBe(emDias(2).toISOString());
  });

  it("status incomplete não tem efeito", () => {
    expect(roda(atual(), { tipo: "assinatura", assinaturaId: "s", clienteId: null, status: "incomplete", periodoAte: null }))
      .toEqual({ aplicar: false, motivo: "sem_efeito" });
  });

  it("vincular_checkout e ignorar nunca mexem na assinatura", () => {
    expect(roda(atual(), { tipo: "vincular_checkout", sessaoId: "cs", clienteId: null, assinaturaId: null }).aplicar).toBe(false);
    expect(roda(atual(), { tipo: "ignorar", porque: "x" }).aplicar).toBe(false);
  });
});
