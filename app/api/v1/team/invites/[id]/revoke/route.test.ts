/**
 * POST /api/v1/team/invites/[id]/revoke — cancelar convite pendente.
 *
 * Contra o handler REAL, com um dublê que APLICA os filtros `.eq`/`.is` (não
 * devolve linha fixa). O que se prende:
 *  - a linha revogada ganha `revoked_at`/`revoked_by` e a ação sai em
 *    `member.invite_revoked`;
 *  - convite de OUTRA organização → 404 e a linha dela fica intacta;
 *  - aceito → 409; já revogado → 200 idempotente, sem nova escrita nem audit;
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
const CONVITE = "44444444-4444-4444-8444-444444444444";
const CONVITE_ALHEIO = "55555555-5555-4555-8555-555555555555";

interface Linha {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  accepted_at: string | null;
  revoked_at: string | null;
  revoked_by?: string | null;
  [k: string]: unknown;
}

function linha(over: Partial<Linha> & { id: string; organization_id: string }): Linha {
  return { email: "convidado@example.com", role: "agent", accepted_at: null, revoked_at: null, ...over };
}

interface Escrita {
  campos: Record<string, unknown>;
  filtros: Record<string, unknown>;
}

function makeSupabase(linhas: Linha[]) {
  const escritas: Escrita[] = [];
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => {
      expect(tabela, "a rota mexeu em outra tabela").toBe("team_invites");
      const filtros: Record<string, unknown> = {};
      let campos: Record<string, unknown> | null = null;
      const alvo = () => linhas.filter((l) => Object.entries(filtros).every(([k, v]) => l[k] === v));
      const api = {
        select: () => api,
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
          // Só o update é aguardado direto.
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

const req = () => new NextRequest("http://localhost/api/v1/team/invites/x/revoke", { method: "POST" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(audit).mockResolvedValue(undefined);
  authOk();
});

describe("POST /api/v1/team/invites/[id]/revoke", () => {
  it("revoga o convite pendente, grava quem revogou e audita member.invite_revoked", async () => {
    const minha = linha({ id: CONVITE, organization_id: ORG });
    const db = makeSupabase([minha]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { id: string; revoked_at: string } };
    expect(corpo.data.id).toBe(CONVITE);
    expect(minha.revoked_at).toBe(corpo.data.revoked_at);
    expect(minha.revoked_by).toBe(ADMIN);
    // A escrita só alcança convite ainda em aberto.
    expect(db.escritas[0]?.filtros).toMatchObject({ id: CONVITE, accepted_at: null, revoked_at: null });
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.invite_revoked",
        actorUserId: ADMIN,
        organizationId: ORG,
        resourceId: CONVITE,
        metadata: { email: "convidado@example.com", role: "agent" },
      }),
    );
  });

  it("ISOLAMENTO: convite de OUTRA organização → 404 e a linha dela fica intacta", async () => {
    const alheio = linha({ id: CONVITE_ALHEIO, organization_id: OUTRA_ORG });
    const db = makeSupabase([alheio]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE_ALHEIO));

    expect(res.status).toBe(404);
    expect(alheio.revoked_at, "a organização A revogou o convite da B").toBeNull();
    expect(alheio.revoked_by).toBeUndefined();
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("convite já aceito → 409 state_conflict, sem escrita", async () => {
    const aceito = linha({ id: CONVITE, organization_id: ORG, accepted_at: "2026-01-01T00:00:00.000Z" });
    const db = makeSupabase([aceito]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("state_conflict");
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("revogar de novo é idempotente: 200 already_revoked, sem escrita nem audit", async () => {
    const revogado = linha({ id: CONVITE, organization_id: ORG, revoked_at: "2026-01-01T00:00:00.000Z" });
    const db = makeSupabase([revogado]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { already_revoked: boolean } }).data.already_revoked).toBe(true);
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("id que não é UUID → 400 invalid_request, sem tocar o banco", async () => {
    const db = makeSupabase([]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx("nao-e-uuid"));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
    expect(db.escritas).toEqual([]);
  });

  it("requireRole recusando propaga o status; o papel exigido é admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    });
    const minha = linha({ id: CONVITE, organization_id: ORG });
    const db = makeSupabase([minha]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(403);
    expect(minha.revoked_at).toBeNull();
    expect(db.escritas).toEqual([]);
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
  });

  it("requireSupportWrite recusando: o convite NÃO é revogado e nada é auditado", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(fail("support_read_only", "somente leitura", 403, {}));
    const minha = linha({ id: CONVITE, organization_id: ORG });
    const db = makeSupabase([minha]);
    const { POST } = await import("./route");

    const res = await POST(req(), ctx(CONVITE));

    expect(res.status).toBe(403);
    expect(minha.revoked_at).toBeNull();
    expect(db.escritas).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(vi.mocked(requireRole)).not.toHaveBeenCalled();
  });
});
