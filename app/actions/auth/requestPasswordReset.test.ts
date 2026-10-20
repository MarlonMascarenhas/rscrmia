/**
 * requestPasswordReset — valida o e-mail (Zod), respeita o teto de tentativas
 * antes de falar com o provedor, mapeia erro do provedor e audita por efeito
 * (com hash do e-mail, nunca o e-mail cru).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited } from "@/lib/auth/rate-limit";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/rate-limit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  authRateLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" } }));

const reset = vi.fn();

describe("requestPasswordReset", () => {
  beforeEach(() => {
    vi.resetModules();
    reset.mockReset();
    reset.mockResolvedValue({ error: null });
    vi.mocked(audit).mockClear();
    vi.mocked(authRateLimited).mockReset();
    vi.mocked(authRateLimited).mockResolvedValue(false);
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) =>
        ({
          "x-request-id": "req-3",
          "x-forwarded-for": "198.51.100.4, 10.0.0.1",
          "user-agent": "UA-test",
        })[k] ?? null,
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { resetPasswordForEmail: reset },
    } as never);
  });

  it("caminho feliz: pede o reset com redirectTo de recovery e audita password_reset_requested", async () => {
    const { requestPasswordReset } = await import("./requestPasswordReset");

    const r = await requestPasswordReset({ email: "pessoa@example.com" });

    expect(r).toEqual({ ok: true });
    expect(reset).toHaveBeenCalledWith("pessoa@example.com", {
      redirectTo: "https://app.example.com/auth/confirm?type=recovery",
    });
    expect(audit).toHaveBeenCalledWith({
      action: "auth.password_reset_requested",
      metadata: { email_hash: hashEmail("pessoa@example.com") },
      requestId: "req-3",
      ip: "198.51.100.4",
      userAgent: "UA-test",
    });
  });

  it("e-mail inválido: validation_error e nada vai ao provedor", async () => {
    const { requestPasswordReset } = await import("./requestPasswordReset");

    const r = await requestPasswordReset({ email: "nao-e-email" });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("validation_error");
      expect(r.details).toHaveProperty("email");
    }
    expect(reset).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("teto estourado: rate_limited sem chamar o provedor", async () => {
    vi.mocked(authRateLimited).mockResolvedValue(true);
    const { requestPasswordReset } = await import("./requestPasswordReset");

    const r = await requestPasswordReset({ email: "pessoa@example.com" });

    expect(r).toEqual({ ok: false, error: "rate_limited" });
    expect(authRateLimited).toHaveBeenCalledWith("reset", "pessoa@example.com", expect.anything());
    expect(reset).not.toHaveBeenCalled();
  });

  it("provedor responde 429: rate_limited, sem auditar", async () => {
    reset.mockResolvedValue({ error: { message: "rate", status: 429 } });
    const { requestPasswordReset } = await import("./requestPasswordReset");

    const r = await requestPasswordReset({ email: "pessoa@example.com" });

    expect(r).toEqual({ ok: false, error: "rate_limited" });
    expect(audit).not.toHaveBeenCalled();
  });

  it("outro erro do provedor: request_failed e audita a falha com o motivo", async () => {
    reset.mockResolvedValue({ error: { message: "smtp down", status: 500 } });
    const { requestPasswordReset } = await import("./requestPasswordReset");

    const r = await requestPasswordReset({ email: "pessoa@example.com" });

    expect(r).toEqual({ ok: false, error: "request_failed" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.password_reset_request_failed",
        metadata: { email_hash: hashEmail("pessoa@example.com"), reason: "smtp down" },
      }),
    );
  });
});
