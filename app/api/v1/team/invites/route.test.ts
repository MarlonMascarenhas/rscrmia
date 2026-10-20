/**
 * GET /api/v1/team/invites — lista de convites da organização ativa.
 *
 * Leitura (sem audit, sem guarda de suporte — a rota não tem efeito). O que se
 * prende, contra o handler REAL:
 *  - só convites da organização da SESSÃO (o dublê APLICA o `.eq`, então apagar
 *    o filtro da rota faria a linha da outra organização aparecer);
 *  - `status` derivado e `accept_url` só para convite em aberto;
 *  - papel mínimo `manager` e erro do banco → 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// O status é regra real (convite-status); só o link — que assina token HMAC e
// exige env — é substituído por algo determinístico.
vi.mock("@/lib/team/convites", async () => {
  const s = await import("@/lib/team/convite-status");
  return {
    statusConvite: s.statusConvite,
    conviteEstaEmAberto: s.conviteEstaEmAberto,
    linkDeAceite: (row: { id: string }) => `http://localhost/team/accept-invite/tok-${row.id}`,
  };
});

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";

interface Linha {
  id: string;
  organization_id: string;
  email: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  [k: string]: unknown;
}

const FUTURO = "2999-01-01T00:00:00.000Z";
const PASSADO = "2000-01-01T00:00:00.000Z";

function linha(over: Partial<Linha> & { id: string; organization_id: string }): Linha {
  return {
    email: `${over.id}@example.com`,
    created_at: "2026-01-01T00:00:00.000Z",
    expires_at: FUTURO,
    accepted_at: null,
    revoked_at: null,
    ...over,
  };
}

function makeSupabase(linhas: Linha[], erro: { message: string } | null = null) {
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => {
      expect(tabela, "a rota leu outra tabela").toBe("team_invites");
      const filtros: Record<string, unknown> = {};
      let ordem: { col: string; asc: boolean } | null = null;
      const api = {
        select: () => api,
        eq: (c: string, v: unknown) => {
          filtros[c] = v;
          return api;
        },
        order: (col: string, o: { ascending: boolean }) => {
          ordem = { col, asc: o.ascending };
          return api;
        },
        then: (ok: (v: unknown) => unknown) => {
          if (erro) return Promise.resolve({ data: null, error: erro }).then(ok);
          const data = linhas
            .filter((l) => Object.entries(filtros).every(([k, v]) => l[k] === v))
            .sort((a, b) => {
              if (!ordem) return 0;
              const r = String(a[ordem.col]).localeCompare(String(b[ordem.col]));
              return ordem.asc ? r : -r;
            });
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return api;
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

function authOk(role: "manager" | "admin" = "manager"): void {
  const user: AuthUser = {
    id: USER,
    email: "manager@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role } });
}

const req = () => new NextRequest("http://localhost/api/v1/team/invites");

type Item = { id: string; status: string; accept_url: string | null };

beforeEach(() => {
  vi.resetAllMocks();
  authOk();
});

describe("GET /api/v1/team/invites", () => {
  it("lista os convites da organização com status derivado e accept_url só no que está em aberto", async () => {
    makeSupabase([
      linha({ id: "pend", organization_id: ORG, created_at: "2026-03-01T00:00:00.000Z" }),
      linha({ id: "exp", organization_id: ORG, expires_at: PASSADO, created_at: "2026-02-01T00:00:00.000Z" }),
      linha({ id: "rev", organization_id: ORG, revoked_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-05T00:00:00.000Z" }),
      linha({ id: "ace", organization_id: ORG, accepted_at: "2026-01-02T00:00:00.000Z", created_at: "2026-01-03T00:00:00.000Z" }),
    ]);
    const { GET } = await import("./route");

    const res = await GET(req());

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Item[] };
    // Mais novo primeiro (order created_at desc).
    expect(corpo.data.map((i) => i.id)).toEqual(["pend", "exp", "rev", "ace"]);
    const porId = Object.fromEntries(corpo.data.map((i) => [i.id, i]));
    expect(porId.pend).toMatchObject({ status: "pendente", accept_url: "http://localhost/team/accept-invite/tok-pend" });
    expect(porId.exp).toMatchObject({ status: "expirado", accept_url: "http://localhost/team/accept-invite/tok-exp" });
    expect(porId.rev).toMatchObject({ status: "revogado", accept_url: null });
    expect(porId.ace).toMatchObject({ status: "aceito", accept_url: null });
  });

  it("ISOLAMENTO: convite de OUTRA organização não aparece na lista", async () => {
    makeSupabase([
      linha({ id: "minha", organization_id: ORG }),
      linha({ id: "alheia", organization_id: OUTRA_ORG }),
    ]);
    const { GET } = await import("./route");

    const res = await GET(req());

    const corpo = (await res.json()) as { data: Item[] };
    expect(corpo.data.map((i) => i.id)).toEqual(["minha"]);
    expect(JSON.stringify(corpo), "vazou o e-mail da outra organização").not.toContain("alheia");
  });

  it("organização sem convites → 200 com lista vazia", async () => {
    makeSupabase([linha({ id: "alheia", organization_id: OUTRA_ORG })]);
    const { GET } = await import("./route");

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Item[] }).data).toEqual([]);
  });

  it("requireRole recusando propaga o status; o papel mínimo é manager", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    });
    makeSupabase([linha({ id: "minha", organization_id: ORG })]);
    const { GET } = await import("./route");

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(vi.mocked(createClient)).not.toHaveBeenCalled();
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("não autenticado (401) é propagado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthorized", "login necessário", 401, {}),
    });
    const { GET } = await import("./route");

    const res = await GET(req());

    expect(res.status).toBe(401);
  });

  it("erro do banco → 500 internal_error", async () => {
    makeSupabase([], { message: "boom" });
    const { GET } = await import("./route");

    const res = await GET(req());

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("internal_error");
  });
});
