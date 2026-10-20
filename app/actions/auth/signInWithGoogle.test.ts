/**
 * signInWithGoogle — metade de ida do OAuth. Mede por efeito: no sucesso o
 * servidor redireciona para a URL do provedor (retorno aponta para
 * /auth/callback); no erro devolve discriminador e audita a falha com o motivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClientDeEntradaComGoogle } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClientDeEntradaComGoogle: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" } }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const signInWithOAuth = vi.fn();

describe("signInWithGoogle", () => {
  beforeEach(() => {
    vi.resetModules();
    signInWithOAuth.mockReset();
    vi.mocked(audit).mockClear();
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) => (k === "x-request-id" ? "req-1" : null),
    } as never);
    vi.mocked(createClientDeEntradaComGoogle).mockResolvedValue({
      auth: { signInWithOAuth },
    } as never);
  });

  it("sucesso: pede o provedor google com retorno em /auth/callback e redireciona para a URL devolvida", async () => {
    signInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" },
      error: null,
    });
    const { signInWithGoogle } = await import("./signInWithGoogle");

    await expect(signInWithGoogle()).rejects.toThrow(
      "REDIRECT:https://accounts.google.com/o/oauth2/auth?x=1",
    );

    const arg = signInWithOAuth.mock.calls[0]![0];
    expect(arg.provider).toBe("google");
    expect(arg.options.redirectTo).toContain("https://app.example.com/auth/callback");
    expect(audit).not.toHaveBeenCalled();
  });

  it("provedor não habilitado: google_indisponivel e audita provedor_indisponivel", async () => {
    signInWithOAuth.mockResolvedValue({
      data: { url: null },
      error: { message: "Unsupported provider: provider is not enabled" },
    });
    const { signInWithGoogle } = await import("./signInWithGoogle");

    const r = await signInWithGoogle();

    expect(r).toEqual({ ok: false, error: "google_indisponivel" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.google_signin_failed",
        requestId: "req-1",
        metadata: expect.objectContaining({ motivo: "provedor_indisponivel" }),
      }),
    );
  });

  it("outro erro do provedor: erro_inesperado e audita url_ausente", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: null }, error: { message: "boom" } });
    const { signInWithGoogle } = await import("./signInWithGoogle");

    const r = await signInWithGoogle();

    expect(r).toEqual({ ok: false, error: "erro_inesperado" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.google_signin_failed",
        metadata: { motivo: "url_ausente", reason: "boom" },
      }),
    );
  });

  it("sem erro mas sem URL: erro_inesperado", async () => {
    signInWithOAuth.mockResolvedValue({ data: { url: null }, error: null });
    const { signInWithGoogle } = await import("./signInWithGoogle");

    expect(await signInWithGoogle()).toEqual({ ok: false, error: "erro_inesperado" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { motivo: "url_ausente", reason: "data.url ausente" },
      }),
    );
  });
});
