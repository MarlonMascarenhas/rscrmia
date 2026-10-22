import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

/**
 * DELETE /api/v1/admin/users/[id] — apaga a conta do Auth.
 * A regra de negócio (último admin, FK NOT NULL) mora na função SQL
 * `fn_admin_preparar_exclusao_de_usuario`; aqui se prova o que a ROTA faz com a resposta dela.
 */

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  hashEmail: (e: string) => `hash-${e.length}`,
}));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ALVO_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function montar(opts: {
  rpc?: unknown;
  rpcError?: { message: string } | null;
  getUserErro?: boolean;
  deleteErro?: { message: string } | null;
}) {
  const rpc = vi.fn(async () => ({ data: opts.rpc ?? null, error: opts.rpcError ?? null }));
  const deleteUser = vi.fn(async (_id: string) => ({ error: opts.deleteErro ?? null }));
  const getUserById = vi.fn(async (_id: string) =>
    opts.getUserErro
      ? { data: { user: null }, error: { message: "nf" } }
      : { data: { user: { id: ALVO_ID, email: "Alvo@Example.com" } }, error: null },
  );
  vi.mocked(createAdminClient).mockReturnValue({
    rpc,
    auth: { admin: { getUserById, deleteUser } },
  } as never);
  return { rpc, deleteUser, getUserById };
}

async function chamar(id = ALVO_ID) {
  const { DELETE } = await import("./route");
  return DELETE(new NextRequest(`http://localhost/api/v1/admin/users/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
});

describe("DELETE /api/v1/admin/users/[id]", () => {
  it("403 sem platform admin, sem tocar no banco", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("NEXT_REDIRECT"));
    const m = montar({});
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.deleteUser).not.toHaveBeenCalled();
  });

  it("400 quando o id não é uuid", async () => {
    const m = montar({});
    const res = await chamar("nao-e-uuid");
    expect(res.status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("409 ao apagar a si mesmo", async () => {
    const m = montar({});
    const res = await chamar(ADMIN_ID);
    expect(res.status).toBe(409);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.deleteUser).not.toHaveBeenCalled();
  });

  it("409 para platform admin ativo, e não apaga", async () => {
    const m = montar({ rpc: { ok: false, codigo: "platform_admin" } });
    const res = await chamar();
    expect(res.status).toBe(409);
    expect(m.deleteUser).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("409 lista TODAS as empresas onde é o único admin", async () => {
    const m = montar({
      rpc: {
        ok: false,
        codigo: "bloqueado",
        bloqueios: {
          ultimos_admins: [
            { organization_id: ORG_ID, nome: "Empresa A" },
            { organization_id: "44444444-4444-4444-8444-444444444444", nome: "Empresa B" },
          ],
          registros_obrigatorios: [],
        },
      },
    });
    const res = await chamar();
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { ultimos_admins: unknown[] } };
    };
    expect(body.error.code).toBe("usuario_e_ultimo_admin");
    expect(body.error.details.ultimos_admins).toHaveLength(2);
    expect(m.deleteUser).not.toHaveBeenCalled();
  });

  it("409 usuario_tem_registros_obrigatorios com tabela e contagem", async () => {
    const m = montar({
      rpc: {
        ok: false,
        codigo: "bloqueado",
        bloqueios: {
          ultimos_admins: [],
          registros_obrigatorios: [
            { tabela: "commissions", coluna: "attendant_user_id", quantidade: 3 },
          ],
        },
      },
    });
    const res = await chamar();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("usuario_tem_registros_obrigatorios");
    expect(body.error.message).toContain("comissões (3)");
    expect(m.deleteUser).not.toHaveBeenCalled();
  });

  it("200: prepara, apaga no Auth e audita sem e-mail em claro", async () => {
    const m = montar({
      rpc: { ok: true, codigo: "preparado", organizacoes_revogadas: [ORG_ID], anuladas: [] },
    });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(m.rpc).toHaveBeenCalledWith("fn_admin_preparar_exclusao_de_usuario", {
      p_user_id: ALVO_ID,
    });
    expect(m.deleteUser).toHaveBeenCalledWith(ALVO_ID);
    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada.action).toBe("admin.user_deleted");
    expect(entrada.actorUserId).toBe(ADMIN_ID);
    expect(entrada.resourceId).toBe(ALVO_ID);
    expect(entrada.metadata).toMatchObject({
      target_user_id: ALVO_ID,
      organization_ids: [ORG_ID],
      email_hash: "hash-16",
    });
    expect(JSON.stringify(entrada)).not.toContain("Alvo@Example.com");
  });

  it("502 quando o deleteUser falha, e audita a revogação que já aconteceu", async () => {
    montar({
      rpc: { ok: true, codigo: "preparado", organizacoes_revogadas: [ORG_ID], anuladas: [] },
      deleteErro: { message: "gotrue fora" },
    });
    const res = await chamar();
    expect(res.status).toBe(502);
    expect(vi.mocked(audit).mock.calls.map((c) => c[0].action)).toEqual([
      "admin.user_removed_from_org",
    ]);
  });

  it("404 quando o usuário não existe no Auth", async () => {
    const m = montar({ getUserErro: true });
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
