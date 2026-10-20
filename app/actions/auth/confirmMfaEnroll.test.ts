/**
 * confirmMfaEnroll — confirma o TOTP e entrega 10 códigos de recuperação.
 * Mede por efeito: recusas (sem usuário, código fora de 6 dígitos, desafio ou
 * verificação falhos) não geram códigos nem audit; o sucesso grava só HASHES
 * (nunca o texto), cai para o admin quando a RLS recusa, e audita mfa_enrolled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const getUser = vi.fn();
const challenge = vi.fn();
const verify = vi.fn();
const userInsert = vi.fn();
const adminInsert = vi.fn();

describe("confirmMfaEnroll", () => {
  beforeEach(() => {
    vi.resetModules();
    getUser.mockReset();
    challenge.mockReset();
    verify.mockReset();
    userInsert.mockReset();
    adminInsert.mockReset();
    vi.mocked(audit).mockClear();
    vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    challenge.mockResolvedValue({ data: { id: "ch1" }, error: null });
    verify.mockResolvedValue({ error: null });
    userInsert.mockResolvedValue({ error: null });
    adminInsert.mockResolvedValue({ error: null });
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) =>
        ({
          "x-request-id": "req-5",
          "x-forwarded-for": "192.0.2.9, 10.0.0.1",
          "user-agent": "UA-test",
        })[k] ?? null,
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser, mfa: { challenge, verify } },
      from: vi.fn(() => ({ insert: userInsert })),
    } as never);
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn(() => ({ insert: adminInsert })),
    } as never);
  });

  it("sem usuário: redireciona para /login", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    await expect(confirmMfaEnroll("123456", "f1")).rejects.toThrow("REDIRECT:/login");

    expect(challenge).not.toHaveBeenCalled();
  });

  it.each(["12345", "1234567", "abcdef", "12 456", ""])(
    "código %j fora do formato: invalid_code sem falar com o provedor",
    async (code) => {
      const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

      expect(await confirmMfaEnroll(code, "f1")).toEqual({ ok: false, error: "invalid_code" });

      expect(challenge).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it("falha ao criar o desafio: challenge_failed", async () => {
    challenge.mockResolvedValue({ data: null, error: { message: "no factor" } });
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    expect(await confirmMfaEnroll("123456", "f1")).toEqual({
      ok: false,
      error: "challenge_failed",
      message: "no factor",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("código errado no provedor: verify_failed, sem códigos de recuperação nem audit", async () => {
    verify.mockResolvedValue({ error: { message: "Invalid TOTP code" } });
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    expect(await confirmMfaEnroll("123456", "f1")).toEqual({
      ok: false,
      error: "verify_failed",
      message: "Invalid TOTP code",
    });
    expect(userInsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("sucesso: devolve 10 códigos, grava só hashes do usuário e audita mfa_enrolled", async () => {
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    const r = await confirmMfaEnroll("123456", "f1");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recovery_codes).toHaveLength(10);
    expect(challenge).toHaveBeenCalledWith({ factorId: "f1" });
    expect(verify).toHaveBeenCalledWith({ factorId: "f1", challengeId: "ch1", code: "123456" });

    const rows = userInsert.mock.calls[0]![0] as { user_id: string; code_hash: unknown }[];
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.user_id === "u1")).toBe(true);
    // Texto puro nunca vai para a linha.
    for (const c of r.recovery_codes) {
      expect(JSON.stringify(rows)).not.toContain(c);
    }
    expect(adminInsert).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      action: "auth.mfa_enrolled",
      actorUserId: "u1",
      metadata: { recovery_codes_generated: 10 },
      requestId: "req-5",
      ip: "192.0.2.9",
      userAgent: "UA-test",
    });
  });

  it("RLS recusa o insert do usuário: cai para o admin e ainda entrega os códigos", async () => {
    userInsert.mockResolvedValue({ error: { message: "rls" } });
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    const r = await confirmMfaEnroll("123456", "f1");

    expect(r.ok).toBe(true);
    expect(adminInsert).toHaveBeenCalledTimes(1);
    expect(adminInsert.mock.calls[0]![0]).toEqual(userInsert.mock.calls[0]![0]);
  });

  it("insert falha também no admin: ainda devolve ok e audita (erro vai ao log)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    userInsert.mockResolvedValue({ error: { message: "rls" } });
    adminInsert.mockResolvedValue({ error: { message: "db down" } });
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    const r = await confirmMfaEnroll("123456", "f1");

    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "[confirmMfaEnroll] failed to insert recovery codes:",
      "db down",
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa_enrolled" }));
    spy.mockRestore();
  });
});
