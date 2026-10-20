/**
 * POST /api/v1/team/[user_id]/revoke — revogar o acesso de um membro.
 *
 * Contra o handler REAL, com um dublê de `user_organizations` que APLICA os
 * filtros `.eq`/`.is` e o `count` (não devolve linha fixa). O que se prende:
 *  - revoga e audita `member.revoked` com o papel que a pessoa tinha;
 *  - membro de OUTRA organização → 404 e a linha dela fica intacta;
 *  - guardas: não revoga a si mesmo; não revoga o último admin DESTA organização
 *    (admin de outra organização não conta como "outro admin");
 *  - já revogado → 200 idempotente, sem escrita nem audit;
 *  - `requireSupportWrite` recusando → nada acontece.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const ALVO = "44444444-4444-4444-8444-444444444444";
const OUTRO_ADMIN = "55555555-5555-4555-8555-555555555555";

interface Membership {
  id: string;
  user_id: string;
  organization_id: string;
  role: string;
  revoked_at: string | null;
  updated_at?: string;
  [k: string]: unknown;
}

function membro(over: Partial<Membership> & { id: string; user_id: string; organization_id: string }): Membership {
  return { role: "agent", revoked_at: null, ...over };
}

function makeSupabase(linhas: Membership[]) {
  const escritas: Array<{ campos: Record<string, unknown>; filtros: Record<string, unknown> }> = [];
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => {
      expect(tabela, "a rota mexeu em outra tabela").toBe("user_organizations");
      const filtros: Record<string, unknown> = {};
      let campos: Record<string, unknown> | null = null;
      let contar = false;
      const alvo = () => linhas.filter((l) => Object.entries(filtros).every(([k, v]) => l[k] === v));
      const api = {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          contar = Boolean(opts?.count);
          return api;
        },
        update: (v: Record<string, unknown>) => {
          campos = v;
          return api;
        },
        eq: (c: string, v: unknown) => {
          filtros[c] = v;
          return api;
        },
        is: (c: string, v: unknown) => {
          filtros[c] = v;
          return api;
        },
        maybeSingle: async () => ({ data: alvo()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          if (contar) return Promise.resolve({ count: alvo().length, error: null }).then(ok);
          escritas.push({ campos: campos ?? {}, filtros: { ...filtros } });
          for (const l of alvo()) Object.assign(l, campos);
          return Promise.resolve({ error: null }).then(ok);
        },
      };
      return api;
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { escritas };
}

function authOk(): void {
  const user: AuthUser = {
    id: ADMIN,
    email: "admin@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role: "admin" } });
}

const req = () => new NextRequest("http://localhost/api/v1/team/x/revoke", { method: "POST" });
const ctx = (user_id: string) => ({ params: Promise.resolve({ user_id }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(audit).mockResolvedValue(undefined);
  authOk();
});

describe("POST /api/v1/team/[user_id]/revoke", () => {
  it("revoga o membro e audita member.revoked com o papel que ele tinha", async () => {
    const alvo = membro({ id: "m-alvo", user_id: ALVO, organization_id: ORG, role: "manager" });
    const db = makeSupabase([alvo]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { user_id: string; revoked_at: string } };
    expect(corpo.data.user_id).toBe(ALVO);
    expect(alvo.revoked_at).toBe(corpo.data.revoked_at);
    expect(db.escritas[0]?.filtros).toMatchObject({ id: "m-alvo" });
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.revoked",
        actorUserId: ADMIN,
        organizationId: ORG,
        resourceType: "membership",
        resourceId: "m-alvo",
        metadata: { target_user_id: ALVO, revoked_role: "manager" },
      }),
    );
  });

  it("ISOLAMENTO: membro de OUTRA organização → 404 e a linha dela fica intacta", async () => {
    const alheio = membro({ id: "m-alheio", user_id: ALVO, organization_id: OUTRA_ORG });
    const db = makeSupabase([alheio]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(404);
    expect(alheio.revoked_at, "a organização A revogou um membro da B").toBeNull();
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("não revoga o PRÓPRIO acesso → 409 state_conflict, sem escrita", async () => {
    const eu = membro({ id: "m-eu", user_id: ADMIN, organization_id: ORG, role: "admin" });
    const db = makeSupabase([eu]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ADMIN));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("state_conflict");
    expect(eu.revoked_at).toBeNull();
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("não revoga o ÚLTIMO admin da organização → 409, sem escrita", async () => {
    const ultimo = membro({ id: "m-alvo", user_id: ALVO, organization_id: ORG, role: "admin" });
    const db = makeSupabase([
      ultimo,
      // Admin de OUTRA organização não é "outro admin" desta: não pode liberar a revogação.
      membro({ id: "m-b", user_id: OUTRO_ADMIN, organization_id: OUTRA_ORG, role: "admin" }),
    ]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(409);
    expect(ultimo.revoked_at).toBeNull();
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("revoga um admin quando há outro admin ATIVO na mesma organização", async () => {
    const alvo = membro({ id: "m-alvo", user_id: ALVO, organization_id: ORG, role: "admin" });
    makeSupabase([alvo, membro({ id: "m-2", user_id: OUTRO_ADMIN, organization_id: ORG, role: "admin" })]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(200);
    expect(alvo.revoked_at).not.toBeNull();
  });

  it("outro admin já REVOGADO não conta: o alvo segue sendo o último admin ativo", async () => {
    const alvo = membro({ id: "m-alvo", user_id: ALVO, organization_id: ORG, role: "admin" });
    makeSupabase([
      alvo,
      membro({ id: "m-2", user_id: OUTRO_ADMIN, organization_id: ORG, role: "admin", revoked_at: "2026-01-01T00:00:00Z" }),
    ]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(409);
    expect(alvo.revoked_at).toBeNull();
  });

  it("já revogado → 200 already_revoked, sem escrita nem audit", async () => {
    const alvo = membro({ id: "m-alvo", user_id: ALVO, organization_id: ORG, revoked_at: "2026-01-01T00:00:00Z" });
    const db = makeSupabase([alvo]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { already_revoked: boolean } }).data.already_revoked).toBe(true);
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("requireRole recusando propaga o status; o papel exigido é admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    });
    const alvo = membro({ id: "m-alvo", user_id: ALVO, organization_id: ORG });
    const db = makeSupabase([alvo]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(403);
    expect(alvo.revoked_at).toBeNull();
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("admin");
  });

  it("não autenticado (401) é propagado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthorized", "login necessário", 401, {}),
    });
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(401);
  });

  it("requireSupportWrite recusando: o acesso NÃO é revogado e nada é auditado", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("support_read_only", "somente leitura", 403, {}));
    const alvo = membro({ id: "m-alvo", user_id: ALVO, organization_id: ORG });
    const db = makeSupabase([alvo]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(ALVO));

    expect(res.status).toBe(403);
    expect(alvo.revoked_at).toBeNull();
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(vi.mocked(requireRole)).not.toHaveBeenCalled();
  });
});
