/**
 * O CHECKOUT E O CANCELAMENTO PELA CAKTO — COM BANCO E REDE DUBLADOS.
 *
 * Molde: `tests/unit/stripe-aplicar-e-sessoes.test.ts`. O que estes casos
 * protegem, em ordem de gravidade:
 *
 *   1. NUNCA a oferta padrão do produto: o link vem SEMPRE de `garantirOfertaNaCakto`.
 *   2. Rascunho, arquivado e sem preço vigente não se compram, nem por URL adivinhada.
 *   3. Produto e oferta são criados UMA vez (idempotência pela linha) e REUSADOS.
 *   4. Se o registro do checkout falha, o link NÃO é entregue.
 *   5. Cancelar é NA HORA na Cakto, mas o ACESSO (`liberado_ate`) não muda — e
 *      cancelar duas vezes não bate na rede na segunda.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { _limparCacheDeToken, type CredenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import {
  cancelarAssinaturaDaOrganizacao,
  criarCheckoutNaCakto,
  garantirOfertaNaCakto,
  garantirProdutoNaCakto,
} from "@/lib/planos/cakto/sessoes";

import { dbFalso } from "./helpers/db-falso-planos";

const CREDENCIAIS: CredenciaisDaCakto = {
  clientId: "client_abc",
  clientSecret: "segredo_super_secreto",
  webhookSecret: "whsec_x",
};
const ORG = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-09-29T12:00:00Z");

interface ChamadaGravada {
  url: string;
  metodo: string;
  corpo: Record<string, unknown> | null;
  idem: string | null;
}

/** Fetch dublado: intercepta `/token/` sempre com sucesso e devolve as respostas
 *  configuradas, em ordem, para as chamadas autenticadas de verdade. */
function caktoFalso(respostas: Array<{ status?: number; corpo: unknown }>): ChamadaGravada[] {
  const chamadas: ChamadaGravada[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/token/")) {
      return new Response(JSON.stringify({ access_token: "tok_1", expires_in: 36_000 }), { status: 200 });
    }
    chamadas.push({
      url: String(url),
      metodo: init?.method ?? "GET",
      corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      idem: (init?.headers as Record<string, string> | undefined)?.["X-Idempotency-Key"] ?? null,
    });
    const r = respostas[Math.min(i++, respostas.length - 1)]!;
    return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200 });
  });
  return chamadas;
}

const plano = (extra: Partial<Record<string, unknown>> = {}) => ({
  data: { id: "plano-1", nome: "Pro", descricao: null, publicado_em: "2026-09-01", arquivado_em: null, cakto_produto_id: null, ...extra },
});
const preco = (intervalo: "mensal" | "anual", extra: Partial<Record<string, unknown>> = {}) => ({
  data: {
    id: "preco-1",
    plano_id: "plano-1",
    intervalo,
    valor_cents: "19700",
    moeda: "BRL",
    cakto_oferta_id: null,
    ...extra,
  },
});

describe("criarCheckoutNaCakto", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _limparCacheDeToken();
  });

  const base = { cred: CREDENCIAIS, organizationId: ORG, usuarioId: "u1", planoId: "plano-1", intervalo: "mensal" as const };

  it("RASCUNHO não se compra, nem por URL adivinhada", async () => {
    const chamadas = caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({ planos: plano({ publicado_em: null }) });
    expect(await criarCheckoutNaCakto({ ...base, db })).toEqual({ ok: false, falha: "plano_indisponivel" });
    expect(chamadas).toEqual([]);
  });

  it("ARQUIVADO não se compra", async () => {
    caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({ planos: plano({ arquivado_em: "2026-09-20" }) });
    expect((await criarCheckoutNaCakto({ ...base, db })).ok).toBe(false);
  });

  it("plano sem preço vigente no intervalo pedido", async () => {
    caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({ planos: plano(), plano_precos: { data: null } });
    expect(await criarCheckoutNaCakto({ ...base, db })).toEqual({ ok: false, falha: "preco_indisponivel" });
  });

  it("1ª venda: cria produto e oferta (nesta ordem) e devolve o link da OFERTA — nunca a padrão do produto", async () => {
    const chamadas = caktoFalso([
      { corpo: { id: "prod_1", offers: [{ id: "oferta_padrao_do_produto" }] } },
      { corpo: { id: "oferta_1" } },
    ]);
    const { db, escritas } = dbFalso({
      planos: plano(),
      plano_precos: preco("mensal"),
      cobranca_checkouts: { data: null },
    });
    const r = await criarCheckoutNaCakto({ ...base, db });
    expect(r).toMatchObject({ ok: true });
    expect((r as { url: string }).url.startsWith("https://pay.cakto.com.br/oferta_1?callback=dc_")).toBe(true);

    const [criaProduto, criaOferta] = chamadas;
    expect(criaProduto!.url).toContain("/products/");
    expect(criaProduto!.corpo).toMatchObject({ name: "Pro", description: "Pro", price: "197.00", type: "subscription", currency: "BRL" });
    expect(criaProduto!.corpo).not.toHaveProperty("paymentMethods");
    expect(criaProduto!.idem).toBe("produto:plano-1");

    expect(criaOferta!.url).toContain("/offers/");
    expect(criaOferta!.corpo).toMatchObject({
      product: "prod_1",
      name: "Pro (mensal)",
      price: 197,
      intervalType: "month",
      interval: 1,
      recurrence_period: 30,
      quantity_recurrences: -1,
      trial_days: 0,
      currency: "BRL",
      status: "active",
    });
    expect(criaOferta!.corpo).not.toHaveProperty("paymentMethods");
    expect(criaOferta!.idem).toBe("oferta:preco-1");

    // O link é da OFERTA que criamos — nunca de `offers[0]` da resposta do produto.
    expect((r as { url: string }).url).not.toContain("oferta_padrao_do_produto");

    expect(escritas.find((e) => e.tabela === "planos" && e.metodo === "update")?.args[0]).toMatchObject({ cakto_produto_id: "prod_1" });
    expect(escritas.find((e) => e.tabela === "plano_precos" && e.metodo === "update")?.args[0]).toMatchObject({ cakto_oferta_id: "oferta_1" });
    expect(escritas.find((e) => e.tabela === "cobranca_checkouts" && e.metodo === "insert")?.args[0]).toMatchObject({
      organization_id: ORG, plano_id: "plano-1", preco_id: "preco-1", provedor: "cakto", cakto_oferta_id: "oferta_1", criado_por: "u1",
    });
  });

  it("oferta ANUAL: intervalType year e recurrence_period 365", async () => {
    const chamadas = caktoFalso([{ corpo: { id: "prod_1" } }, { corpo: { id: "oferta_anual" } }]);
    const { db } = dbFalso({ planos: plano(), plano_precos: preco("anual"), cobranca_checkouts: { data: null } });
    await criarCheckoutNaCakto({ ...base, db, intervalo: "anual" });
    expect(chamadas[1]!.corpo).toMatchObject({ intervalType: "year", recurrence_period: 365 });
  });

  it("produto e oferta JÁ existentes são REUSADOS: nenhuma chamada à rede para criá-los", async () => {
    const chamadas = caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({
      planos: plano({ cakto_produto_id: "prod_existente" }),
      plano_precos: preco("mensal", { cakto_oferta_id: "oferta_existente" }),
      cobranca_checkouts: { data: null },
    });
    const r = await criarCheckoutNaCakto({ ...base, db });
    expect(r.ok).toBe(true);
    expect(chamadas).toEqual([]); // nem /products/ nem /offers/ — e nem o /token/, que a Cakto nunca viu
  });

  it("garantirProdutoNaCakto sozinho: já existente não toca na rede", async () => {
    const chamadas = caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({});
    const r = await garantirProdutoNaCakto(db, CREDENCIAIS, { id: "p1", nome: "Pro", descricao: null, cakto_produto_id: "prod_1" }, {
      id: "pr1", plano_id: "p1", intervalo: "mensal", valor_cents: 100, moeda: "BRL", cakto_oferta_id: null,
    });
    expect(r).toEqual({ ok: true, id: "prod_1" });
    expect(chamadas).toEqual([]);
  });

  it("garantirOfertaNaCakto sozinho: já existente não toca na rede", async () => {
    const chamadas = caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({});
    const r = await garantirOfertaNaCakto(db, CREDENCIAIS, { id: "p1", nome: "Pro", descricao: null, cakto_produto_id: "prod_1" }, {
      id: "pr1", plano_id: "p1", intervalo: "mensal", valor_cents: 100, moeda: "BRL", cakto_oferta_id: "oferta_1",
    });
    expect(r).toEqual({ ok: true, id: "oferta_1" });
    expect(chamadas).toEqual([]);
  });

  it("a Cakto recusa a criação do produto: `provedor_recusou`, com o detalhe para o LOG", async () => {
    caktoFalso([{ status: 400, corpo: { message: "dados inválidos" } }]);
    const { db } = dbFalso({ planos: plano(), plano_precos: preco("mensal"), cobranca_checkouts: { data: null } });
    expect(await criarCheckoutNaCakto({ ...base, db })).toMatchObject({ ok: false, falha: "provedor_recusou", detalhe: "dados inválidos" });
  });

  it("a Cakto recusa a criação da oferta: `provedor_recusou`", async () => {
    caktoFalso([{ corpo: { id: "prod_1" } }, { status: 400, corpo: { message: "oferta inválida" } }]);
    const { db } = dbFalso({ planos: plano(), plano_precos: preco("mensal"), cobranca_checkouts: { data: null } });
    expect(await criarCheckoutNaCakto({ ...base, db })).toMatchObject({ ok: false, falha: "provedor_recusou", detalhe: "oferta inválida" });
  });

  it("se o registro do checkout FALHA, o link NÃO é entregue (cobraria sem liberar)", async () => {
    caktoFalso([{ corpo: { id: "prod_1" } }, { corpo: { id: "oferta_1" } }]);
    const { db } = dbFalso({
      planos: plano(),
      plano_precos: preco("mensal"),
      cobranca_checkouts: { error: { code: "XX000", message: "disco cheio" } },
    });
    expect(await criarCheckoutNaCakto({ ...base, db })).toMatchObject({ ok: false, falha: "registro_falhou" });
  });

  it("a URL do checkout tem o token da Cakto em `?callback=dc_...`", async () => {
    caktoFalso([{ corpo: { id: "prod_1" } }, { corpo: { id: "oferta_1" } }]);
    const { db } = dbFalso({ planos: plano(), plano_precos: preco("mensal"), cobranca_checkouts: { data: null } });
    const r = await criarCheckoutNaCakto({ ...base, db });
    expect(r.ok).toBe(true);
    const url = (r as { url: string }).url;
    expect(url).toMatch(/^https:\/\/pay\.cakto\.com\.br\/oferta_1\?callback=dc_[A-Za-z0-9_-]+$/);
  });
});

describe("cancelarAssinaturaDaOrganizacao", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _limparCacheDeToken();
  });

  it("sem assinatura no provedor: não chama a rede", async () => {
    const chamadas = caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({ assinaturas: { data: { situacao: "ativa", liberado_ate: null, carencia_ate: null, cancelada_em: null, ultimo_evento_em: null, cakto_assinatura_id: null } } });
    expect(await cancelarAssinaturaDaOrganizacao({ db, cred: CREDENCIAIS, organizationId: ORG, agora: AGORA })).toEqual({
      ok: false, falha: "sem_assinatura_no_provedor",
    });
    expect(chamadas).toEqual([]);
  });

  it("sem linha nenhuma em assinaturas: também sem_assinatura_no_provedor, sem rede", async () => {
    const chamadas = caktoFalso([{ corpo: {} }]);
    const { db } = dbFalso({ assinaturas: { data: null } });
    expect(await cancelarAssinaturaDaOrganizacao({ db, cred: CREDENCIAIS, organizationId: ORG, agora: AGORA })).toEqual({
      ok: false, falha: "sem_assinatura_no_provedor",
    });
    expect(chamadas).toEqual([]);
  });

  it("cancela NA CAKTO e MANTÉM liberado_ate — só marca cancelada_em", async () => {
    const liberadoAte = new Date(AGORA.getTime() + 10 * 86_400_000).toISOString();
    const chamadas = caktoFalso([{ corpo: { status: "canceled" } }]);
    const { db, escritas } = dbFalso({
      assinaturas: {
        data: {
          situacao: "ativa", liberado_ate: liberadoAte, carencia_ate: null, cancelada_em: null,
          ultimo_evento_em: new Date(AGORA.getTime() - 86_400_000).toISOString(), cakto_assinatura_id: "sub_1",
        },
      },
    });
    const r = await cancelarAssinaturaDaOrganizacao({ db, cred: CREDENCIAIS, organizationId: ORG, agora: AGORA });
    expect(r).toEqual({ ok: true, acessoAte: new Date(liberadoAte) });

    expect(chamadas[0]!.url).toContain("/subscriptions/sub_1/cancel/");
    const upd = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "update")?.args[0] as Record<string, unknown>;
    expect(upd).toMatchObject({ situacao: "ativa", liberado_ate: liberadoAte, carencia_ate: null });
    expect(upd.cancelada_em).toBe(AGORA.toISOString());
  });

  it("provedor recusa o cancelamento: `provedor_recusou`, e NADA é gravado", async () => {
    caktoFalso([{ status: 400, corpo: { message: "assinatura não encontrada" } }]);
    const { db, escritas } = dbFalso({
      assinaturas: {
        data: { situacao: "ativa", liberado_ate: null, carencia_ate: null, cancelada_em: null, ultimo_evento_em: null, cakto_assinatura_id: "sub_1" },
      },
    });
    const r = await cancelarAssinaturaDaOrganizacao({ db, cred: CREDENCIAIS, organizationId: ORG, agora: AGORA });
    expect(r).toMatchObject({ ok: false, falha: "provedor_recusou" });
    expect(escritas).toEqual([]);
  });

  it("cancelar DUAS vezes não chama rede na segunda — a linha já tem `cancelada_em`", async () => {
    let chamadasDeRede = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      chamadasDeRede++;
      if (String(url).includes("/token/")) return new Response(JSON.stringify({ access_token: "tok_1", expires_in: 36_000 }), { status: 200 });
      return new Response(JSON.stringify({ status: "canceled" }), { status: 200 });
    });

    const { db } = dbFalso({
      assinaturas: [
        { data: { situacao: "ativa", liberado_ate: null, carencia_ate: null, cancelada_em: null, ultimo_evento_em: null, cakto_assinatura_id: "sub_1" } },
        { data: { situacao: "ativa", liberado_ate: null, carencia_ate: null, cancelada_em: AGORA.toISOString(), ultimo_evento_em: AGORA.toISOString(), cakto_assinatura_id: "sub_1" } },
      ],
    });

    const r1 = await cancelarAssinaturaDaOrganizacao({ db, cred: CREDENCIAIS, organizationId: ORG, agora: AGORA });
    expect(r1.ok).toBe(true);
    expect(chamadasDeRede).toBeGreaterThan(0); // token + cancelar

    const antes = chamadasDeRede;
    const r2 = await cancelarAssinaturaDaOrganizacao({ db, cred: CREDENCIAIS, organizationId: ORG, agora: AGORA });
    expect(r2).toEqual({ ok: true, acessoAte: null });
    expect(chamadasDeRede).toBe(antes); // nenhuma chamada nova
  });
});
