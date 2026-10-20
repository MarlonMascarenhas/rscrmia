/**
 * POST /api/v1/team/invite — convite em lote.
 *
 * O que se prende, contra o handler REAL:
 *  - a organização do convite vem da SESSÃO, nunca do body;
 *  - quem já é membro ATIVO desta organização é pulado (`already_member`) — e
 *    um membro de OUTRA organização com o mesmo e-mail NÃO conta. O admin client
 *    bypassa a RLS, então o `.eq("organization_id", …)` da rota é o único filtro:
 *    o dublê APLICA os filtros de verdade, para que apagá-lo quebre o teste;
 *  - o efeito externo (e-mail + audit `member.invited`) mora em `emitirConvite` /
 *    `issueInvite`: aqui é conferido por ARGUMENTO, não por saída.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { exigirFolgaNoLimite } from "@/lib/planos/guarda";
import { emitirConvite } from "@/lib/team/convites";
import { issueInvite } from "@/lib/auth/issue-invite";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/planos/guarda", () => ({ exigirFolgaNoLimite: vi.fn(async () => null) }));
vi.mock("@/lib/team/convites", () => ({ emitirConvite: vi.fn() }));
vi.mock("@/lib/auth/issue-invite", () => ({ issueInvite: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const MEMBRO_DA_ORG = "44444444-4444-4444-8444-444444444444";
const MEMBRO_DA_OUTRA = "55555555-5555-4555-8555-555555555555";
const CONVITE_ID = "66666666-6666-4666-8666-666666666666";

interface Membership {
  user_id: string;
  organization_id: string;
  revoked_at: string | null;
}

/** `user_organizations` com filtros aplicados de verdade + GoTrue `getUserById`. */
function makeAdmin(linhas: Membership[], emails: Record<string, string>) {
  const consultas: Array<Record<string, unknown>> = [];
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      expect(tabela, "a rota mexeu em outra tabela").toBe("user_organizations");
      const filtros: Record<string, unknown> = {};
      const api = {
        select: () => api,
        eq: (c: string, v: unknown) => {
          filtros[c] = v;
          return api;
        },
        is: (c: string, v: unknown) => {
          filtros[c] = v;
          return api;
        },
        then: (ok: (v: unknown) => unknown) => {
          consultas.push({ ...filtros });
          const data = linhas.filter((l) =>
            Object.entries(filtros).every(([k, v]) => (l as unknown as Record<string, unknown>)[k] === v),
          );
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return api;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { email: emails[id] } }, error: null }),
      },
    },
  } as unknown as ReturnType<typeof createAdminClient>);
  return { consultas };
}

function authOk(): void {
  const user: AuthUser = {
    id: ADMIN,
    email: "admin@example.com",
    full_name: "Ana Admin",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role: "admin" } });
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/v1/team/invite", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function conviteEmitido(email: string, over: Record<string, unknown> = {}) {
  return {
    convite: { id: CONVITE_ID, expires_at: "2030-01-01T00:00:00.000Z" },
    accept_url: `http://localhost/team/accept-invite/tok-${email}`,
    email_dispatched: true,
    renovado: false,
    ...over,
  } as unknown as Awaited<ReturnType<typeof emitirConvite>>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(exigirFolgaNoLimite).mockResolvedValue(null);
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
  authOk();
});

describe("POST /api/v1/team/invite — caminho feliz", () => {
  it("emite o convite com a organização da SESSÃO e responde 201 { data }", async () => {
    makeAdmin([], {});
    vi.mocked(emitirConvite).mockImplementation(async (_a, p) => conviteEmitido(p.email));
    const { POST } = await import("./route");

    const res = await POST(
      req({
        // organization_id no body é lixo: nunca pode virar a organização do convite.
        organization_id: OUTRA_ORG,
        invitations: [{ email: "Novo@Example.com", role: "agent" }],
      }),
    );

    expect(res.status).toBe(201);
    const corpo = (await res.json()) as { data: { sent: Array<Record<string, unknown>>; failed: unknown[] } };
    expect(corpo.data.failed).toEqual([]);
    expect(corpo.data.sent[0]).toMatchObject({
      email: "novo@example.com",
      invite_id: CONVITE_ID,
      email_dispatched: true,
    });
    expect(vi.mocked(emitirConvite)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitirConvite).mock.calls[0]?.[1]).toMatchObject({
      email: "novo@example.com",
      role: "agent",
      organizationId: ORG,
      orgName: "Org",
      inviterId: ADMIN,
      inviterName: "Ana Admin",
    });
  });

  it("e-mail que não saiu volta com email_dispatched=false e o motivo", async () => {
    makeAdmin([], {});
    vi.mocked(emitirConvite).mockResolvedValue(
      conviteEmitido("a@example.com", { email_dispatched: false, email_error: "not_configured" }),
    );
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "a@example.com", role: "viewer" }] }));

    const corpo = (await res.json()) as { data: { sent: Array<Record<string, unknown>> } };
    expect(res.status).toBe(201);
    expect(corpo.data.sent[0]).toMatchObject({ email_dispatched: false, email_error: "not_configured" });
  });

  it("sem service-role degrada para só-token (issueInvite), sem tocar o banco", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
    vi.mocked(issueInvite).mockResolvedValue({
      email: "solo@example.com",
      invite_id: CONVITE_ID,
      expires_at: "2030-01-01T00:00:00.000Z",
      email_dispatched: false,
      accept_url: "http://localhost/team/accept-invite/tok",
    } as unknown as Awaited<ReturnType<typeof issueInvite>>);
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "solo@example.com", role: "manager" }] }));

    expect(res.status).toBe(201);
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
    expect(vi.mocked(issueInvite).mock.calls[0]?.[0]).toMatchObject({
      email: "solo@example.com",
      role: "manager",
      organizationId: ORG,
      inviterId: ADMIN,
    });
  });
});

describe("POST /api/v1/team/invite — isolamento entre organizações", () => {
  it("quem já é membro ATIVO desta organização é pulado com already_member", async () => {
    makeAdmin(
      [{ user_id: MEMBRO_DA_ORG, organization_id: ORG, revoked_at: null }],
      { [MEMBRO_DA_ORG]: "Membro@Example.com" },
    );
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "membro@example.com", role: "agent" }] }));

    const corpo = (await res.json()) as { data: { sent: unknown[]; failed: unknown[] } };
    expect(res.status).toBe(201);
    expect(corpo.data.failed).toEqual([{ email: "membro@example.com", reason: "already_member" }]);
    expect(corpo.data.sent).toEqual([]);
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
  });

  it("membro REVOGADO não bloqueia o reconvite", async () => {
    makeAdmin(
      [{ user_id: MEMBRO_DA_ORG, organization_id: ORG, revoked_at: "2026-01-01T00:00:00Z" }],
      { [MEMBRO_DA_ORG]: "volta@example.com" },
    );
    vi.mocked(emitirConvite).mockResolvedValue(conviteEmitido("volta@example.com"));
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "volta@example.com", role: "agent" }] }));

    const corpo = (await res.json()) as { data: { sent: unknown[]; failed: unknown[] } };
    expect(corpo.data.failed).toEqual([]);
    expect(corpo.data.sent).toHaveLength(1);
  });

  it("membro de OUTRA organização com o mesmo e-mail NÃO conta como já-membro", async () => {
    const db = makeAdmin(
      [{ user_id: MEMBRO_DA_OUTRA, organization_id: OUTRA_ORG, revoked_at: null }],
      { [MEMBRO_DA_OUTRA]: "compartilhado@example.com" },
    );
    vi.mocked(emitirConvite).mockResolvedValue(conviteEmitido("compartilhado@example.com"));
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "compartilhado@example.com", role: "agent" }] }));

    const corpo = (await res.json()) as { data: { sent: unknown[]; failed: unknown[] } };
    expect(corpo.data.failed, "a rota enxergou a membership da outra organização").toEqual([]);
    expect(corpo.data.sent).toHaveLength(1);
    expect(db.consultas[0]).toMatchObject({ organization_id: ORG });
  });
});

describe("POST /api/v1/team/invite — recusas", () => {
  it("requireRole recusando propaga o status e nada é emitido", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    });
    makeAdmin([], {});
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "a@example.com", role: "agent" }] }));

    expect(res.status).toBe(403);
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
    expect(vi.mocked(issueInvite)).not.toHaveBeenCalled();
    // Quem prende o papel é o argumento: o 403 acima passaria igual com `viewer`.
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("admin");
  });

  it("não autenticado (401) é propagado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthorized", "login necessário", 401, {}),
    });
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "a@example.com", role: "agent" }] }));

    expect(res.status).toBe(401);
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
  });

  it("requireSupportWrite recusando: o efeito não acontece (nem a checagem de papel)", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("support_read_only", "somente leitura", 403, {}));
    makeAdmin([], {});
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "a@example.com", role: "agent" }] }));

    expect(res.status).toBe(403);
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
    expect(vi.mocked(issueInvite)).not.toHaveBeenCalled();
  });

  it("limite do plano estourado devolve a negação e não emite", async () => {
    vi.mocked(exigirFolgaNoLimite).mockResolvedValue(fail("plan_limit", "limite do plano", 402, {}));
    makeAdmin([], {});
    const { POST } = await import("./route");

    const res = await POST(req({ invitations: [{ email: "a@example.com", role: "agent" }] }));

    expect(res.status).toBe(402);
    expect(vi.mocked(exigirFolgaNoLimite).mock.calls[0]?.[0]).toBe(ORG);
    expect(vi.mocked(exigirFolgaNoLimite).mock.calls[0]?.[1]).toBe("usuarios");
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
  });

  it.each([
    ["role fora do enum", { invitations: [{ email: "a@example.com", role: "superuser" }] }],
    ["e-mail inválido", { invitations: [{ email: "nao-e-email", role: "agent" }] }],
    ["lista vazia", { invitations: [] }],
    ["sem o campo invitations", {}],
  ])("%s → 422 validation_error, sem emissão", async (_nome, body) => {
    makeAdmin([], {});
    const { POST } = await import("./route");

    const res = await POST(req(body));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("validation_error");
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
  });

  it("corpo que não é JSON → 400 body_malformed, sem emissão", async () => {
    makeAdmin([], {});
    const { POST } = await import("./route");

    const res = await POST(
      new NextRequest("http://localhost/api/v1/team/invite", { method: "POST", body: "{nao-json" }),
    );

    expect(res.status).toBe(400);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("body_malformed");
    expect(vi.mocked(emitirConvite)).not.toHaveBeenCalled();
  });
});
