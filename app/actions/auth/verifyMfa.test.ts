/**
 * verifyMfa — verificação TOTP com trava por cookie (3 falhas em 60s). Mede por
 * efeito: redirects (login, /app, destino seguro), contador no cookie, trava
 * antes de qualquer chamada ao provedor, e o audit de falha/sucesso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
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
const listFactors = vi.fn();
const challenge = vi.fn();
const verify = vi.fn();
const cookieGet = vi.fn();
const cookieSet = vi.fn();
const cookieDelete = vi.fn();

describe("verifyMfa", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [getUser, listFactors, challenge, verify, cookieGet, cookieSet, cookieDelete]) {
      m.mockReset();
    }
    vi.mocked(audit).mockClear();
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    listFactors.mockResolvedValue({ data: { totp: [{ id: "f1", status: "verified" }] } });
    challenge.mockResolvedValue({ data: { id: "ch1" }, error: null });
    verify.mockResolvedValue({ error: null });
    cookieGet.mockReturnValue(undefined);
    vi.mocked(cookies).mockResolvedValue({
      get: cookieGet,
      set: cookieSet,
      delete: cookieDelete,
    } as never);
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) =>
        ({
          "x-request-id": "req-7",
          "x-forwarded-for": "192.0.2.77, 10.0.0.1",
          "user-agent": "UA-test",
        })[k] ?? null,
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser, mfa: { listFactors, challenge, verify } },
    } as never);
  });

  it("sem usuário: redireciona para /login", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const { verifyMfa } = await import("./verifyMfa");

    await expect(verifyMfa("123456")).rejects.toThrow("REDIRECT:/login");
    expect(challenge).not.toHaveBeenCalled();
  });

  it("sem fator TOTP verificado: redireciona para /app", async () => {
    listFactors.mockResolvedValue({ data: { totp: [{ id: "f2", status: "unverified" }] } });
    const { verifyMfa } = await import("./verifyMfa");

    await expect(verifyMfa("123456")).rejects.toThrow("REDIRECT:/app");
    expect(challenge).not.toHaveBeenCalled();
  });

  it("já travado (3 tentativas no cookie): mfa_locked sem chamar o provedor", async () => {
    cookieGet.mockReturnValue({ value: "3" });
    const { verifyMfa } = await import("./verifyMfa");

    expect(await verifyMfa("123456")).toEqual({
      ok: false,
      error: "mfa_locked",
      retry_in_seconds: 60,
    });
    expect(challenge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(["12345", "1234567", "abcdef", ""])(
    "código %j fora do formato: mfa_invalid sem desafio nem contagem",
    async (code) => {
      const { verifyMfa } = await import("./verifyMfa");

      expect(await verifyMfa(code)).toEqual({ ok: false, error: "mfa_invalid" });
      expect(challenge).not.toHaveBeenCalled();
      expect(cookieSet).not.toHaveBeenCalled();
    },
  );

  it("falha ao criar o desafio: mfa_invalid", async () => {
    challenge.mockResolvedValue({ data: null, error: { message: "x" } });
    const { verifyMfa } = await import("./verifyMfa");

    expect(await verifyMfa("123456")).toEqual({ ok: false, error: "mfa_invalid" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("código errado: incrementa o cookie, audita mfa_failed e devolve mfa_invalid", async () => {
    verify.mockResolvedValue({ error: { message: "Invalid TOTP code" } });
    cookieGet.mockReturnValue({ value: "1" });
    const { verifyMfa } = await import("./verifyMfa");

    expect(await verifyMfa("123456")).toEqual({ ok: false, error: "mfa_invalid" });

    expect(cookieSet).toHaveBeenCalledWith(
      "mfa_attempts",
      "2",
      expect.objectContaining({ httpOnly: true, sameSite: "strict", maxAge: 60, path: "/" }),
    );
    expect(audit).toHaveBeenCalledWith({
      action: "auth.mfa_failed",
      actorUserId: "u1",
      metadata: { locked: false, attempts: 2 },
      requestId: "req-7",
      ip: "192.0.2.77",
      userAgent: "UA-test",
    });
  });

  it("3ª falha seguida: trava (mfa_locked) e audita locked=true", async () => {
    verify.mockResolvedValue({ error: { message: "Invalid TOTP code" } });
    cookieGet.mockReturnValue({ value: "2" });
    const { verifyMfa } = await import("./verifyMfa");

    expect(await verifyMfa("123456")).toEqual({
      ok: false,
      error: "mfa_locked",
      retry_in_seconds: 60,
    });
    expect(cookieSet).toHaveBeenCalledWith("mfa_attempts", "3", expect.anything());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.mfa_failed",
        metadata: { locked: true, attempts: 3 },
      }),
    );
  });

  it("cookie de tentativas corrompido conta como zero", async () => {
    verify.mockResolvedValue({ error: { message: "Invalid TOTP code" } });
    cookieGet.mockReturnValue({ value: "lixo" });
    const { verifyMfa } = await import("./verifyMfa");

    await verifyMfa("123456");

    expect(cookieSet).toHaveBeenCalledWith("mfa_attempts", "1", expect.anything());
  });

  it("sucesso: apaga o contador, audita mfa_success e redireciona para /app", async () => {
    const { verifyMfa } = await import("./verifyMfa");

    await expect(verifyMfa("123456")).rejects.toThrow("REDIRECT:/app");

    expect(challenge).toHaveBeenCalledWith({ factorId: "f1" });
    expect(verify).toHaveBeenCalledWith({ factorId: "f1", challengeId: "ch1", code: "123456" });
    expect(cookieDelete).toHaveBeenCalledWith("mfa_attempts");
    expect(audit).toHaveBeenCalledWith({
      action: "auth.mfa_success",
      actorUserId: "u1",
      metadata: {},
      requestId: "req-7",
      ip: "192.0.2.77",
      userAgent: "UA-test",
    });
  });

  it("sucesso com next interno: redireciona para ele", async () => {
    const { verifyMfa } = await import("./verifyMfa");

    await expect(verifyMfa("123456", "/app/leads")).rejects.toThrow("REDIRECT:/app/leads");
  });

  it("sucesso com next externo: ignora e vai para /app", async () => {
    const { verifyMfa } = await import("./verifyMfa");

    await expect(verifyMfa("123456", "https://evil.example")).rejects.toThrow("REDIRECT:/app");
  });
});
