/**
 * GET /api/v1/auth/realtime-token — o corpo de sucesso É um token de sessão.
 *
 * Prende três coisas: só sai com `getUser()` válido (o `getSession()` não
 * autentica), nunca sai sem `no-store`, e o token só sai quando existe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { GET } from "./route";

function supabaseQue(opts: {
  user?: unknown;
  authErr?: unknown;
  session?: unknown;
}) {
  const getSession = vi.fn(async () => ({ data: { session: opts.session ?? null } }));
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: opts.user ?? null }, error: opts.authErr ?? null })),
      getSession,
    },
  } as never);
  return { getSession };
}

const chamar = () => GET(new NextRequest("https://crm.exemplo.com.br/api/v1/auth/realtime-token"));

describe("GET /api/v1/auth/realtime-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sem usuário: 401, no-store, e o token NÃO é lido", async () => {
    const { getSession } = supabaseQue({});
    const res = await chamar();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await res.json()).error.code).toBe("unauthenticated");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("getUser com erro (JWT inválido): 401 mesmo havendo sessão no cookie", async () => {
    const { getSession } = supabaseQue({
      user: { id: "u1" },
      authErr: { message: "jwt expired" },
      session: { access_token: "tok" },
    });
    const res = await chamar();
    expect(res.status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain("tok");
  });

  it("autenticado mas sessão sem token: 401 `Sessão sem token.`", async () => {
    supabaseQue({ user: { id: "u1" }, session: { access_token: "" } });
    const res = await chamar();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("caminho feliz: entrega access_token e expires_at, com no-store", async () => {
    supabaseQue({ user: { id: "u1" }, session: { access_token: "tok-123", expires_at: 1900000000 } });
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect((await res.json()).data).toEqual({ access_token: "tok-123", expires_at: 1900000000 });
  });

  it("expires_at ausente vira null", async () => {
    supabaseQue({ user: { id: "u1" }, session: { access_token: "tok-123" } });
    expect((await (await chamar()).json()).data.expires_at).toBeNull();
  });
});
