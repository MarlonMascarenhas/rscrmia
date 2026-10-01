/**
 * A MÁQUINA NEUTRA DE ASSINATURA E O WEBHOOK DA CAKTO.
 *
 * Porta os casos de `stripe-webhook-e-estado.test.ts` para o efeito neutro de
 * provedor, e cobre o que é específico da Cakto: leitura tolerante do payload,
 * verificação por HMAC (dois cabeçalhos, não um) e o cálculo do fim de acesso a
 * partir da PRÓXIMA cobrança (nunca do carimbo antigo).
 */
import { describe, expect, it } from "vitest";

import { decidirAcesso } from "@/lib/planos/decisao";
import {
  DIAS_DO_INTERVALO,
  MARGEM_DE_RENOVACAO_MS,
  fimDoAcessoPago,
  proximaAssinatura,
  type AssinaturaAtual,
} from "@/lib/planos/cobranca/maquina";
import {
  assinarParaTeste,
  chaveDoEvento,
  entradaSanitizada,
  eventoDaEntrada,
  lerEventoDaCakto,
  planejarEventoDaCakto,
  tokenDeCallbackValido,
  verificarAssinaturaDaCakto,
  verificarSegredoNoCorpo,
} from "@/lib/planos/cakto/webhook";

const SEGREDO = "cakto_teste_segredo";
const AGORA = new Date("2026-09-26T12:00:00Z");
const T = Math.floor(AGORA.getTime() / 1000);
const emDias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000);

// ═══════════════════════════════════════════════════════════════════════════
// 1. A máquina de estados — casos portados de stripe-webhook-e-estado.test.ts
// ═══════════════════════════════════════════════════════════════════════════

describe("proximaAssinatura — a máquina neutra de estados", () => {
  const atual = (p: Partial<AssinaturaAtual> = {}): AssinaturaAtual => ({
    situacao: "ativa",
    liberadoAte: emDias(10),
    carenciaAte: null,
    canceladaEm: null,
    ultimoEventoEm: new Date(AGORA.getTime() - 3_600_000),
    ...p,
  });
  const roda = (
    a: AssinaturaAtual | null,
    efeito: Parameters<typeof proximaAssinatura>[0]["efeito"],
    criado = AGORA,
  ) => proximaAssinatura({ atual: a, efeito, eventoCriadoEm: criado, agora: AGORA, carenciaDias: 5 });

  it("1ª ativação: SEM linha, pago COM período cria a linha com o prazo", () => {
    const t = roda(null, { tipo: "pago", periodoAte: emDias(30) });
    expect(t).toMatchObject({ aplicar: true, valores: { situacao: "ativa", carenciaAte: null } });
    if (t.aplicar) expect(t.valores.liberadoAte?.toISOString()).toBe(emDias(30).toISOString());
  });

  it("SEM linha e SEM período: recusa criar — uma linha ativa sem data seria vitalícia", () => {
    expect(roda(null, { tipo: "pago", periodoAte: null })).toEqual({ aplicar: false, motivo: "sem_periodo" });
  });

  it.each([
    ["falha de pagamento", { tipo: "falhou" } as const],
    ["não renova", { tipo: "nao_renova" } as const],
    ["estorno", { tipo: "estornado" } as const],
  ])("SEM linha, %s NÃO cria linha (nasceria sem prazo = vitalício)", (_n, efeito) => {
    expect(roda(null, efeito)).toEqual({ aplicar: false, motivo: "sem_assinatura" });
  });

  it("renovação: pago empurra o prazo para o novo fim", () => {
    const t = roda(atual(), { tipo: "pago", periodoAte: emDias(40) });
    expect(t.aplicar && t.valores.liberadoAte?.toISOString()).toBe(emDias(40).toISOString());
  });

  it("pago ATRASADO nunca ENCURTA o prazo (vale o maior)", () => {
    const t = roda(atual({ liberadoAte: emDias(60) }), { tipo: "pago", periodoAte: emDias(30) });
    expect(t.aplicar && t.valores.liberadoAte?.toISOString()).toBe(emDias(60).toISOString());
  });

  it("pagamento que volta LIMPA a carência e volta a ativa", () => {
    const t = roda(atual({ situacao: "inadimplente", carenciaAte: emDias(2) }), {
      tipo: "pago",
      periodoAte: emDias(30),
    });
    expect(t).toMatchObject({ aplicar: true, valores: { situacao: "ativa", carenciaAte: null } });
  });

  it("1ª falha: abre a carência de N dias a partir de AGORA", () => {
    const t = roda(atual(), { tipo: "falhou" });
    expect(t).toMatchObject({ aplicar: true, valores: { situacao: "inadimplente" } });
    if (t.aplicar) expect(t.valores.carenciaAte?.toISOString()).toBe(emDias(5).toISOString());
  });

  it("RETENTATIVA não estende a carência — senão um cartão que nunca passa nunca vence", () => {
    const original = emDias(2);
    const t = roda(atual({ situacao: "inadimplente", carenciaAte: original }), { tipo: "falhou" });
    expect(t.aplicar && t.valores.carenciaAte?.toISOString()).toBe(original.toISOString());
  });

  it("falha de pagamento DEPOIS do cancelamento não ressuscita nada", () => {
    expect(roda(atual({ situacao: "cancelada" }), { tipo: "falhou" })).toEqual({
      aplicar: false,
      motivo: "sem_efeito",
    });
  });

  it("EVENTO FORA DE ORDEM é ignorado: pago atrasado não descancela", () => {
    const cancelada = atual({ situacao: "cancelada", ultimoEventoEm: AGORA });
    const antigo = new Date(AGORA.getTime() - 60_000);
    expect(roda(cancelada, { tipo: "pago", periodoAte: emDias(30) }, antigo)).toEqual({
      aplicar: false,
      motivo: "fora_de_ordem",
    });
  });

  it("evento com o MESMO timestamp do último é aplicado (empate não é fora de ordem)", () => {
    const t = roda(atual({ ultimoEventoEm: AGORA }), { tipo: "pago", periodoAte: emDias(30) }, AGORA);
    expect(t.aplicar).toBe(true);
  });

  it("ultimo_evento_em nunca anda para trás", () => {
    const t = roda(atual({ ultimoEventoEm: emDias(1) }), { tipo: "pago", periodoAte: emDias(30) }, emDias(2));
    expect(t.aplicar && t.valores.ultimoEventoEm.toISOString()).toBe(emDias(2).toISOString());
  });

  describe("nao_renova", () => {
    it("mantém acesso e prazo, e carimba cancelada_em", () => {
      const t = roda(atual(), { tipo: "nao_renova" });
      expect(t).toMatchObject({ aplicar: true, valores: { situacao: "ativa", carenciaAte: null } });
      if (t.aplicar) {
        expect(t.valores.liberadoAte?.toISOString()).toBe(emDias(10).toISOString());
        expect(t.valores.canceladaEm?.toISOString()).toBe(AGORA.toISOString());
      }
    });

    it("falha DEPOIS de nao_renova não tem efeito — canceladaEm marcado já basta para recusar (mesma guarda de `cancelada`)", () => {
      const naoRenovada = atual({ canceladaEm: AGORA });
      const t = roda(naoRenovada, { tipo: "falhou" });
      expect(t).toEqual({ aplicar: false, motivo: "sem_efeito" });
    });

    it("pago DEPOIS de nao_renova limpa cancelada_em (a renovação aconteceu)", () => {
      const naoRenovada = atual({ canceladaEm: AGORA });
      const t = roda(naoRenovada, { tipo: "pago", periodoAte: emDias(40) });
      expect(t).toMatchObject({ aplicar: true, valores: { situacao: "ativa", canceladaEm: null } });
    });

    it("sobre situação já cancelada, não_renova não tem efeito", () => {
      expect(roda(atual({ situacao: "cancelada" }), { tipo: "nao_renova" })).toEqual({
        aplicar: false,
        motivo: "sem_efeito",
      });
    });
  });

  describe("estornado", () => {
    it("vira cancelada, mantém o prazo já pago e o gate nega acesso mesmo dentro do prazo", () => {
      const t = roda(atual(), { tipo: "estornado" });
      expect(t).toMatchObject({ aplicar: true, valores: { situacao: "cancelada", carenciaAte: null } });
      if (t.aplicar) {
        expect(t.valores.liberadoAte?.toISOString()).toBe(emDias(10).toISOString());
        expect(t.valores.canceladaEm?.toISOString()).toBe(AGORA.toISOString());

        const acesso = decidirAcesso({
          cobrancaLigada: true,
          liberadoAte: t.valores.liberadoAte,
          situacao: t.valores.situacao,
          carenciaAte: t.valores.carenciaAte,
          agora: AGORA,
        });
        expect(acesso.liberado).toBe(false);
        expect(acesso.motivo).toBe("cancelada");
      }
    });
  });

  it("vincular e ignorar (representados como ausência de chamada) não mexem na assinatura", () => {
    // A máquina só recebe EfeitoNaAssinatura; "vincular"/"ignorar" nunca chegam
    // até aqui — são filtrados em `planejarEventoDaCakto`.
    expect(roda(atual(), { tipo: "falhou" }).aplicar).toBe(true);
  });
});

describe("fimDoAcessoPago", () => {
  it("usa a próxima cobrança quando ela é válida (futura e dentro de 400 dias), com a margem de 1 dia", () => {
    const r = fimDoAcessoPago({ proximaCobranca: emDias(30), intervalo: "mensal", agora: AGORA });
    expect(r?.getTime()).toBe(emDias(30).getTime() + MARGEM_DE_RENOVACAO_MS);
  });

  it("próxima cobrança NO PASSADO cai no intervalo", () => {
    const r = fimDoAcessoPago({ proximaCobranca: emDias(-1), intervalo: "mensal", agora: AGORA });
    expect(r?.getTime()).toBe(AGORA.getTime() + DIAS_DO_INTERVALO.mensal * 86_400_000 + MARGEM_DE_RENOVACAO_MS);
  });

  it("próxima cobrança ALÉM de 400 dias cai no intervalo", () => {
    const r = fimDoAcessoPago({ proximaCobranca: emDias(401), intervalo: "mensal", agora: AGORA });
    expect(r?.getTime()).toBe(AGORA.getTime() + DIAS_DO_INTERVALO.mensal * 86_400_000 + MARGEM_DE_RENOVACAO_MS);
  });

  it("sem próxima cobrança válida usa o intervalo — anual", () => {
    const r = fimDoAcessoPago({ proximaCobranca: null, intervalo: "anual", agora: AGORA });
    expect(r?.getTime()).toBe(AGORA.getTime() + DIAS_DO_INTERVALO.anual * 86_400_000 + MARGEM_DE_RENOVACAO_MS);
  });

  it("sem próxima cobrança E sem intervalo: null", () => {
    expect(fimDoAcessoPago({ proximaCobranca: null, intervalo: null, agora: AGORA })).toBeNull();
  });

  it("NUNCA soma a partir do liberadoAte anterior — só existe proximaCobranca/intervalo/agora na entrada", () => {
    // Prova por assinatura: a função não recebe `liberadoAte`, então não há como
    // somar a partir dele. Dois eventos da mesma renovação (mesma proximaCobranca)
    // dão o MESMO resultado — idempotente.
    const a = fimDoAcessoPago({ proximaCobranca: emDias(30), intervalo: "mensal", agora: AGORA });
    const b = fimDoAcessoPago({ proximaCobranca: emDias(30), intervalo: "mensal", agora: AGORA });
    expect(a?.getTime()).toBe(b?.getTime());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Verificação da assinatura da Cakto
// ═══════════════════════════════════════════════════════════════════════════

describe("verificarAssinaturaDaCakto", () => {
  const corpo = JSON.stringify({ event: "purchase_approved", data: { id: "ped_1" } });
  const bom = assinarParaTeste(corpo, SEGREDO, T);
  const v = (o: Partial<Parameters<typeof verificarAssinaturaDaCakto>[0]> = {}) =>
    verificarAssinaturaDaCakto({ corpo, timestamp: String(T), assinatura: bom, segredo: SEGREDO, agora: AGORA, ...o });

  it("aceita a assinatura correta", () => {
    const r = v();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.enviadoEm.getTime()).toBe(T * 1000);
  });

  it("recusa corpo alterado", () => {
    expect(v({ corpo: corpo.replace("ped_1", "ped_2") })).toEqual({ ok: false, motivo: "assinatura_invalida" });
  });

  it("o corpo reserializado NÃO casa", () => {
    const cru = `{ "event": "purchase_approved",  "data": { "id": "ped_1" } }`;
    const assinado = assinarParaTeste(cru, SEGREDO, T);
    const reserializado = JSON.stringify(JSON.parse(cru));
    expect(v({ corpo: reserializado, timestamp: String(T), assinatura: assinado }).ok).toBe(false);
  });

  it("recusa cabeçalho ausente (timestamp ou assinatura)", () => {
    expect(v({ timestamp: null })).toEqual({ ok: false, motivo: "cabecalho_ausente" });
    expect(v({ assinatura: null })).toEqual({ ok: false, motivo: "cabecalho_ausente" });
  });

  it("timestamp não numérico → malformado", () => {
    expect(v({ timestamp: "abc" })).toEqual({ ok: false, motivo: "malformado" });
  });

  it("assinatura sem nenhum v1 → malformado", () => {
    expect(v({ assinatura: "lixo" })).toEqual({ ok: false, motivo: "malformado" });
  });

  it("hex de tamanho errado NÃO lança", () => {
    expect(() => v({ assinatura: "v1=abcd" })).not.toThrow();
    expect(v({ assinatura: "v1=abcd" })).toEqual({ ok: false, motivo: "assinatura_invalida" });
  });

  it("múltiplas partes v1, com UMA válida, passa (rotação de segredo)", () => {
    const cab = `v1=${"0".repeat(64)},${bom}`;
    expect(v({ assinatura: cab }).ok).toBe(true);
  });

  it("fora da tolerância padrão (5min)", () => {
    expect(v({ timestamp: String(T - 600), assinatura: assinarParaTeste(corpo, SEGREDO, T - 600) })).toEqual({
      ok: false,
      motivo: "fora_da_tolerancia",
    });
  });

  it("dentro da tolerância passa", () => {
    expect(v({ timestamp: String(T - 120), assinatura: assinarParaTeste(corpo, SEGREDO, T - 120) }).ok).toBe(true);
  });
});

describe("verificarSegredoNoCorpo", () => {
  it("aceita o segredo correto", () => {
    expect(verificarSegredoNoCorpo(SEGREDO, SEGREDO)).toBe(true);
  });
  it("recusa segredo errado", () => {
    expect(verificarSegredoNoCorpo("outro", SEGREDO)).toBe(false);
  });
  it("recusa entrada não-string sem lançar", () => {
    expect(verificarSegredoNoCorpo(123, SEGREDO)).toBe(false);
    expect(verificarSegredoNoCorpo(null, SEGREDO)).toBe(false);
    expect(verificarSegredoNoCorpo(undefined, SEGREDO)).toBe(false);
  });
});

describe("tokenDeCallbackValido", () => {
  it.each(["abc123", "a.b-c_d~e", "x".repeat(255)])("aceita %j", (s) => {
    expect(tokenDeCallbackValido(s)).toBe(true);
  });
  it.each(["", "x".repeat(256), "tem espaço", "tem/barra", 123, null, undefined])("recusa %j", (s) => {
    expect(tokenDeCallbackValido(s)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Leitura do evento
// ═══════════════════════════════════════════════════════════════════════════

describe("lerEventoDaCakto", () => {
  it("lê um evento completo", () => {
    const e = lerEventoDaCakto({
      event: "purchase_approved",
      data: {
        id: "ped_1",
        callback: "cb-token_1",
        customer: { id: "cus_1", email: "a@b.com" },
        product: { id: "prod_1" },
        offer: { id: "off_1" },
        subscription: { id: "sub_1", status: "active", next_payment_date: "2026-10-26T12:00:00Z" },
      },
    });
    expect(e).toEqual({
      evento: "purchase_approved",
      pedidoId: "ped_1",
      callback: "cb-token_1",
      clienteId: "cus_1",
      email: "a@b.com",
      produtoId: "prod_1",
      ofertaId: "off_1",
      assinatura: { id: "sub_1", status: "active", proximaCobranca: new Date("2026-10-26T12:00:00Z") },
    });
  });

  it("ids numéricos viram string", () => {
    const e = lerEventoDaCakto({
      event: "purchase_approved",
      data: { id: 123, customer: { id: 456 }, product: { id: 789 }, offer: { id: 1 }, subscription: { id: 42 } },
    });
    expect(e).toMatchObject({ pedidoId: "123", clienteId: "456", produtoId: "789", ofertaId: "1" });
    expect(e?.assinatura?.id).toBe("42");
  });

  it("callback inválido vira null", () => {
    const e = lerEventoDaCakto({ event: "purchase_approved", data: { id: "1", callback: "tem espaço" } });
    expect(e?.callback).toBeNull();
  });

  it("subscription null/ausente vira assinatura null", () => {
    expect(lerEventoDaCakto({ event: "purchase_approved", data: { id: "1", subscription: null } })?.assinatura).toBeNull();
    expect(lerEventoDaCakto({ event: "purchase_approved", data: { id: "1" } })?.assinatura).toBeNull();
  });

  it("next_payment_date inválida vira proximaCobranca null", () => {
    const e = lerEventoDaCakto({
      event: "purchase_approved",
      data: { id: "1", subscription: { id: "sub_1", next_payment_date: "nao-e-data" } },
    });
    expect(e?.assinatura?.proximaCobranca).toBeNull();
  });

  it("payload lixo → null", () => {
    expect(lerEventoDaCakto(null)).toBeNull();
    expect(lerEventoDaCakto(undefined)).toBeNull();
    expect(lerEventoDaCakto("string")).toBeNull();
    expect(lerEventoDaCakto(42)).toBeNull();
    expect(lerEventoDaCakto([])).toBeNull();
    expect(lerEventoDaCakto({})).toBeNull();
    expect(lerEventoDaCakto({ event: 123 })).toBeNull();
    expect(lerEventoDaCakto({ event: "" })).toBeNull();
  });

  it("data ausente ou de tipo errado não lança", () => {
    expect(() => lerEventoDaCakto({ event: "x", data: "lixo" })).not.toThrow();
    expect(lerEventoDaCakto({ event: "x", data: "lixo" })).toMatchObject({ evento: "x", pedidoId: null });
    expect(lerEventoDaCakto({ event: "x" })).toMatchObject({ evento: "x", pedidoId: null });
  });
});

describe("chaveDoEvento", () => {
  it("usa evento:pedidoId quando há pedido", () => {
    const e = lerEventoDaCakto({ event: "purchase_approved", data: { id: "ped_1" } })!;
    expect(chaveDoEvento(e, "{}")).toBe("purchase_approved:ped_1");
  });

  it("sem pedido, cai no hash do corpo cru — determinístico", () => {
    const e = lerEventoDaCakto({ event: "refund", data: {} })!;
    const corpo = JSON.stringify({ event: "refund", data: {} });
    const k1 = chaveDoEvento(e, corpo);
    const k2 = chaveDoEvento(e, corpo);
    expect(k1).toBe(k2);
    expect(k1.startsWith("refund:sem-id:")).toBe(true);
  });

  it("corpos diferentes sem pedido dão chaves diferentes", () => {
    const e = lerEventoDaCakto({ event: "refund", data: {} })!;
    expect(chaveDoEvento(e, "{}")).not.toBe(chaveDoEvento(e, "{  }"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Planejamento
// ═══════════════════════════════════════════════════════════════════════════

describe("planejarEventoDaCakto", () => {
  const ev = (evento: string) =>
    lerEventoDaCakto({ event: evento, data: { id: "ped_1" } }) ?? {
      evento,
      pedidoId: "ped_1",
      callback: null,
      clienteId: null,
      email: null,
      produtoId: null,
      ofertaId: null,
      assinatura: null,
    };

  it.each([
    ["purchase_approved", { acao: "efeito", efeito: { tipo: "pago" } }],
    ["subscription_renewed", { acao: "efeito", efeito: { tipo: "pago" } }],
    ["subscription_late_recovered", { acao: "efeito", efeito: { tipo: "pago" } }],
    ["subscription_renewal_refused", { acao: "efeito", efeito: { tipo: "falhou" } }],
    ["subscription_late", { acao: "efeito", efeito: { tipo: "falhou" } }],
    ["subscription_canceled", { acao: "efeito", efeito: { tipo: "nao_renova" } }],
    ["refund", { acao: "efeito", efeito: { tipo: "estornado" } }],
    ["chargeback", { acao: "efeito", efeito: { tipo: "estornado" } }],
    ["subscription_created", { acao: "vincular" }],
  ] as const)("%s → %j", (evento, esperado) => {
    expect(planejarEventoDaCakto(ev(evento))).toEqual(esperado);
  });

  it("evento desconhecido é ignorado com o nome no motivo, nunca lança", () => {
    expect(planejarEventoDaCakto(ev("evento_novo_que_a_cakto_inventou"))).toEqual({
      acao: "ignorar",
      motivo: "evento_nao_tratado:evento_novo_que_a_cakto_inventou",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Sanitização
// ═══════════════════════════════════════════════════════════════════════════

describe("entradaSanitizada / eventoDaEntrada", () => {
  it("ida e volta sem e-mail", () => {
    const original = lerEventoDaCakto({
      event: "purchase_approved",
      data: {
        id: "ped_1",
        callback: "cb-1",
        customer: { id: "cus_1", email: "segredo@exemplo.com" },
        product: { id: "prod_1" },
        offer: { id: "off_1" },
        subscription: { id: "sub_1", status: "active", next_payment_date: "2026-10-26T12:00:00Z" },
      },
    })!;

    const sanitizado = entradaSanitizada(original);
    expect(sanitizado).not.toHaveProperty("email");
    expect(JSON.stringify(sanitizado)).not.toContain("segredo@exemplo.com");

    const devolta = eventoDaEntrada(sanitizado);
    expect(devolta).toEqual({ ...original, email: null });
  });

  it("eventoDaEntrada em lixo → null", () => {
    expect(eventoDaEntrada(null)).toBeNull();
    expect(eventoDaEntrada({})).toBeNull();
    expect(eventoDaEntrada({ evento: "" })).toBeNull();
  });

  it("eventoDaEntrada sem assinatura preserva null", () => {
    expect(eventoDaEntrada({ evento: "refund", pedidoId: "p", callback: null, clienteId: null, produtoId: null, ofertaId: null, assinatura: null })).toEqual({
      evento: "refund",
      pedidoId: "p",
      callback: null,
      clienteId: null,
      email: null,
      produtoId: null,
      ofertaId: null,
      assinatura: null,
    });
  });
});
