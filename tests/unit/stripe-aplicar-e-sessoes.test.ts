/**
 * O APLICADOR DE EVENTOS, O CLIENTE E AS SESSÕES DO STRIPE — COM BANCO E REDE DUBLADOS.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. A organização sai de DADO NOSSO. Evento cujo cliente/assinatura/sessão não
 *      está em nossas tabelas é `sem_organizacao` — nunca adivinhado, e nunca
 *      resolvido por metadata do payload.
 *   2. O checkout só VINCULA: não toca em `assinaturas`. Uma linha criada aí, sem
 *      prazo, viraria "sem prazo" = acesso vitalício.
 *   3. Rascunho e arquivado NÃO se compram, nem por URL adivinhada.
 *   4. O `Price` é criado UMA vez, com chave de idempotência derivada da linha.
 *   5. Se o registro do checkout falha, o link NÃO é entregue — cobraria sem liberar.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { processarEventoDoStripe } from "@/lib/planos/stripe/aplicar";
import {
  codificarFormulario,
  modoDaChave,
  stripePronto,
} from "@/lib/planos/stripe/cliente";
import {
  cancelarNoFimDoPeriodo,
  criarCheckout,
  criarPortal,
} from "@/lib/planos/stripe/sessoes";
import type { EventoDoStripe } from "@/lib/planos/stripe/webhook";

import { dbFalso } from "./helpers/db-falso-planos";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-09-26T12:00:00Z");
const T = Math.floor(AGORA.getTime() / 1000);
const s = (dias: number) => Math.floor((AGORA.getTime() + dias * 86_400_000) / 1000);

function evento(type: string, objeto: Record<string, unknown>, criado = T): EventoDoStripe {
  return { id: "evt_1", type, created: criado, livemode: false, data: { object: objeto } };
}

describe("processarEventoDoStripe — de quem é o pagamento", () => {
  it("tipo que não tratamos: ignora sem tocar em nenhuma tabela", async () => {
    const { db, consultas } = dbFalso({});
    const r = await processarEventoDoStripe(db, evento("charge.refunded", {}), { agora: AGORA, carenciaDias: 5 });
    expect(r.resultado).toBe("ignorado_tipo");
    expect(consultas).toEqual([]);
  });

  it("checkout de sessão DESCONHECIDA: sem_organizacao — nunca adivinha", async () => {
    const { db, escritas } = dbFalso({ cobranca_checkouts: { data: null } });
    const r = await processarEventoDoStripe(
      db,
      // O payload até TRAZ uma organização em metadata: ela é ignorada de propósito.
      evento("checkout.session.completed", { id: "cs_x", mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: { organization_id: ORG } }),
      { agora: AGORA, carenciaDias: 5 },
    );
    expect(r).toMatchObject({ resultado: "sem_organizacao", organizationId: null });
    expect(escritas).toEqual([]);
  });

  it("checkout conhecido: só VINCULA cliente e assinatura ao checkout — não escreve em assinaturas", async () => {
    const { db, escritas } = dbFalso({ cobranca_checkouts: { data: { session_id: "cs_1", organization_id: ORG, plano_id: "p", preco_id: "pr" } } });
    const r = await processarEventoDoStripe(
      db,
      evento("checkout.session.completed", { id: "cs_1", mode: "subscription", customer: "cus_1", subscription: "sub_1" }),
      { agora: AGORA, carenciaDias: 5 },
    );
    expect(r).toMatchObject({ resultado: "vinculado", organizationId: ORG });
    expect(escritas).toEqual([
      { tabela: "cobranca_checkouts", metodo: "update", args: [{ stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1" }] },
    ]);
    // Se aparecesse `assinaturas` aqui, seria uma linha sem prazo: acesso vitalício.
    expect(escritas.some((e) => e.tabela === "assinaturas")).toBe(false);
  });

  it("assinatura de cliente que nunca vimos: sem_organizacao", async () => {
    const { db } = dbFalso({ assinaturas: { data: null }, cobranca_checkouts: { data: null } });
    const r = await processarEventoDoStripe(
      db,
      evento("customer.subscription.updated", { id: "sub_9", customer: "cus_9", status: "active", current_period_end: s(30) }),
      { agora: AGORA, carenciaDias: 5 },
    );
    expect(r.resultado).toBe("sem_organizacao");
  });

  it("1ª ativação: acha a organização PELO CHECKOUT que criamos e grava o prazo, o plano e o preço", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: null }, { data: null }], // por assinatura, depois por cliente
      cobranca_checkouts: { data: { session_id: "cs_1", organization_id: ORG, plano_id: "plano-1", preco_id: "preco-1" } },
      plano_precos: { data: { valor_cents: 19700, moeda: "BRL" } },
    });
    const r = await processarEventoDoStripe(
      db,
      evento("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active", current_period_end: s(30) }),
      { agora: AGORA, carenciaDias: 5 },
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG });
    const grava = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert");
    const linha = grava!.args[0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: ORG,
      plano_id: "plano-1",
      preco_id: "preco-1",
      situacao: "ativa",
      carencia_ate: null,
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      valor_cents: 19700,
      moeda: "BRL",
      // A liberação é do PROVEDOR: sem autor e sem motivo de porta manual.
      liberado_por: null,
      motivo: null,
    });
    expect(new Date(linha.liberado_ate as string).getTime()).toBe(s(30) * 1000);
  });

  it("evento FORA DE ORDEM: registrado como ignorado, e NADA é gravado", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: {
        data: {
          organization_id: ORG, plano_id: "p", preco_id: "pr", situacao: "cancelada",
          liberado_ate: new Date(AGORA.getTime() + 86_400_000).toISOString(), carencia_ate: null, cancelada_em: AGORA.toISOString(),
          ultimo_evento_em: AGORA.toISOString(), stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
        },
      },
    });
    const r = await processarEventoDoStripe(
      db,
      // criado 1 minuto ANTES do último evento aplicado
      evento("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active", current_period_end: s(30) }, T - 60),
      { agora: AGORA, carenciaDias: 5 },
    );
    expect(r.resultado).toBe("ignorado_fora_de_ordem");
    expect(escritas).toEqual([]);
  });

  it("falha de pagamento numa organização SEM assinatura registrada não cria linha", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: [{ data: null }, { data: null }],
      cobranca_checkouts: { data: { session_id: "cs_1", organization_id: ORG, plano_id: "p", preco_id: "pr" } },
    });
    const r = await processarEventoDoStripe(
      db,
      evento("invoice.payment_failed", { id: "in_1", customer: "cus_1", subscription: "sub_1" }),
      { agora: AGORA, carenciaDias: 5 },
    );
    expect(r.resultado).toBe("ignorado_sem_assinatura");
    expect(escritas).toEqual([]);
  });

  it("erro de banco AO GRAVAR lança — a rota devolve 500 e o provedor reentrega", async () => {
    const { db } = dbFalso({
      assinaturas: [{ data: null }, { data: null }, { error: { message: "boom" } }],
      cobranca_checkouts: { data: { session_id: "cs_1", organization_id: ORG, plano_id: "p", preco_id: "pr" } },
      plano_precos: { data: { valor_cents: 100, moeda: "BRL" } },
    });
    await expect(
      processarEventoDoStripe(
        db,
        evento("customer.subscription.updated", { id: "sub_1", customer: "cus_1", status: "active", current_period_end: s(30) }),
        { agora: AGORA, carenciaDias: 5 },
      ),
    ).rejects.toThrow(/assinaturas\(upsert\)/);
  });

  it("erro de banco ao PROCURAR também lança (não vira 'sem organização' silencioso)", async () => {
    const { db } = dbFalso({ assinaturas: { error: { message: "timeout" } } });
    await expect(
      processarEventoDoStripe(
        db,
        evento("invoice.paid", { id: "in_1", customer: "cus_1", subscription: "sub_1", lines: { data: [{ period: { end: s(30) } }] } }),
        { agora: AGORA, carenciaDias: 5 },
      ),
    ).rejects.toThrow(/assinaturas\(stripe_subscription_id\)/);
  });
});

describe("cliente — formulário, modo e prontidão", () => {
  it("codifica objetos aninhados e arrays na notação de colchetes do Stripe", () => {
    const p = codificarFormulario({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      subscription_data: { metadata: { organization_id: "org" } },
    });
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("line_items[0][price]")).toBe("price_1");
    expect(p.get("line_items[0][quantity]")).toBe("1");
    expect(p.get("subscription_data[metadata][organization_id]")).toBe("org");
  });
  it("null e undefined SOMEM — enviar chave vazia faria o Stripe limpar o campo", () => {
    const p = codificarFormulario({ a: "x", b: null, c: undefined });
    expect([...p.keys()]).toEqual(["a"]);
  });
  it("booleanos viram texto", () => {
    expect(codificarFormulario({ cancel_at_period_end: true }).get("cancel_at_period_end")).toBe("true");
  });
  it.each([
    ["sk_test_abc", "teste"], ["sk_live_abc", "producao"], ["rk_live_abc", "producao"],
    ["pk_test_abc", "invalida"], ["lixo", "invalida"], ["", "invalida"], [null, "invalida"],
  ] as const)("modoDaChave(%j) = %s — a chave PÚBLICA não serve para cobrar", (chave, modo) => {
    expect(modoDaChave(chave)).toBe(modo);
  });
  it("stripePronto exige chave VÁLIDA e o segredo do webhook", () => {
    expect(stripePronto({ chave: "sk_test_x", segredoDoWebhook: "whsec_x", modo: "teste" })).toBe(true);
    // Sem o webhook o cliente pagaria e nada o liberaria: melhor nem oferecer o checkout.
    expect(stripePronto({ chave: "sk_test_x", segredoDoWebhook: null, modo: "teste" })).toBe(false);
    expect(stripePronto({ chave: "pk_test_x", segredoDoWebhook: "whsec_x", modo: "invalida" })).toBe(false);
  });
});

describe("sessões (rede dublada)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stripeFalso(respostas: Array<{ status?: number; corpo: unknown }>) {
    const chamadas: Array<{ url: string; corpo: URLSearchParams; idem: string | null }> = [];
    let i = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      chamadas.push({
        url: String(url),
        corpo: new URLSearchParams(String(init.body ?? "")),
        idem: (init.headers as Record<string, string>)["Idempotency-Key"] ?? null,
      });
      const r = respostas[Math.min(i++, respostas.length - 1)]!;
      return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200 });
    });
    return chamadas;
  }

  const base = {
    chave: "sk_test_x", organizationId: ORG, usuarioId: "u1", emailDoUsuario: "a@b.c",
    planoId: "plano-1", intervalo: "mensal" as const, urlBase: "https://crm.exemplo.com", idioma: "pt-BR", agora: AGORA,
  };
  const plano = { data: { id: "plano-1", nome: "Pro", publicado_em: "2026-09-01", arquivado_em: null } };
  const preco = (stripe: string | null) => ({
    data: { id: "preco-1", plano_id: "plano-1", intervalo: "mensal", valor_cents: "19700", moeda: "BRL", stripe_price_id: stripe },
  });

  it("RASCUNHO não se compra, nem por URL adivinhada", async () => {
    const chamadas = stripeFalso([{ corpo: {} }]);
    const { db } = dbFalso({ planos: { data: { id: "plano-1", nome: "Pro", publicado_em: null, arquivado_em: null } } });
    expect(await criarCheckout({ ...base, db })).toEqual({ ok: false, falha: "plano_indisponivel" });
    expect(chamadas).toEqual([]);
  });

  it("ARQUIVADO não se compra", async () => {
    stripeFalso([{ corpo: {} }]);
    const { db } = dbFalso({ planos: { data: { id: "plano-1", nome: "Pro", publicado_em: "2026-09-01", arquivado_em: "2026-09-20" } } });
    expect((await criarCheckout({ ...base, db })).ok).toBe(false);
  });

  it("plano sem preço vigente no intervalo pedido", async () => {
    stripeFalso([{ corpo: {} }]);
    const { db } = dbFalso({ planos: plano, plano_precos: { data: null } });
    expect(await criarCheckout({ ...base, db })).toEqual({ ok: false, falha: "preco_indisponivel" });
  });

  it("1ª venda: cria o Price UMA vez (idempotente pela linha) e depois a sessão", async () => {
    const chamadas = stripeFalso([
      { corpo: { id: "price_1" } },
      { corpo: { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" } },
    ]);
    const { db, escritas } = dbFalso({
      planos: plano, plano_precos: preco(null), assinaturas: { data: null }, cobranca_checkouts: { data: null },
    });
    const r = await criarCheckout({ ...base, db });
    expect(r).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });

    const [criaPreco, criaSessao] = chamadas;
    expect(criaPreco!.url).toContain("/v1/prices");
    expect(criaPreco!.corpo.get("unit_amount")).toBe("19700"); // centavos inteiros, nunca float
    expect(criaPreco!.corpo.get("currency")).toBe("brl");
    expect(criaPreco!.corpo.get("recurring[interval]")).toBe("month");
    expect(criaPreco!.idem).toBe("price:preco-1");

    expect(criaSessao!.url).toContain("/v1/checkout/sessions");
    expect(criaSessao!.corpo.get("mode")).toBe("subscription");
    expect(criaSessao!.corpo.get("line_items[0][price]")).toBe("price_1");
    expect(criaSessao!.corpo.get("client_reference_id")).toBe(ORG);
    expect(criaSessao!.corpo.get("success_url")).toBe("https://crm.exemplo.com/app/settings/billing?checkout=ok");
    expect(criaSessao!.corpo.get("customer_email")).toBe("a@b.c");
    expect(criaSessao!.idem).toMatch(/^checkout:11111111-.*:preco-1:\d+$/);

    // O checkout que criamos é gravado — é o que resolve de quem é o pagamento.
    expect(escritas.find((e) => e.tabela === "cobranca_checkouts" && e.metodo === "insert")?.args[0]).toMatchObject({
      session_id: "cs_1", organization_id: ORG, plano_id: "plano-1", preco_id: "preco-1", criado_por: "u1",
    });
    // E o preço passa a apontar para o objeto de cobrança.
    expect(escritas.find((e) => e.tabela === "plano_precos" && e.metodo === "update")?.args[0]).toMatchObject({ stripe_price_id: "price_1" });
  });

  it("Price JÁ existente é reusado: nenhuma chamada a /v1/prices", async () => {
    const chamadas = stripeFalso([{ corpo: { id: "cs_2", url: "https://checkout.stripe.com/x" } }]);
    const { db } = dbFalso({ planos: plano, plano_precos: preco("price_existente"), assinaturas: { data: null }, cobranca_checkouts: { data: null } });
    expect((await criarCheckout({ ...base, db })).ok).toBe(true);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.corpo.get("line_items[0][price]")).toBe("price_existente");
  });

  it("cliente JÁ conhecido é reusado em vez de criar outro", async () => {
    const chamadas = stripeFalso([{ corpo: { id: "cs_3", url: "https://checkout.stripe.com/y" } }]);
    const { db } = dbFalso({
      planos: plano, plano_precos: preco("price_1"),
      assinaturas: { data: { stripe_customer_id: "cus_antigo" } },
    });
    await criarCheckout({ ...base, db });
    expect(chamadas[0]!.corpo.get("customer")).toBe("cus_antigo");
    expect(chamadas[0]!.corpo.has("customer_email")).toBe(false);
  });

  it("o Stripe recusa: falha `provedor_recusou`, com o detalhe para o LOG", async () => {
    stripeFalso([{ status: 400, corpo: { error: { code: "invalid_request", message: "No such price" } } }]);
    const { db } = dbFalso({ planos: plano, plano_precos: preco("price_1"), assinaturas: { data: null }, cobranca_checkouts: { data: null } });
    expect(await criarCheckout({ ...base, db })).toMatchObject({ ok: false, falha: "provedor_recusou", detalhe: "No such price" });
  });

  it("falha de REDE não lança", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNRESET"); });
    const { db } = dbFalso({ planos: plano, plano_precos: preco("price_1"), assinaturas: { data: null }, cobranca_checkouts: { data: null } });
    expect(await criarCheckout({ ...base, db })).toMatchObject({ ok: false, falha: "provedor_recusou" });
  });

  it("se o registro do checkout FALHA, o link NÃO é entregue (cobraria sem liberar)", async () => {
    stripeFalso([{ corpo: { id: "cs_4", url: "https://checkout.stripe.com/z" } }]);
    const { db } = dbFalso({
      planos: plano, plano_precos: preco("price_1"), assinaturas: { data: null },
      cobranca_checkouts: [{ data: null }, { error: { code: "XX000", message: "disco cheio" } }],
    });
    expect((await criarCheckout({ ...base, db })).ok).toBe(false);
  });

  it("portal sem cliente no provedor: sem_assinatura_no_provedor (acesso liberado à mão)", async () => {
    stripeFalso([{ corpo: {} }]);
    const { db } = dbFalso({ assinaturas: { data: null }, cobranca_checkouts: { data: null } });
    expect(await criarPortal({ db, chave: "sk_test_x", organizationId: ORG, urlBase: "https://x" })).toEqual({
      ok: false, falha: "sem_assinatura_no_provedor",
    });
  });

  it("portal com cliente: devolve a URL e volta para a tela de cobrança", async () => {
    const chamadas = stripeFalso([{ corpo: { url: "https://billing.stripe.com/p/1" } }]);
    const { db } = dbFalso({ assinaturas: { data: { stripe_customer_id: "cus_1" } } });
    expect(await criarPortal({ db, chave: "sk_test_x", organizationId: ORG, urlBase: "https://crm.exemplo.com" })).toEqual({
      ok: true, url: "https://billing.stripe.com/p/1",
    });
    expect(chamadas[0]!.corpo.get("return_url")).toBe("https://crm.exemplo.com/app/settings/billing");
  });

  it("cancelar SEM assinatura no provedor não chama a rede", async () => {
    const chamadas = stripeFalso([{ corpo: {} }]);
    const { db } = dbFalso({ assinaturas: { data: { stripe_subscription_id: null } } });
    expect(await cancelarNoFimDoPeriodo({ db, chave: "sk_test_x", organizationId: ORG })).toEqual({
      ok: false, falha: "sem_assinatura_no_provedor",
    });
    expect(chamadas).toEqual([]);
  });

  it("cancelar pede o fim do PERÍODO — quem pagou usa até o fim, nada é cortado na hora", async () => {
    const chamadas = stripeFalso([{ corpo: { id: "sub_1" } }]);
    const { db } = dbFalso({ assinaturas: { data: { stripe_subscription_id: "sub_1" } } });
    expect(await cancelarNoFimDoPeriodo({ db, chave: "sk_test_x", organizationId: ORG })).toEqual({ ok: true });
    expect(chamadas[0]!.url).toContain("/v1/subscriptions/sub_1");
    expect(chamadas[0]!.corpo.get("cancel_at_period_end")).toBe("true");
  });
});
