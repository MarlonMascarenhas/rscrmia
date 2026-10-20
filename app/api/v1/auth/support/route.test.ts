/**
 * GET /api/v1/auth/support — a assinatura do acompanhamento de suporte.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readSupportContext } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ readSupportContext: vi.fn() }));

import { GET } from "./route";

function comUsuario(user: unknown) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user } })) },
  } as never);
}

describe("GET /api/v1/auth/support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sem sessão: 401 unauthenticated e o contexto de suporte nem é lido", async () => {
    comUsuario(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
    expect(readSupportContext).not.toHaveBeenCalled();
  });

  it("sem acompanhamento: assinatura `normal`", async () => {
    comUsuario({ id: "u1" });
    vi.mocked(readSupportContext).mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ signature: "normal" });
  });

  it("com acompanhamento: assinatura id:modo:status", async () => {
    comUsuario({ id: "u1" });
    vi.mocked(readSupportContext).mockResolvedValue({
      id: "sup-1",
      access_mode: "read_only",
      status: "active",
    } as never);
    const res = await GET();
    expect((await res.json()).data).toEqual({ signature: "sup-1:read_only:active" });
  });
});
