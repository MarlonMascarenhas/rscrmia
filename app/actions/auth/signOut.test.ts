/**
 * signOut — encerra a sessão no provedor, apaga o cookie active_org, audita
 * auth.logout só quando havia usuário e sempre redireciona para /login.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const getUser = vi.fn();
const supaSignOut = vi.fn(async () => ({ error: null }));
const del = vi.fn();

describe("signOut", () => {
  beforeEach(() => {
    vi.resetModules();
    getUser.mockReset();
    supaSignOut.mockClear();
    del.mockClear();
    vi.mocked(audit).mockClear();
    vi.mocked(cookies).mockResolvedValue({ delete: del } as never);
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) =>
        ({
          "x-request-id": "req-9",
          "x-forwarded-for": "203.0.113.5, 10.0.0.1",
          "user-agent": "UA-test",
        })[k] ?? null,
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser, signOut: supaSignOut },
    } as never);
  });

  it("com usuário: sai, apaga active_org, audita auth.logout e redireciona para /login", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    const { signOut } = await import("./signOut");

    await expect(signOut()).rejects.toThrow("REDIRECT:/login");

    expect(supaSignOut).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("active_org");
    expect(audit).toHaveBeenCalledWith({
      action: "auth.logout",
      actorUserId: "u1",
      requestId: "req-9",
      ip: "203.0.113.5",
      userAgent: "UA-test",
    });
  });

  it("sem usuário: não audita, mas ainda limpa e redireciona para /login", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const { signOut } = await import("./signOut");

    await expect(signOut()).rejects.toThrow("REDIRECT:/login");

    expect(supaSignOut).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("active_org");
    expect(audit).not.toHaveBeenCalled();
  });
});
