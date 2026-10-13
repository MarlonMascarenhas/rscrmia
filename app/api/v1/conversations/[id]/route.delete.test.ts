import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  requireSupportWrite: vi.fn(),
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  peekRateLimit: vi.fn(),
  verificarSenha: vi.fn(),
  audit: vi.fn(),
  remove: vi.fn(),
  tabelas: {} as Record<string, unknown>,
  deleteCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  peekRateLimit: mocks.peekRateLimit,
}));
vi.mock("@/lib/auth/senha-de-exclusao", () => ({ verificarSenha: mocks.verificarSenha }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("../_handler", () => ({ getConversationHandler: vi.fn(), patchConversationHandler: vi.fn() }));
vi.mock("@/lib/users/com-nome-do-atendente", () => ({ comNomeDoAtendente: vi.fn() }));

/** Builder encadeável e "thenable" que devolve o que a tabela pedir. */
function builder(tabela: string) {
  const resp = () => mocks.tabelas[tabela] as { data?: unknown; error?: unknown; count?: number };
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not"]) b[m] = () => b;
  b.delete = () => {
    mocks.deleteCalls.push({ tabela });
    return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
  };
  b.maybeSingle = () => Promise.resolve({ data: resp().data ?? null, error: resp().error ?? null });
  b.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: resp().data ?? null, error: null, count: resp().count ?? 0 }).then(ok);
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => builder(t),
    storage: { from: () => ({ remove: mocks.remove }) },
  }),
}));

import { DELETE } from "./route";

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = (id = CONV) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteCalls.length = 0;
  mocks.requireSupportWrite.mockResolvedValue(null);
  mocks.requireRole.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  });
  // Contador de falhas com a mesma semântica do módulo real: peek lê, check incrementa.
  let falhas = 0;
  mocks.peekRateLimit.mockImplementation(async () => falhas);
  mocks.checkRateLimit.mockImplementation(async () => {
    falhas += 1;
    return { allowed: falhas <= 5, count: falhas, limit: 5, window_sec: 900 };
  });
  mocks.verificarSenha.mockResolvedValue(true);
  mocks.remove.mockResolvedValue({ error: null });
  mocks.tabelas = {
    organization_conversation_delete_secret: { data: { password_hash: "scrypt$x$y" } },
    conversations: { data: { id: CONV } },
    messages: { data: [{ media_storage_path: `${ORG}/${CONV}/a.jpg` }], count: 3 },
  };
});

describe("DELETE /api/v1/conversations/[id]", () => {
  it("409 quando a organização não definiu a senha", async () => {
    mocks.tabelas.organization_conversation_delete_secret = { data: null };
    const res = await DELETE(req({ password: "abcdef" }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("conversation_delete_password_not_set");
    expect(mocks.deleteCalls).toHaveLength(0);
  });

  it("403 invalid_password com senha errada, sem excluir", async () => {
    mocks.verificarSenha.mockResolvedValue(false);
    const res = await DELETE(req({ password: "errada" }), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("invalid_password");
    expect(mocks.deleteCalls).toHaveLength(0);
  });

  it("404 quando a conversa não é da organização", async () => {
    mocks.tabelas.conversations = { data: null };
    const res = await DELETE(req({ password: "abcdef" }), ctx());
    expect(res.status).toBe(404);
    expect(mocks.deleteCalls).toHaveLength(0);
  });

  it("200: remove a mídia do bucket, exclui e audita com messages_count", async () => {
    const res = await DELETE(req({ password: "abcdef" }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ deleted: true });
    expect(mocks.remove).toHaveBeenCalledWith([`${ORG}/${CONV}/a.jpg`]);
    expect(mocks.deleteCalls).toEqual([{ tabela: "conversations" }]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.deleted",
        organizationId: ORG,
        resourceId: CONV,
        metadata: { messages_count: 3 },
      }),
    );
  });

  it("200 mesmo se o storage falhar (só loga)", async () => {
    mocks.remove.mockResolvedValue({ error: { message: "boom" } });
    const res = await DELETE(req({ password: "abcdef" }), ctx());
    expect(res.status).toBe(200);
    expect(mocks.deleteCalls).toHaveLength(1);
  });

  it("429 com Retry-After quando as falhas da janela chegam ao teto, sem tocar no banco", async () => {
    mocks.peekRateLimit.mockResolvedValue(5);
    const res = await DELETE(req({ password: "abcdef" }), ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("900");
    expect(mocks.verificarSenha).not.toHaveBeenCalled();
    expect(mocks.deleteCalls).toHaveLength(0);
  });

  it("6 exclusões seguidas com a senha certa não dão 429 (sucesso não conta)", async () => {
    for (let i = 0; i < 6; i++) {
      const res = await DELETE(req({ password: "abcdef" }), ctx());
      expect(res.status).toBe(200);
    }
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.deleteCalls).toHaveLength(6);
  });

  it("5 senhas erradas dão 403 e a 6ª tentativa dá 429", async () => {
    mocks.verificarSenha.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      const res = await DELETE(req({ password: "errada" }), ctx());
      expect(res.status).toBe(403);
    }
    const res = await DELETE(req({ password: "errada" }), ctx());
    expect(res.status).toBe(429);
    expect(mocks.verificarSenha).toHaveBeenCalledTimes(5);
  });

  it("devolve a recusa do requireRole (viewer) sem efeito", async () => {
    const negada = new Response(null, { status: 403 });
    mocks.requireRole.mockResolvedValue({ ok: false, response: negada });
    const res = await DELETE(req({ password: "abcdef" }), ctx());
    expect(res.status).toBe(403);
    expect(mocks.peekRateLimit).not.toHaveBeenCalled();
  });
});
