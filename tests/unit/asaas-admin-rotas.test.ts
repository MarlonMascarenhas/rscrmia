/**
 * AS ROTAS ADMIN DA COBRANÇA PELO ASAAS — TESTAR CREDENCIAIS E VINCULAR EVENTO SEM
 * DONO. SEM BANCO REAL (`dbFalso`, o mesmo dublê de `asaas-webhook-rota.test.ts`).
 *
 * `asaasPronto` fica REAL (a mensagem "Credenciais do Asaas incompletas." só faz
 * sentido se a checagem for a mesma que a instalação usa em toda parte); só
 * `credenciaisDoAsaas`/`testarCredenciaisDoAsaas` são dublês.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type * as AsaasCliente from "@/lib/planos/asaas/cliente";

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/planos/asaas/cliente", async (importOriginal) => {
  const original = await importOriginal<typeof AsaasCliente>();
  return { ...original, credenciaisDoAsaas: vi.fn(), testarCredenciaisDoAsaas: vi.fn() };
});
vi.mock("@/lib/planos/asaas/aplicar", () => ({ processarEventoDoAsaas: vi.fn() }));
vi.mock("@/lib/planos/config", () => ({ lerConfigDeCobranca: vi.fn() }));

let dbAtual: unknown;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dbAtual }));

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import {
  credenciaisDoAsaas,
  testarCredenciaisDoAsaas,
  type CredenciaisDoAsaas,
  type RespostaDoAsaas,
} from "@/lib/planos/asaas/cliente";
import { processarEventoDoAsaas, type ResultadoDoEventoDoAsaas } from "@/lib/planos/asaas/aplicar";
import { lerConfigDeCobranca } from "@/lib/planos/config";

import { dbFalso } from "./helpers/db-falso-planos";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const CRED_COMPLETA: CredenciaisDoAsaas = { apiKey: "$aact_hmlg_x", webhookToken: "t".repeat(40), ambiente: "sandbox" };

function ctxAdmin(scope: "full" | "support_readonly" = "full") {
  return { user: { id: ADMIN_ID }, platformAdmin: { user_id: ADMIN_ID, scope, mfa_required: true } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requirePlatformAdmin).mockResolvedValue(ctxAdmin());
  vi.mocked(lerConfigDeCobranca).mockResolvedValue({ ligada: true, diasDeTeste: 14, carenciaDias: 5, modoDeLimite: "avisar" });
});

describe("POST /api/v1/admin/cobranca/asaas/testar", () => {
  async function chamar() {
    const { POST } = await import("@/app/api/v1/admin/cobranca/asaas/testar/route");
    return POST();
  }

  it("não-admin → 403", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("nope"));
    expect((await chamar()).status).toBe(403);
    expect(testarCredenciaisDoAsaas).not.toHaveBeenCalled();
  });

  it("modo suporte sem escrita → a recusa do guarda, sem chamar o Asaas", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response("negado", { status: 403 }) as never);
    expect((await chamar()).status).toBe(403);
    expect(testarCredenciaisDoAsaas).not.toHaveBeenCalled();
  });

  it("sem credenciais → 422 com a mensagem canônica", async () => {
    vi.mocked(credenciaisDoAsaas).mockResolvedValue({ apiKey: null, webhookToken: null, ambiente: "sandbox" });
    const res = await chamar();
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Credenciais do Asaas incompletas.");
  });

  it("chave recusada pelo Asaas → 502 com a mensagem do provedor", async () => {
    vi.mocked(credenciaisDoAsaas).mockResolvedValue(CRED_COMPLETA);
    vi.mocked(testarCredenciaisDoAsaas).mockResolvedValue({
      ok: false,
      status: 401,
      mensagem: "A chave de API informada é inválida",
      codigo: "invalid_access_token",
    } satisfies RespostaDoAsaas<Record<string, unknown>>);
    const res = await chamar();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("A chave de API informada é inválida");
  });

  it("chave de OUTRO ambiente (401 invalid_environment) → 502 que diz isso, com o ambiente testado", async () => {
    vi.mocked(credenciaisDoAsaas).mockResolvedValue({ ...CRED_COMPLETA, ambiente: "producao" });
    vi.mocked(testarCredenciaisDoAsaas).mockResolvedValue({
      ok: false,
      status: 401,
      mensagem: "x",
      codigo: "invalid_environment",
    } satisfies RespostaDoAsaas<Record<string, unknown>>);
    const res = await chamar();
    expect(res.status).toBe(502);
    const corpo = (await res.json()) as { error: { message: string; details: { ambiente: string } } };
    expect(corpo.error.message).toContain("não é do ambiente producao");
    expect(corpo.error.details.ambiente).toBe("producao");
  });

  it("credenciais válidas → 200 com o ambiente testado", async () => {
    vi.mocked(credenciaisDoAsaas).mockResolvedValue(CRED_COMPLETA);
    vi.mocked(testarCredenciaisDoAsaas).mockResolvedValue({ ok: true, status: 200, dados: {} });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ ok: true, ambiente: "sandbox" });
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
    eventoId: "evt_1",
    evento: "PAYMENT_RECEIVED",
    pagamentoId: "pay_1",
    assinaturaId: "sub_1",
    clienteId: "cus_1",
    referenciaExterna: null,
    faturaUrl: null,
    vencimento: "2026-10-18",
    billingType: "PIX",
  };

  function linhaDoEvento(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      chave: "evt_1",
      entrada: ENTRADA_VALIDA,
      processado_em: null,
      resultado: null,
      recebido_em: "2026-10-18T00:00:05Z",
      ...overrides,
    };
  }

  it("não-admin → 403", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("nope"));
    expect((await chamar({ chave: "evt_1", organization_slug: "acme" })).status).toBe(403);
  });

  it("super-admin de leitura → 403 (ligar pagamento decide quem tem acesso)", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue(ctxAdmin("support_readonly"));
    expect((await chamar({ chave: "evt_1", organization_slug: "acme" })).status).toBe(403);
  });

  it("corpo inválido → 422", async () => {
    expect((await chamar({ chave: "x" })).status).toBe(422);
    expect((await chamar({ chave: "evt_1", organization_slug: "acme", intruso: true })).status).toBe(422);
  });

  it("organização inexistente → 404", async () => {
    const { db } = dbFalso({ organizations: { data: null } });
    dbAtual = db;
    expect((await chamar({ chave: "evt_1", organization_slug: "nao-existe" })).status).toBe(404);
  });

  it("evento inexistente → 404", async () => {
    const { db } = dbFalso({ organizations: { data: { id: ORG_ID } }, cobranca_eventos_asaas: { data: null } });
    dbAtual = db;
    expect((await chamar({ chave: "evt_1", organization_slug: "acme" })).status).toBe(404);
  });

  it("evento já processado COM organização → 409", async () => {
    const { db } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_asaas: { data: linhaDoEvento({ processado_em: "2026-10-18T01:00:00Z", resultado: "aplicado" }) },
    });
    dbAtual = db;
    expect((await chamar({ chave: "evt_1", organization_slug: "acme" })).status).toBe(409);
    expect(processarEventoDoAsaas).not.toHaveBeenCalled();
  });

  it("evento sem_organizacao: reprocessa com a organização FORÇADA, grava o autor e audita", async () => {
    const { db, escritas } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_asaas: [{ data: linhaDoEvento({ processado_em: "2026-10-18T01:00:00Z", resultado: "sem_organizacao" }) }, {}],
    });
    dbAtual = db;
    vi.mocked(processarEventoDoAsaas).mockResolvedValue({
      resultado: "aplicado",
      organizationId: ORG_ID,
      via: "organizacaoForcada",
    } satisfies ResultadoDoEventoDoAsaas);

    const res = await chamar({ chave: "evt_1", organization_slug: "acme" });
    expect(res.status).toBe(200);
    expect(vi.mocked(processarEventoDoAsaas).mock.calls[0]![1]).toMatchObject({ evento: "PAYMENT_RECEIVED", pagamentoId: "pay_1" });
    expect(vi.mocked(processarEventoDoAsaas).mock.calls[0]![2]).toMatchObject({ organizacaoForcada: ORG_ID });

    const gravado = escritas.find((e) => e.tabela === "cobranca_eventos_asaas" && e.metodo === "update")!.args[0] as Record<string, unknown>;
    expect(gravado).toMatchObject({ resultado: "aplicado", organization_id: ORG_ID, vinculado_por: ADMIN_ID, erro: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "assinatura.evento_vinculado_manualmente" }));
  });

  it("registro que não reconstrói o evento → 422", async () => {
    const { db } = dbFalso({
      organizations: { data: { id: ORG_ID } },
      cobranca_eventos_asaas: { data: linhaDoEvento({ entrada: { lixo: true } }) },
    });
    dbAtual = db;
    expect((await chamar({ chave: "evt_1", organization_slug: "acme" })).status).toBe(422);
  });
});
