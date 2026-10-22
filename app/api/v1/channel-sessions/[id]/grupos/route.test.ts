import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { convergirGruposDoCanal, lerCanalParaGrupos } from "@/lib/channels/grupos";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { PATCH } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/channels/grupos", () => ({ lerCanalParaGrupos: vi.fn(), convergirGruposDoCanal: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const org = "11111111-1111-4111-8111-111111111111";
const canal = "22222222-2222-4222-8222-222222222222";
const sessionRef = "sessao-do-canal";
const update = vi.fn();
const context = (id = canal) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = {}) => new NextRequest("http://localhost/api/v1/channel-sessions/" + canal + "/grupos", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: org }, org: { orgId: org, role: "admin" } } as Awaited<ReturnType<typeof requireRole>>);
  const query = {
    select: () => query,
    update: (patch: Record<string, unknown>) => { update(patch); return query; },
    eq: () => query,
    is: () => query,
    then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(lerCanalParaGrupos).mockResolvedValue({ situacao: "ok", sessionRef });
  vi.mocked(convergirGruposDoCanal).mockResolvedValue("aplicada");
});

describe("visibilidade de grupos por conexão", () => {
  it("exige admin e não consulta DB se negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden", "Acesso negado.", 403) });
    expect((await PATCH(req({ mostrar_grupos: true }), context())).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.objectContaining({ allowPlatformAdmin: true }));
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("suporte readonly nega a mutação antes de service role e auditoria", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({ id: org, is_platform_admin: true,
      support: { organization_id: org, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);
    const response = await PATCH(req({ mostrar_grupos: true }), context());
    expect(response.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("recusa corpo inválido sem tocar no banco", async () => {
    for (const body of [{}, { mostrar_grupos: "sim" }, { mostrar_grupos: true, extra: 1 }]) {
      expect((await PATCH(req(body), context())).status).toBe(422);
    }
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("404 quando o canal não existe ou não é da organização", async () => {
    vi.mocked(lerCanalParaGrupos).mockResolvedValue({ situacao: "nao_encontrado" });
    expect((await PATCH(req({ mostrar_grupos: true }), context("33333333-3333-4333-8333-333333333333"))).status).toBe(404);
  });

  it("422 quando o canal não tem sessão por QR (canal oficial)", async () => {
    vi.mocked(lerCanalParaGrupos).mockResolvedValue({ situacao: "sem_sessao" });
    const response = await PATCH(req({ mostrar_grupos: true }), context());
    expect(response.status).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });

  it("sucesso: grava a coluna, converge o transporte e audita", async () => {
    const response = await PATCH(req({ mostrar_grupos: true }), context());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ mostrar_grupos: true, aplicacao: "aplicada" });
    expect(update).toHaveBeenCalledWith({ mostrar_grupos: true });
    expect(convergirGruposDoCanal).toHaveBeenCalledWith(sessionRef, true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "channel.groups_visibility_updated",
      metadata: { mostrar_grupos: true, aplicacao: "aplicada" },
    }));
  });

  it("transporte indisponível: ainda 200, com aplicacao: nao_aplicada", async () => {
    vi.mocked(convergirGruposDoCanal).mockResolvedValue("nao_aplicada");
    const response = await PATCH(req({ mostrar_grupos: false }), context());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ mostrar_grupos: false, aplicacao: "nao_aplicada" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: { mostrar_grupos: false, aplicacao: "nao_aplicada" } }));
  });
});
