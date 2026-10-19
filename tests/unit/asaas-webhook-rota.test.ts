/**
 * A ROTA DO WEBHOOK DO ASAAS — AUTENTICAÇÃO, IDEMPOTÊNCIA E ERRO. SEM BANCO REAL.
 *
 * A decisão de QUEM É o pagamento e O QUE fazer com ele é de
 * `lib/planos/asaas/aplicar.ts` (testado à parte) — aqui `processarEventoDoAsaas` é
 * um dublê controlável, e o que se mede é o desfecho HTTP. O Asaas só considera
 * entregue o HTTP 200 e PAUSA a fila após 15 falhas seguidas, então: duplicata,
 * evento ignorado e payload ilegível respondem 200; só a falha real e recuperável
 * responde 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AsaasCliente from "@/lib/planos/asaas/cliente";

vi.mock("@/lib/planos/asaas/cliente", async (importOriginal) => {
  const original = await importOriginal<typeof AsaasCliente>();
  return { ...original, credenciaisDoAsaas: vi.fn() };
});
vi.mock("@/lib/planos/asaas/aplicar", () => ({ processarEventoDoAsaas: vi.fn() }));
vi.mock("@/lib/planos/config", () => ({
  lerConfigDeCobranca: vi.fn().mockResolvedValue({ ligada: true, diasDeTeste: 14, carenciaDias: 5, modoDeLimite: "avisar" }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

let dbAtual: unknown;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dbAtual }));

import { POST } from "@/app/api/v1/webhooks/asaas/route";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { processarEventoDoAsaas } from "@/lib/planos/asaas/aplicar";
import { credenciaisDoAsaas, type CredenciaisDoAsaas } from "@/lib/planos/asaas/cliente";

import { dbFalso } from "./helpers/db-falso-planos";

const TOKEN = "token-do-webhook-com-mais-de-32-caracteres";
const CRED: CredenciaisDoAsaas = { apiKey: "$aact_hmlg_x", webhookToken: TOKEN, ambiente: "sandbox" };

function requisicao(corpo: string, token: string | null = TOKEN) {
  return {
    text: async () => corpo,
    headers: new Headers(token === null ? {} : { "asaas-access-token": token }),
  } as unknown as Parameters<typeof POST>[0];
}

const EVENTO_VALIDO = JSON.stringify({
  id: "evt_1&99",
  event: "PAYMENT_RECEIVED",
  payment: { id: "pay_1", subscription: "sub_1", dueDate: "2026-10-18", externalReference: "dc_tok" },
});

beforeEach(() => {
  vi.mocked(credenciaisDoAsaas).mockResolvedValue(CRED);
  vi.mocked(processarEventoDoAsaas).mockResolvedValue({ resultado: "aplicado", organizationId: "org-1", via: "token" });
  const { db } = dbFalso({});
  dbAtual = db;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sem ASAAS_WEBHOOK_TOKEN configurado", () => {
  it("404 — a rota não existe até ser configurada", async () => {
    vi.mocked(credenciaisDoAsaas).mockResolvedValue({ ...CRED, webhookToken: null });
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(404);
    expect(processarEventoDoAsaas).not.toHaveBeenCalled();
  });
});

describe("autenticação pelo header asaas-access-token", () => {
  it("401 — token errado", async () => {
    const res = await POST(requisicao(EVENTO_VALIDO, "token-errado"));
    expect(res.status).toBe(401);
    expect(processarEventoDoAsaas).not.toHaveBeenCalled();
  });

  it("401 — header ausente", async () => {
    const res = await POST(requisicao(EVENTO_VALIDO, null));
    expect(res.status).toBe(401);
  });

  it("200 — token certo", async () => {
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(200);
  });

  it("autenticado mas ilegível: 200 e IGNORADO — repetir não conserta, e não pode contar para a fila pausar", async () => {
    for (const corpo of ["{não é json", JSON.stringify({ sem: "id nem event" })]) {
      const res = await POST(requisicao(corpo));
      expect(res.status).toBe(200);
      const j = (await res.json()) as { data: Record<string, unknown> };
      expect(j.data).toEqual({ recebido: true, resultado: "ignorado_ilegivel" });
    }
    expect(processarEventoDoAsaas).not.toHaveBeenCalled();
  });
});

describe("efeito e resposta", () => {
  it("200 aplicado — e o recibo usa o id do EVENTO como chave", async () => {
    const { db, escritas } = dbFalso({});
    dbAtual = db;
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { recebido: boolean; resultado: string } };
    expect(corpo.data).toEqual({ recebido: true, resultado: "aplicado" });
    expect(processarEventoDoAsaas).toHaveBeenCalledTimes(1);

    const reserva = escritas.find((e) => e.tabela === "cobranca_eventos_asaas" && e.metodo === "insert")!.args[0] as Record<string, unknown>;
    expect(reserva).toMatchObject({ chave: "evt_1&99", evento: "PAYMENT_RECEIVED", pagamento_id: "pay_1", organization_id: null });
    const fechamento = escritas.filter((e) => e.tabela === "cobranca_eventos_asaas" && e.metodo === "update").pop()!.args[0] as Record<string, unknown>;
    expect(fechamento).toMatchObject({ resultado: "aplicado", organization_id: "org-1", erro: null });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "assinatura.evento_do_provedor" }));
  });

  it("200 — evento ignorado não audita", async () => {
    vi.mocked(processarEventoDoAsaas).mockResolvedValue({ resultado: "ignorado_tipo", organizationId: null, via: null });
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("500 — falha real ao processar grava o erro no recibo e não repassa a causa ao Asaas", async () => {
    vi.mocked(processarEventoDoAsaas).mockRejectedValue(new Error("boom de teste"));
    const { db, escritas } = dbFalso({});
    dbAtual = db;

    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom de teste");

    const erroGravado = escritas.find((e) => e.tabela === "cobranca_eventos_asaas" && e.metodo === "update");
    expect((erroGravado!.args[0] as Record<string, unknown>).erro).toContain("boom de teste");
  });

  it("500 — o banco recusa a reserva (que não é duplicata)", async () => {
    const { db } = dbFalso({ cobranca_eventos_asaas: { error: { code: "XX000", message: "banco fora" } } });
    dbAtual = db;
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(500);
    expect(processarEventoDoAsaas).not.toHaveBeenCalled();
  });
});

describe("idempotência (entrega at-least-once)", () => {
  const DUPLICATA = { error: { code: "23505", message: "duplicate key" } };

  it("200 duplicado — id do evento já processado", async () => {
    const { db } = dbFalso({
      cobranca_eventos_asaas: [DUPLICATA, { data: { processado_em: "2026-10-18T00:00:00Z", recebido_em: "2026-10-18T00:00:00Z", erro: null } }],
    });
    dbAtual = db;
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toEqual({ recebido: true, resultado: "duplicado" });
    expect(processarEventoDoAsaas).not.toHaveBeenCalled();
  });

  it("200 em_processamento — reservado há menos de 60s, ainda sem `processado_em` e sem erro", async () => {
    const { db } = dbFalso({
      cobranca_eventos_asaas: [
        DUPLICATA,
        { data: { processado_em: null, recebido_em: new Date(Date.now() - 1_000).toISOString(), erro: null } },
      ],
    });
    dbAtual = db;
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({ em_processamento: true });
    expect(processarEventoDoAsaas).not.toHaveBeenCalled();
  });

  it("a REENTREGA de um evento que FALHOU reprocessa — mesmo dentro dos 60s", async () => {
    const { db } = dbFalso({
      cobranca_eventos_asaas: [
        DUPLICATA,
        { data: { processado_em: null, recebido_em: new Date(Date.now() - 1_000).toISOString(), erro: "boom" } },
      ],
    });
    dbAtual = db;
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(200);
    expect(processarEventoDoAsaas).toHaveBeenCalledTimes(1);
  });

  it("reservado há mais de 60s e nunca concluído: reprocessa", async () => {
    const { db } = dbFalso({
      cobranca_eventos_asaas: [
        DUPLICATA,
        { data: { processado_em: null, recebido_em: new Date(Date.now() - 120_000).toISOString(), erro: null } },
      ],
    });
    dbAtual = db;
    const res = await POST(requisicao(EVENTO_VALIDO));
    expect(res.status).toBe(200);
    expect(processarEventoDoAsaas).toHaveBeenCalledTimes(1);
  });
});

describe("o token do webhook NUNCA aparece em log", () => {
  it("nem na recusa", async () => {
    const avisos = vi.spyOn(logger, "warn");
    await POST(requisicao(EVENTO_VALIDO, "um-token-errado-qualquer-com-mais-de-32-caracteres"));
    const texto = JSON.stringify(avisos.mock.calls);
    expect(texto).not.toContain("um-token-errado-qualquer");
    expect(texto).not.toContain(TOKEN);
  });
});
