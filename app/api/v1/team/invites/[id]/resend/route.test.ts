/**
 * POST /api/v1/team/invites/[id]/resend — reenviar convite.
 *
 * Contra o handler REAL. O efeito externo (e-mail + audit `member.invited`, que
 * moram em `reenviarConvite`/`issueInvite`) é mockado e conferido por ARGUMENTO.
 * O dublê do admin client APLICA os filtros `.eq`: o admin bypassa a RLS, então
 * o `.eq("organization_id", …)` da rota é o único isolamento — apagá-lo faz o
 * caso de outra organização reenviar o convite alheio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { reenviarConvite } from "@/lib/team/convites";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/team/convites", async () => {
  const s = await import("@/lib/team/convite-status");
  return { statusConvite: s.statusConvite, reenviarConvite: vi.fn() };
});

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const CONVITE = "44444444-4444-4444-8444-444444444444";
const CONVITE_ALHEIO = "55555555-5555-4555-8555-555555555555";

const FUTURO = "2999-01-01T00:00:00.000Z";
const PASSADO = "2000-01-01T00:00:00.000Z";

interface Linha {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  resend_count: number;
  [k: string]: unknown;
}

function linha(over: Partial<Linha> & { id: string; organization_id: string }): Linha {
  return {
    email: "convidado@example.com",
    role: "agent",
    expires_at: FUTURO,
    accepted_at: null,
    revoked_at: null,
    resend_count: 0,
    ...over,
  };
}

function makeAdmin(linhas: Linha[], erroLeitura: { message: string } | null = null) {
  const leituras: Array<Record<string, unknown>> = [];
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      expect(tabela, "a rota mexeu em outra tabela").toBe("team_invites");
      const filtros: Record<string, unknown> = {};
      const api = {
        select: () => api,
        eq: (c: string, v: unknown) => {
          filtros[c] = v;
          return api;
        },
        maybeSingle: async () => {
          leituras.push({ ...filtros });
          if (erroLeitura) return { data: null, error: erroLeitura };
          const alvo = linhas.filter((l) => Object.entries(filtros).every(([k, v]) => l[k] === v));
          return { data: alvo[0] ?? null, error: null };
        },
      };
      return api;
    },
  } as unknown as ReturnType<typeof createAdminClient>);
  return { leituras };
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

function resultadoDoReenvio(convite: Linha, over: Record<string, unknown> = {}) {
  return {
    convite: { ...convite, resend_count: convite.resend_count + 1 },
    accept_url: "http://localhost/team/accept-invite/tok",
    email_dispatched: true,
    renovado: true,
    ...over,
  } as unknown as Awaited<ReturnType<typeof reenviarConvite>>;
}

const req = () => new NextRequest("http://localhost/api/v1/team/invites/x/resend", { method: "POST" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
  authOk();
});

describe("POST /api/v1/team/invites/[id]/resend", () => {
  it("reenvia o convite pendente e responde 200 { data } com status, link e e-mail", async () => {
    const minha = linha({ id: CONVITE, organization_id: ORG });
    const db = makeAdmin([minha]);
    vi.mocked(reenviarConvite).mockResolvedValue(resultadoDoReenvio(minha));
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toMatchObject({
      id: CONVITE,
      status: "pendente",
      accept_url: "http://localhost/team/accept-invite/tok",
      email_dispatched: true,
      resend_count: 1,
    });
    // A leitura é por organização da SESSÃO + id.
    expect(db.leituras[0]).toMatchObject({ organization_id: ORG, id: CONVITE });
    // Efeito externo conferido por argumento: quem clicou, em qual organização.
    expect(vi.mocked(reenviarConvite)).toHaveBeenCalledTimes(1);
    const params = vi.mocked(reenviarConvite).mock.calls[0]?.[1];
    expect(params).toMatchObject({ orgName: "Org", actorId: ADMIN, actorName: "Ana Admin" });
    expect(params?.convite).toMatchObject({ id: CONVITE, organization_id: ORG, email: "convidado@example.com" });
  });

  it("convite EXPIRADO ainda pode ser reenviado (é o que renova a validade)", async () => {
    const velha = linha({ id: CONVITE, organization_id: ORG, expires_at: PASSADO });
    makeAdmin([velha]);
    vi.mocked(reenviarConvite).mockResolvedValue(resultadoDoReenvio(velha, { convite: { ...velha, expires_at: FUTURO } }));
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe("pendente");
    expect(vi.mocked(reenviarConvite)).toHaveBeenCalledTimes(1);
  });

  it("e-mail que não saiu: 200 com email_dispatched=false (o link segue na resposta)", async () => {
    const minha = linha({ id: CONVITE, organization_id: ORG });
    makeAdmin([minha]);
    vi.mocked(reenviarConvite).mockResolvedValue(resultadoDoReenvio(minha, { email_dispatched: false }));
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    const corpo = (await res.json()) as { data: { email_dispatched: boolean; accept_url: string } };
    expect(res.status).toBe(200);
    expect(corpo.data.email_dispatched).toBe(false);
    expect(corpo.data.accept_url).toContain("/team/accept-invite/");
  });

  it("ISOLAMENTO: convite de OUTRA organização → 404, sem reenvio", async () => {
    const alheio = linha({ id: CONVITE_ALHEIO, organization_id: OUTRA_ORG });
    makeAdmin([alheio]);
    vi.mocked(reenviarConvite).mockResolvedValue(resultadoDoReenvio(alheio));
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE_ALHEIO));

    expect(res.status).toBe(404);
    expect(vi.mocked(reenviarConvite), "a organização A reenviou o convite da B").not.toHaveBeenCalled();
    expect(alheio.resend_count).toBe(0);
  });

  it.each([
    ["aceito", { accepted_at: "2026-01-01T00:00:00.000Z" }],
    ["revogado", { revoked_at: "2026-01-01T00:00:00.000Z" }],
  ])("convite %s → 409 state_conflict, sem reenvio", async (_nome, over) => {
    makeAdmin([linha({ id: CONVITE, organization_id: ORG, ...over })]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("state_conflict");
    expect(vi.mocked(reenviarConvite)).not.toHaveBeenCalled();
  });

  it("convite que mudou entre a leitura e a escrita (reenviarConvite → null) → 409", async () => {
    makeAdmin([linha({ id: CONVITE, organization_id: ORG })]);
    vi.mocked(reenviarConvite).mockResolvedValue(null);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("state_conflict");
  });

  it("erro de leitura do banco → 500 internal_error, sem reenvio", async () => {
    makeAdmin([], { message: "boom" });
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(500);
    expect(vi.mocked(reenviarConvite)).not.toHaveBeenCalled();
  });

  it("id que não é UUID → 400 invalid_request, sem tocar o banco", async () => {
    const { POST } = await import("./route");

    const res = await POST(req(), ctx("nao-e-uuid"));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
    expect(vi.mocked(reenviarConvite)).not.toHaveBeenCalled();
  });

  it("sem service-role → 503 unavailable, sem reenvio", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unavailable");
    expect(vi.mocked(createAdminClient)).not.toHaveBeenCalled();
    expect(vi.mocked(reenviarConvite)).not.toHaveBeenCalled();
  });

  it("requireRole recusando propaga o status; o papel exigido é admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    });
    makeAdmin([linha({ id: CONVITE, organization_id: ORG })]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(403);
    expect(vi.mocked(reenviarConvite)).not.toHaveBeenCalled();
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("admin");
  });

  it("não autenticado (401) é propagado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthorized", "login necessário", 401, {}),
    });
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(401);
    expect(vi.mocked(reenviarConvite)).not.toHaveBeenCalled();
  });

  it("requireSupportWrite recusando: o e-mail NÃO sai", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("support_read_only", "somente leitura", 403, {}));
    makeAdmin([linha({ id: CONVITE, organization_id: ORG })]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(403);
    expect(vi.mocked(reenviarConvite)).not.toHaveBeenCalled();
    expect(vi.mocked(requireRole)).not.toHaveBeenCalled();
  });
});
