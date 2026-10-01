/**
 * O APLICADOR DE EVENTOS DA CAKTO — COM BANCO E REDE DUBLADOS.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. A organização sai de DADO NOSSO, na ordem certa — nunca do payload
 *      (e-mail ambíguo entre duas organizações é `sem_organizacao`, nunca um
 *      chute pela primeira).
 *   2. Evento de uma assinatura ANTIGA nunca toca a assinatura VIGENTE — exceto
 *      a única porta de troca (callback de checkout ainda não pago).
 *   3. `pago` sem período nenhum (nem próxima cobrança, nem intervalo) não cria
 *      nem estende nada — seria "sem prazo" = acesso vitalício.
 *   4. O e-mail do pagador NUNCA aparece em nenhuma escrita.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

import { audit } from "@/lib/audit";
import { processarEventoDaCakto } from "@/lib/planos/cakto/aplicar";
import { _limparCacheDeToken, type CredenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import type { EventoDaCakto } from "@/lib/planos/cakto/webhook";
import { MARGEM_DE_RENOVACAO_MS } from "@/lib/planos/cobranca/maquina";

import { dbFalso } from "./helpers/db-falso-planos";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG2 = "22222222-2222-4222-8222-222222222222";
const CRED: CredenciaisDaCakto = { clientId: "client_x", clientSecret: "segredo_x", webhookSecret: "whsec_x" };
const AGORA = new Date("2026-09-29T12:00:00Z");
const emDias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000);

function evento(over: Partial<EventoDaCakto> = {}): EventoDaCakto {
  return {
    evento: "purchase_approved",
    pedidoId: "ped_1",
    callback: null,
    clienteId: null,
    email: null,
    produtoId: null,
    ofertaId: null,
    assinatura: null,
    ...over,
  };
}

const OPTS_BASE = { agora: AGORA, eventoCriadoEm: AGORA, carenciaDias: 5, cred: CRED };

describe("processarEventoDaCakto — de quem é o pagamento", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _limparCacheDeToken();
    vi.mocked(audit).mockClear();
  });

  it("tipo que não tratamos: ignora sem tocar em nenhuma tabela", async () => {
    const { db, consultas } = dbFalso({});
    const r = await processarEventoDaCakto(db, evento({ evento: "charge.refunded" as never }), OPTS_BASE);
    expect(r).toEqual({ resultado: "ignorado_tipo", organizationId: null, via: null, detalhe: "evento_nao_tratado:charge.refunded" });
    expect(consultas).toEqual([]);
  });

  it("organizacaoForcada resolve sem consultar tabela nenhuma para achar a organização", async () => {
    const { db, consultas, escritas } = dbFalso({});
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "subscription_created", assinatura: { id: "sub_x", status: "active", proximaCobranca: null } }),
      { ...OPTS_BASE, organizacaoForcada: ORG },
    );
    expect(r).toMatchObject({ resultado: "vinculado", organizationId: ORG, via: "organizacaoForcada" });
    expect(consultas).toEqual(["assinaturas"]); // só o update de vínculo
    expect(escritas).toEqual([
      { tabela: "assinaturas", metodo: "update", args: [{ cakto_assinatura_id: "sub_x" }] },
    ]);
  });

  it("vincular via CALLBACK: grava os ids no checkout que criamos e preenche a assinatura se estava nula", async () => {
    const { db, escritas } = dbFalso({
      cobranca_checkouts: { data: { session_id: "cb_2", organization_id: ORG, plano_id: null, preco_id: null, pago_em: null } },
    });
    const r = await processarEventoDaCakto(
      db,
      evento({
        evento: "subscription_created",
        callback: "cb_2",
        clienteId: "cli_9",
        pedidoId: "ped_9",
        assinatura: { id: "sub_9", status: "active", proximaCobranca: null },
      }),
      OPTS_BASE,
    );
    expect(r).toMatchObject({ resultado: "vinculado", organizationId: ORG, via: "callback" });
    expect(escritas).toEqual([
      {
        tabela: "cobranca_checkouts",
        metodo: "update",
        args: [{ cakto_assinatura_id: "sub_9", cakto_cliente_id: "cli_9", cakto_pedido_id: "ped_9" }],
      },
      { tabela: "assinaturas", metodo: "update", args: [{ cakto_assinatura_id: "sub_9" }] },
    ]);
  });

  it("resolve via CALLBACK: pago com próxima cobrança aplica e marca o checkout como pago", async () => {
    const { db, escritas } = dbFalso({
      cobranca_checkouts: { data: { session_id: "cb_1", organization_id: ORG, plano_id: "plano-1", preco_id: "preco-1", pago_em: null } },
      assinaturas: { data: null },
      plano_precos: { data: { plano_id: "plano-1", valor_cents: 9900, moeda: "BRL", intervalo: "mensal" } },
    });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "purchase_approved", callback: "cb_1", clienteId: "cli_1", assinatura: { id: "sub_1", status: "active", proximaCobranca: emDias(30) } }),
      OPTS_BASE,
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "callback" });

    const upsert = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert");
    const linha = upsert!.args[0] as Record<string, unknown>;
    expect(linha).toMatchObject({
      organization_id: ORG,
      plano_id: "plano-1",
      preco_id: "preco-1",
      situacao: "ativa",
      carencia_ate: null,
      cakto_assinatura_id: "sub_1",
      cakto_cliente_id: "cli_1",
      valor_cents: 9900,
      moeda: "BRL",
      liberado_por: null,
      motivo: null,
    });
    expect(new Date(linha.liberado_ate as string).getTime()).toBe(emDias(30).getTime() + MARGEM_DE_RENOVACAO_MS);

    const checkoutUpdate = escritas.find((e) => e.tabela === "cobranca_checkouts" && e.metodo === "update");
    expect(checkoutUpdate!.args[0]).toMatchObject({ cakto_pedido_id: "ped_1", cakto_assinatura_id: "sub_1", cakto_cliente_id: "cli_1" });
  });

  it("resolve via ASSINATURA já vinculada (assinaturas.cakto_assinatura_id): nao_renova mantém o prazo", async () => {
    const liberadoAte = emDias(10);
    const { db } = dbFalso({
      assinaturas: [
        { data: { organization_id: ORG } },
        {
          data: {
            situacao: "ativa",
            liberado_ate: liberadoAte.toISOString(),
            carencia_ate: null,
            cancelada_em: null,
            ultimo_evento_em: emDias(-1).toISOString(),
            cakto_assinatura_id: "sub_1",
            cakto_cliente_id: null,
            plano_id: "plano-1",
            preco_id: "preco-1",
          },
        },
      ],
    });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "subscription_canceled", assinatura: { id: "sub_1", status: null, proximaCobranca: null } }),
      OPTS_BASE,
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "assinatura" });
  });

  it("resolve via checkout QUANDO a assinatura ainda não estava em `assinaturas` (cobranca_checkouts.cakto_assinatura_id)", async () => {
    const { db } = dbFalso({
      assinaturas: [{ data: null }, { data: null }],
      cobranca_checkouts: { data: { session_id: "cb_5", organization_id: ORG, plano_id: null, preco_id: "preco-1", pago_em: "2026-09-01T00:00:00Z" } },
      plano_precos: { data: { plano_id: "plano-1", valor_cents: 5000, moeda: "BRL", intervalo: "mensal" } },
    });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "subscription_renewed", assinatura: { id: "sub_5", status: "active", proximaCobranca: emDias(30) } }),
      OPTS_BASE,
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "checkout_por_assinatura" });
  });

  it("resolve via CLIENTE com EXATAMENTE uma organização", async () => {
    const liberadoAte = emDias(20);
    const { db, escritas } = dbFalso({
      assinaturas: [
        { data: [{ organization_id: ORG }] },
        {
          data: {
            situacao: "ativa",
            liberado_ate: liberadoAte.toISOString(),
            carencia_ate: null,
            cancelada_em: null,
            ultimo_evento_em: emDias(-1).toISOString(),
            cakto_assinatura_id: "sub_1",
            cakto_cliente_id: "cli_1",
            plano_id: "plano-1",
            preco_id: "preco-1",
          },
        },
      ],
    });
    const r = await processarEventoDaCakto(
      db,
      // SEM `assinatura.id`: só assim a resolução chega ao degrau do cliente —
      // com o id presente, o degrau anterior (assinatura.id) resolveria primeiro.
      evento({ evento: "refund", clienteId: "cli_1" }),
      OPTS_BASE,
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "cliente" });
    const upsert = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert")!;
    expect((upsert.args[0] as Record<string, unknown>).situacao).toBe("cancelada");
  });

  it("resolve via E-MAIL com EXATAMENTE uma organização (e usa o intervalo do preço quando não há próxima cobrança)", async () => {
    const { db, escritas } = dbFalso(
      { assinaturas: { data: null }, plano_precos: { data: { plano_id: "plano-1", valor_cents: 3000, moeda: "BRL", intervalo: "mensal" } } },
      { fn_cobranca_orgs_do_admin_por_email: { data: [{ organization_id: ORG }] } },
    );
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "purchase_approved", email: "dono@empresa.com", ofertaId: "oferta-1" }),
      OPTS_BASE,
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "email" });
    expect(JSON.stringify(escritas)).not.toContain("dono@empresa.com");
  });

  it("e-mail AMBÍGUO (2 organizações): sem_organizacao — nunca escolhe pela primeira", async () => {
    const { db, escritas } = dbFalso(
      {},
      { fn_cobranca_orgs_do_admin_por_email: { data: [{ organization_id: ORG }, { organization_id: ORG2 }] } },
    );
    const r = await processarEventoDaCakto(db, evento({ email: "duplo@empresa.com" }), OPTS_BASE);
    expect(r).toEqual({ resultado: "sem_organizacao", organizationId: null, via: null });
    expect(escritas).toEqual([]);
  });

  it("checkout de sessão DESCONHECIDA: sem callback nem outro dado, sem_organizacao", async () => {
    const { db, escritas } = dbFalso({ cobranca_checkouts: { data: null } });
    const r = await processarEventoDaCakto(db, evento({ callback: "cb-inexistente" }), OPTS_BASE);
    expect(r).toEqual({ resultado: "sem_organizacao", organizationId: null, via: null });
    expect(escritas).toEqual([]);
  });

  it("pago SEM próxima cobrança e SEM intervalo: ignorado_sem_periodo — nada é gravado", async () => {
    const { db, escritas } = dbFalso({ assinaturas: { data: null } });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "purchase_approved", assinatura: { id: "sub_1", status: "active", proximaCobranca: null } }),
      { ...OPTS_BASE, organizacaoForcada: ORG },
    );
    expect(r).toMatchObject({ resultado: "ignorado_sem_periodo", organizationId: ORG, via: "organizacaoForcada" });
    expect(escritas).toEqual([]);
  });

  it("falha de pagamento: abre inadimplência a partir da PRIMEIRA falha", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: {
        data: {
          situacao: "ativa",
          liberado_ate: emDias(10).toISOString(),
          carencia_ate: null,
          cancelada_em: null,
          ultimo_evento_em: emDias(-1).toISOString(),
          cakto_assinatura_id: "sub_1",
          cakto_cliente_id: null,
          plano_id: "plano-1",
          preco_id: "preco-1",
        },
      },
    });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "subscription_renewal_refused", assinatura: { id: "sub_1", status: null, proximaCobranca: null } }),
      { ...OPTS_BASE, organizacaoForcada: ORG },
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "organizacaoForcada" });
    const upsert = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ situacao: "inadimplente", carencia_ate: emDias(5).toISOString() });
  });

  it("estorno CORTA na hora, sem carência", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: {
        data: {
          situacao: "ativa",
          liberado_ate: emDias(10).toISOString(),
          carencia_ate: null,
          cancelada_em: null,
          ultimo_evento_em: emDias(-1).toISOString(),
          cakto_assinatura_id: "sub_1",
          cakto_cliente_id: null,
          plano_id: "plano-1",
          preco_id: "preco-1",
        },
      },
    });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "chargeback", assinatura: { id: "sub_1", status: null, proximaCobranca: null } }),
      { ...OPTS_BASE, organizacaoForcada: ORG },
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "organizacaoForcada" });
    const upsert = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ situacao: "cancelada", carencia_ate: null });
  });

  it("evento de ASSINATURA ANTIGA (falhou/nao_renova/estornado) nunca toca a vigente: ignorado_assinatura_antiga, nada é gravado", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: {
        data: {
          situacao: "ativa",
          liberado_ate: emDias(10).toISOString(),
          carencia_ate: null,
          cancelada_em: null,
          ultimo_evento_em: emDias(-1).toISOString(),
          cakto_assinatura_id: "sub_VIGENTE",
          cakto_cliente_id: null,
          plano_id: "plano-1",
          preco_id: "preco-1",
        },
      },
    });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "subscription_renewal_refused", assinatura: { id: "sub_ANTIGA", status: null, proximaCobranca: null } }),
      { ...OPTS_BASE, organizacaoForcada: ORG },
    );
    expect(r).toMatchObject({ resultado: "ignorado_assinatura_antiga", organizationId: ORG, via: "organizacaoForcada" });
    expect(escritas).toEqual([]);
  });

  it("pago de uma assinatura ANTIGA que não veio por callback de checkout novo: aplica sem trocar o id vigente", async () => {
    const { db, escritas } = dbFalso({
      assinaturas: {
        data: {
          situacao: "ativa",
          liberado_ate: emDias(10).toISOString(),
          carencia_ate: null,
          cancelada_em: null,
          ultimo_evento_em: emDias(-1).toISOString(),
          cakto_assinatura_id: "sub_VIGENTE",
          cakto_cliente_id: null,
          plano_id: "plano-1",
          preco_id: "preco-1",
        },
      },
    });
    const r = await processarEventoDaCakto(
      db,
      evento({ evento: "subscription_renewed", assinatura: { id: "sub_OUTRA", status: "active", proximaCobranca: emDias(30) } }),
      { ...OPTS_BASE, organizacaoForcada: ORG },
    );
    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "organizacaoForcada", detalhe: "assinatura_antiga_cobrou" });
    const upsert = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert")!;
    // O id vigente NÃO mudou para a "outra" assinatura que pagou.
    expect((upsert.args[0] as Record<string, unknown>).cakto_assinatura_id).toBe("sub_VIGENTE");
  });

  it("TROCA de plano (callback de checkout novo, ainda sem pago_em): troca o id vigente e cancela a antiga na Cakto", async () => {
    const chamadasDeRede: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/token/")) {
        return new Response(JSON.stringify({ access_token: "tok_1", expires_in: 36_000 }), { status: 200 });
      }
      chamadasDeRede.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ status: "canceled" }), { status: 200 });
    });

    const { db, escritas } = dbFalso({
      cobranca_checkouts: { data: { session_id: "cb_troca", organization_id: ORG, plano_id: "plano-2", preco_id: "preco-2", pago_em: null } },
      assinaturas: {
        data: {
          situacao: "ativa",
          liberado_ate: emDias(5).toISOString(),
          carencia_ate: null,
          cancelada_em: null,
          ultimo_evento_em: emDias(-1).toISOString(),
          cakto_assinatura_id: "sub_ANTIGA",
          cakto_cliente_id: "cli_antigo",
          plano_id: "plano-1",
          preco_id: "preco-1",
        },
      },
      plano_precos: { data: { plano_id: "plano-2", valor_cents: 15000, moeda: "BRL", intervalo: "mensal" } },
    });

    const r = await processarEventoDaCakto(
      db,
      evento({
        evento: "purchase_approved",
        callback: "cb_troca",
        clienteId: "cli_novo",
        pedidoId: "ped_novo",
        assinatura: { id: "sub_NOVA", status: "active", proximaCobranca: emDias(30) },
      }),
      OPTS_BASE,
    );

    expect(r).toMatchObject({ resultado: "aplicado", organizationId: ORG, via: "callback" });
    expect(r.detalhe).toContain("assinatura_antiga_cancelamento:ok");

    const upsert = escritas.find((e) => e.tabela === "assinaturas" && e.metodo === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ cakto_assinatura_id: "sub_NOVA", cakto_cliente_id: "cli_novo", plano_id: "plano-2", preco_id: "preco-2" });

    expect(chamadasDeRede).toEqual(["POST https://api.cakto.com.br/public_api/subscriptions/sub_ANTIGA/cancel/"]);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assinatura.assinatura_antiga_cancelada",
        organizationId: ORG,
        metadata: { assinatura_antiga: "sub_ANTIGA", assinatura_nova: "sub_NOVA" },
      }),
    );
  });

  it("erro de banco AO LER a linha atual lança — a rota devolve 500 e a Cakto reentrega", async () => {
    const { db } = dbFalso({ assinaturas: { error: { message: "timeout" } } });
    await expect(
      processarEventoDaCakto(
        db,
        evento({ evento: "subscription_renewal_refused", assinatura: { id: "sub_1", status: null, proximaCobranca: null } }),
        { ...OPTS_BASE, organizacaoForcada: ORG },
      ),
    ).rejects.toThrow(/assinaturas\(organization_id\)/);
  });

  it("erro de banco AO GRAVAR lança", async () => {
    const { db } = dbFalso({
      assinaturas: [
        {
          data: {
            situacao: "ativa",
            liberado_ate: emDias(10).toISOString(),
            carencia_ate: null,
            cancelada_em: null,
            ultimo_evento_em: emDias(-1).toISOString(),
            cakto_assinatura_id: "sub_1",
            cakto_cliente_id: null,
            plano_id: "plano-1",
            preco_id: "preco-1",
          },
        },
        { error: { message: "boom" } },
      ],
    });
    await expect(
      processarEventoDaCakto(
        db,
        evento({ evento: "subscription_renewal_refused", assinatura: { id: "sub_1", status: null, proximaCobranca: null } }),
        { ...OPTS_BASE, organizacaoForcada: ORG },
      ),
    ).rejects.toThrow(/assinaturas\(upsert\)/);
  });
});
