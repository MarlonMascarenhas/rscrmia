/**
 * AS DUAS ROTAS ADMIN DA COBRANÇA PELA CAKTO — TESTAR CREDENCIAIS E VINCULAR
 * EVENTO SEM DONO. SEM BANCO REAL (`dbFalso`, o mesmo dublê de
 * `cakto-webhook-rota.test.ts`).
 *
 * `caktoPronto` fica REAL (a mensagem "Credenciais da Cakto incompletas." só faz
 * sentido se a checagem for a mesma que a instalação usa em toda parte); só
 * `credenciaisDaCakto`/`obterToken` são dublês.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as CaktoCliente from "@/lib/planos/cakto/cliente";

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/planos/cakto/cliente", async (importOriginal) => {
  const original = await importOriginal<typeof CaktoCliente>();
  return { ...original, credenciaisDaCakto: vi.fn(), obterToken: vi.fn() };
});
vi.mock("@/lib/planos/cakto/aplicar", () => ({ processarEventoDaCakto: vi.fn() }));
vi.mock("@/lib/planos/config", () => ({ lerConfigDeCobranca: vi.fn() }));

let dbAtual: unknown;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dbAtual }));

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { credenciaisDaCakto, obterToken, type CredenciaisDaCakto, type ResultadoDoToken } from "@/lib/planos/cakto/cliente";
import { processarEventoDaCakto, type ResultadoDoEventoDaCakto } from "@/lib/planos/cakto/aplicar";
import { lerConfigDeCobranca } from "@/lib/planos/config";

import { dbFalso } from "./helpers/db-falso-planos";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const CRED_COMPLETA: CredenciaisDaCakto = { clientId: "cid", clientSecret: "csecret", webhookSecret: "whsec" };

function ctxAdmin(scope: "full" | "support_readonly" = "full") {
  return { user: { id: ADMIN_ID }, platformAdmin: { user_id: ADMIN_ID, scope, mfa_required: true } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requirePlatformAdmin).mockResolvedValue(ctxAdmin());
  vi.mocked(lerConfigDeCobranca).mockResolvedValue({ ligada: true, diasDeTeste: 14, carenciaDias: 5, modoDeLimite: "avisar" });
});

describe("POST /api/v1/admin/cobranca/cakto/testar", () => {
  async function chamar() {
    const { POST } = await import("@/app/api/v1/admin/cobranca/cakto/testar/route");
    return POST();
  }

  it("não-admin → 403", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("nope"));
    const res = await chamar();
    expect(res.status).toBe(403);
  });

  it("sem credenciais → 422 com a mensagem canônica", async () => {
    vi.mocked(credenciaisDaCakto).mockResolvedValue({ clientId: null, clientSecret: null, webhookSecret: null });
    const res = await chamar();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Credenciais da Cakto incompletas.");
  });

  it("token recusado pela Cakto → 502 com a mensagem do provedor", async () => {
    vi.mocked(credenciaisDaCakto).mockResolvedValue(CRED_COMPLETA);
    vi.mocked(obterToken).mockResolvedValue({ ok: false, mensagem: "HTTP 401" } satisfies ResultadoDoToken);
    const res = await chamar();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("HTTP 401");
  });

  it("credenciais válidas e token concedido → 200 { ok: true }", async () => {
    vi.mocked(credenciaisDaCakto).mockResolvedValue(CRED_COMPLETA);
    vi.mocked(obterToken).mockResolvedValue({ ok: true, token: "tok" } satisfies ResultadoDoToken);
    const res = await chamar();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ok: boolean } };
    expect(body.data).toEqual({ ok: true });
  });
});

describe("POST /api/v1/admin/cobranca/eventos/vincular", () => {
  function req(corpo: unknown) {
    return new NextRequest("http://localhost/api/v1/admin/cobranca/eventos/vincular", {
      method: "POST",
      body: JSON.stringify(corpo),
    });
  }

  async function chamar(corpo: unknown) {
    const { POST } = await import("@/app/api/v1/admin/cobranca/eventos/vincular/route");
    return POST(req(corpo));
  }

  const ENTRADA_VALIDA = {
    evento: "purchase_approved",
    pedidoId: "ped_1",
    callback: "cb-token",
    clienteId: null,
    produtoId: null,
    ofertaId: null,
    assinatura: null,
  };

  function linhaDoEvento(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      chave: "purchase_approved:ped_1",
      entrada: ENTRADA_VALIDA,
      processado_em: null,
      resultado: null,
      enviado_em: "2026-09-29T00:00:00Z",
      recebido_em: "2026-09-29T00:00:05Z",
      ...overrides,
    };
  }

  it("não-admin → 403", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("nope"));
    const res = await chamar({ chave: "x", organization_slug: "acme" });
    expect(res.status).toBe(403);
  });

  it("escopo somente leitura → 403", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue(ctxAdmin("support_readonly"));
    const res = await chamar({ chave: "x", organization_slug: "acme" });
    expect(res.status).toBe(403);
  });

  it("corpo inválido → 422", async () => {
    const res = await chamar({ chave: "x" });
    expect(res.status).toBe(422);
  });

  it("organização inexistente → 404", async () => {
    const { db } = dbFalso({ organizations: { data: null }, cobranca_eventos_cakto: { data: linhaDoEvento() } });
    dbAtual = db;
    const res = await chamar({ chave: "purchase_approved:ped_1", organization_slug: "nao-existe" });
    expect(res.status).toBe(404);
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });

  it("evento inexistente → 404", async () => {
    const { db } = dbFalso({ organizations: { data: { id: ORG_ID } }, cobranca_eventos_cakto: { data: null } });
    dbAtual = db;
    const res = await chamar({ chave: "nao-existe", organization_slug: "acme" });
    expect(res.status).toBe(404);
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });

  it("evento já processado com outro resultado → 409", async () => {
    const { db } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_cakto: { data: linhaDoEvento({ processado_em: "2026-09-29T01:00:00Z", resultado: "aplicado" }) },
    });
    dbAtual = db;
    const res = await chamar({ chave: "purchase_approved:ped_1", organization_slug: "acme" });
    expect(res.status).toBe(409);
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });

  it("evento sem_organizacao pode ser religado (não é o estado bloqueado)", async () => {
    const { db } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_cakto: {
        data: linhaDoEvento({ processado_em: "2026-09-29T01:00:00Z", resultado: "sem_organizacao" }),
      },
    });
    dbAtual = db;
    vi.mocked(processarEventoDaCakto).mockResolvedValue({
      resultado: "aplicado",
      organizationId: ORG_ID,
      via: "organizacaoForcada",
    } satisfies ResultadoDoEventoDaCakto);

    const res = await chamar({ chave: "purchase_approved:ped_1", organization_slug: "acme" });
    expect(res.status).toBe(200);
    expect(processarEventoDaCakto).toHaveBeenCalledTimes(1);
  });

  it("sucesso: chama processarEventoDaCakto com organizacaoForcada certo, grava vinculado_por e audita", async () => {
    const { db, escritas } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_cakto: { data: linhaDoEvento() },
    });
    dbAtual = db;
    vi.mocked(processarEventoDaCakto).mockResolvedValue({
      resultado: "aplicado",
      organizationId: ORG_ID,
      via: "organizacaoForcada",
    } satisfies ResultadoDoEventoDaCakto);

    const res = await chamar({ chave: "purchase_approved:ped_1", organization_slug: "acme" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { resultado: string } };
    expect(body.data).toEqual({ resultado: "aplicado" });

    expect(processarEventoDaCakto).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(processarEventoDaCakto).mock.calls[0]![2];
    expect(opts.organizacaoForcada).toBe(ORG_ID);

    const escritaFinal = escritas.find((e) => e.tabela === "cobranca_eventos_cakto" && e.metodo === "update");
    expect((escritaFinal!.args[0] as Record<string, unknown>).vinculado_por).toBe(ADMIN_ID);
    expect((escritaFinal!.args[0] as Record<string, unknown>).resultado).toBe("aplicado");
    expect((escritaFinal!.args[0] as Record<string, unknown>).organization_id).toBe(ORG_ID);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assinatura.evento_vinculado_manualmente",
        actorUserId: ADMIN_ID,
        organizationId: ORG_ID,
        metadata: expect.objectContaining({ chave: "purchase_approved:ped_1", resultado: "aplicado", organization_id: ORG_ID }),
      }),
    );
  });

  it("entrada não reconstruível → 422, sem chamar processarEventoDaCakto", async () => {
    const { db } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_cakto: { data: linhaDoEvento({ entrada: {} }) },
    });
    dbAtual = db;
    const res = await chamar({ chave: "purchase_approved:ped_1", organization_slug: "acme" });
    expect(res.status).toBe(422);
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });

  it("erro do processamento → 500 e o erro é gravado no recibo", async () => {
    const { db, escritas } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_cakto: { data: linhaDoEvento() },
    });
    dbAtual = db;
    vi.mocked(processarEventoDaCakto).mockRejectedValue(new Error("boom de teste"));

    const res = await chamar({ chave: "purchase_approved:ped_1", organization_slug: "acme" });
    expect(res.status).toBe(500);

    const escritaDeErro = escritas.find((e) => e.tabela === "cobranca_eventos_cakto" && e.metodo === "update");
    expect((escritaDeErro!.args[0] as Record<string, unknown>).erro).toContain("boom de teste");
    expect(audit).not.toHaveBeenCalled();
  });
});
