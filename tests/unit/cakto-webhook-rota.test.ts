/**
 * A ROTA DO WEBHOOK DA CAKTO — AUTENTICAÇÃO, IDEMPOTÊNCIA E ERRO. SEM BANCO REAL.
 *
 * A decisão de QUEM É o pagamento e O QUE fazer com ele é de
 * `lib/planos/cakto/aplicar.ts` (testado à parte, com o banco dublado por
 * `dbFalso`) — aqui `processarEventoDaCakto` é um dublê controlável, e o que se
 * mede é o desfecho HTTP: os dois caminhos de autenticação, o recibo idempotente
 * (inclusive o caso reservado-e-não-concluído) e que o e-mail do pagador nunca
 * aparece nem no recibo nem no log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CaktoCliente from "@/lib/planos/cakto/cliente";

vi.mock("@/lib/planos/cakto/cliente", async (importOriginal) => {
  const original = await importOriginal<typeof CaktoCliente>();
  return { ...original, credenciaisDaCakto: vi.fn() };
});
vi.mock("@/lib/planos/cakto/aplicar", () => ({ processarEventoDaCakto: vi.fn() }));
vi.mock("@/lib/planos/config", () => ({
  lerConfigDeCobranca: vi.fn().mockResolvedValue({ ligada: true, diasDeTeste: 14, carenciaDias: 5, modoDeLimite: "avisar" }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

let dbAtual: unknown;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dbAtual }));

import { POST } from "@/app/api/v1/webhooks/cakto/route";
import { logger } from "@/lib/logger";
import { processarEventoDaCakto, type ResultadoDoEventoDaCakto } from "@/lib/planos/cakto/aplicar";
import { credenciaisDaCakto, type CredenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import { assinarParaTeste } from "@/lib/planos/cakto/webhook";

import { dbFalso } from "./helpers/db-falso-planos";

const CRED: CredenciaisDaCakto = { clientId: "cid", clientSecret: "csecret", webhookSecret: "whsec_teste" };

function requisicao(corpo: string, headers: Record<string, string> = {}) {
  return {
    text: async () => corpo,
    headers: new Headers(headers),
  } as unknown as Parameters<typeof POST>[0];
}

function assinada(corpo: string, segredo: string, t = Math.floor(Date.now() / 1000)) {
  return requisicao(corpo, { "x-cakto-signature": assinarParaTeste(corpo, segredo, t), "x-cakto-timestamp": String(t) });
}

const EVENTO_VALIDO = JSON.stringify({ event: "purchase_approved", data: { id: "ped_1", callback: "cb-token-valido" } });

beforeEach(() => {
  vi.mocked(credenciaisDaCakto).mockResolvedValue(CRED);
  vi.mocked(processarEventoDaCakto).mockResolvedValue({ resultado: "aplicado", organizationId: "org-1", via: "callback" });
  const { db } = dbFalso({});
  dbAtual = db;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sem CAKTO_WEBHOOK_SECRET configurado", () => {
  it("404 — a rota não existe até ser configurada", async () => {
    vi.mocked(credenciaisDaCakto).mockResolvedValue({ ...CRED, webhookSecret: null });
    const res = await POST(assinada(EVENTO_VALIDO, "qualquer"));
    expect(res.status).toBe(404);
  });
});

describe("autenticação", () => {
  it("401 — HMAC com segredo errado", async () => {
    const res = await POST(assinada(EVENTO_VALIDO, "segredo_errado"));
    expect(res.status).toBe(401);
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });

  it("401 — segredo no corpo errado, sem cabeçalho de assinatura", async () => {
    const corpo = JSON.stringify({ event: "purchase_approved", secret: "segredo_errado", data: { id: "p1" } });
    const res = await POST(requisicao(corpo));
    expect(res.status).toBe(401);
  });

  it("200 — segredo no corpo CORRETO, sem cabeçalho de assinatura, é aceito", async () => {
    const corpo = JSON.stringify({ event: "purchase_approved", secret: CRED.webhookSecret, data: { id: "p1" } });
    const res = await POST(requisicao(corpo));
    expect(res.status).toBe(200);
  });

  it("400 — corpo autenticado mas sem `event`: evento inesperado", async () => {
    const corpo = JSON.stringify({ data: { id: "p1" } });
    const res = await POST(assinada(corpo, CRED.webhookSecret!));
    expect(res.status).toBe(400);
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });
});

describe("efeito e resposta", () => {
  it("200 aplicado — HMAC válido, processado e devolvido", async () => {
    const res = await POST(assinada(EVENTO_VALIDO, CRED.webhookSecret!));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { recebido: boolean; resultado: string } };
    expect(corpo.data).toEqual({ recebido: true, resultado: "aplicado" });
    expect(processarEventoDaCakto).toHaveBeenCalledTimes(1);
  });

  it("500 — falha ao processar grava o erro no recibo e não repassa a causa ao cliente", async () => {
    vi.mocked(processarEventoDaCakto).mockRejectedValue(new Error("boom de teste"));
    const { db, escritas } = dbFalso({});
    dbAtual = db;

    const res = await POST(assinada(EVENTO_VALIDO, CRED.webhookSecret!));
    expect(res.status).toBe(500);

    const erroGravado = escritas.find((e) => e.tabela === "cobranca_eventos_cakto" && e.metodo === "update");
    expect((erroGravado!.args[0] as Record<string, unknown>).erro).toContain("boom de teste");
  });
});

describe("idempotência", () => {
  it("200 duplicado — chave já processada (23505 + processado_em preenchido)", async () => {
    const { db } = dbFalso({
      cobranca_eventos_cakto: [
        { error: { code: "23505", message: "duplicate key" } },
        { data: { processado_em: "2026-09-29T00:00:00Z", recebido_em: "2026-09-29T00:00:00Z" } },
      ],
    });
    dbAtual = db;

    const res = await POST(assinada(EVENTO_VALIDO, CRED.webhookSecret!));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toEqual({ recebido: true, resultado: "duplicado" });
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });

  it("200 em_processamento — chave reservada há menos de 60s, ainda sem `processado_em`", async () => {
    const { db } = dbFalso({
      cobranca_eventos_cakto: [
        { error: { code: "23505", message: "duplicate key" } },
        { data: { processado_em: null, recebido_em: new Date(Date.now() - 1_000).toISOString() } },
      ],
    });
    dbAtual = db;

    const res = await POST(assinada(EVENTO_VALIDO, CRED.webhookSecret!));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toMatchObject({ em_processamento: true });
    expect(processarEventoDaCakto).not.toHaveBeenCalled();
  });
});

describe("o e-mail do pagador NUNCA aparece", () => {
  const EMAIL = "pagador-secreto@empresa.com";
  const CORPO_COM_EMAIL = JSON.stringify({
    event: "purchase_approved",
    data: { id: "ped_2", customer: { id: "cli_2", email: EMAIL } },
  });

  it("nem no recibo gravado, nem em nenhum log da rota", async () => {
    vi.mocked(processarEventoDaCakto).mockResolvedValue({
      resultado: "sem_organizacao",
      organizationId: null,
      via: null,
    } satisfies ResultadoDoEventoDaCakto);
    const avisos = vi.spyOn(logger, "warn");
    const erros = vi.spyOn(logger, "error");
    const { db, escritas } = dbFalso({});
    dbAtual = db;

    const res = await POST(assinada(CORPO_COM_EMAIL, CRED.webhookSecret!));
    expect(res.status).toBe(200);

    expect(JSON.stringify(escritas)).not.toContain(EMAIL);
    const textoDosLogs = JSON.stringify([...avisos.mock.calls, ...erros.mock.calls]);
    expect(textoDosLogs).not.toContain(EMAIL);
  });
});
