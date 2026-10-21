import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

/**
 * POST /api/v1/admin/users/[id]/organizations/[orgId]/revoke — o platform admin
 * tira um usuário de uma empresa. A contagem do último admin é da função SQL
 * `fn_admin_revogar_vinculo`; aqui se prova o que a ROTA faz com a resposta dela.
 */

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ALVO_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function montar(rpcData: unknown, rpcError: { message: string } | null = null) {
  const rpc = vi.fn(async (_fn: string, _args: unknown) => ({ data: rpcData, error: rpcError }));
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
  return rpc;
}

async function chamar(id = ALVO_ID, orgId = ORG_ID) {
  const { POST } = await import("./route");
  return POST(
    new NextRequest(`http://localhost/api/v1/admin/users/${id}/organizations/${orgId}/revoke`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id, orgId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
});

describe("POST /api/v1/admin/users/[id]/organizations/[orgId]/revoke", () => {
  it("403 sem platform admin, sem tocar no banco", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("NEXT_REDIRECT"));
    const rpc = montar(null);
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("400 quando um id não é uuid", async () => {
    const rpc = montar(null);
    expect((await chamar("x")).status).toBe(400);
    expect((await chamar(ALVO_ID, "y")).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("409 ao remover a si mesmo", async () => {
    const rpc = montar(null);
    const res = await chamar(ADMIN_ID);
    expect(res.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("409 ultimo_admin quando a função recusa", async () => {
    montar({ ok: false, codigo: "ultimo_admin" });
    const res = await chamar();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ultimo_admin");
    expect(audit).not.toHaveBeenCalled();
  });

  it("404 quando não há vínculo", async () => {
    montar({ ok: false, codigo: "nao_encontrado" });
    expect((await chamar()).status).toBe(404);
  });

  it("200 sem auditar de novo quando já estava revogado", async () => {
    montar({ ok: true, codigo: "ja_revogado" });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("200 revoga e audita admin.user_removed_from_org com ator, alvo e org do path", async () => {
    const rpc = montar({
      ok: true,
      codigo: "revogado",
      role: "agent",
      revoked_at: "2026-10-20T00:00:00Z",
    });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith("fn_admin_revogar_vinculo", {
      p_user_id: ALVO_ID,
      p_org_id: ORG_ID,
    });
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({
      action: "admin.user_removed_from_org",
      actorUserId: ADMIN_ID,
      organizationId: ORG_ID,
      resourceId: ALVO_ID,
    });
  });

  it("500 quando a função falha", async () => {
    montar(null, { message: "boom" });
    expect((await chamar()).status).toBe(500);
  });
});
