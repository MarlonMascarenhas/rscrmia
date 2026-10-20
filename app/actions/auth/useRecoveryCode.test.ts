/**
 * useRecoveryCode — queima um código de recuperação. Mede por efeito: toda
 * recusa devolve o MESMO erro genérico (não vaza se o e-mail existe), nada é
 * queimado nem auditado nas recusas; o sucesso marca o código como usado,
 * remove os fatores, audita com o código mascarado e redireciona ao /login
 * com um `next` sanitizado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { hashRecoveryCode } from "@/lib/auth/recovery-codes";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
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

const listUsers = vi.fn();
const listFactors = vi.fn();
const deleteFactor = vi.fn(async () => ({ error: null }));
const maybeSingle = vi.fn();
const eqSelect = vi.fn();
const update = vi.fn();
const eqUpdate = vi.fn();

const ENTRADA = { email: "  Pessoa@Example.com ", code: " ab12cd34 " };

describe("useRecoveryCode", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [listUsers, listFactors, deleteFactor, maybeSingle, eqSelect, update, eqUpdate]) {
      m.mockReset();
    }
    vi.mocked(audit).mockClear();
    vi.mocked(isServiceRoleConfigured).mockReturnValue(true);
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u1", email: "pessoa@example.com" }] },
      error: null,
    });
    maybeSingle.mockResolvedValue({ data: { id: "row1", used_at: null }, error: null });
    eqUpdate.mockResolvedValue({ error: null });
    update.mockReturnValue({ eq: eqUpdate });
    listFactors.mockResolvedValue({ data: { factors: [{ id: "fa" }, { id: "fb" }] } });
    deleteFactor.mockResolvedValue({ error: null });

    const selectChain: Record<string, unknown> = {};
    selectChain.eq = eqSelect.mockReturnValue(selectChain);
    selectChain.is = vi.fn(() => selectChain);
    selectChain.limit = vi.fn(() => selectChain);
    selectChain.maybeSingle = maybeSingle;

    vi.mocked(headers).mockResolvedValue({
      get: (k: string) =>
        ({
          "x-request-id": "req-2",
          "x-forwarded-for": "192.0.2.50, 10.0.0.1",
          "user-agent": "UA-test",
        })[k] ?? null,
    } as never);
    vi.mocked(createAdminClient).mockReturnValue({
      auth: { admin: { listUsers, mfa: { listFactors, deleteFactor } } },
      from: vi.fn(() => ({ select: vi.fn(() => selectChain), update })),
    } as never);
  });

  it.each([
    ["e-mail inválido", { email: "nao-e-email", code: "AB12CD34" }],
    ["código curto", { email: "a@b.com", code: "AB12" }],
    ["código com símbolo", { email: "a@b.com", code: "AB12CD3!" }],
  ])("%s: invalid_or_used sem tocar no admin", async (_nome, entrada) => {
    const { useRecoveryCode } = await import("./useRecoveryCode");

    expect(await useRecoveryCode(entrada)).toEqual({ ok: false, error: "invalid_or_used" });

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("service role ausente: service_unavailable", async () => {
    vi.mocked(isServiceRoleConfigured).mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { useRecoveryCode } = await import("./useRecoveryCode");

    expect(await useRecoveryCode(ENTRADA)).toEqual({ ok: false, error: "service_unavailable" });

    expect(createAdminClient).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("erro ao listar usuários: invalid_or_used", async () => {
    listUsers.mockResolvedValue({ data: null, error: { message: "x" } });
    const { useRecoveryCode } = await import("./useRecoveryCode");

    expect(await useRecoveryCode(ENTRADA)).toEqual({ ok: false, error: "invalid_or_used" });
    expect(audit).not.toHaveBeenCalled();
  });

  it("e-mail desconhecido: o mesmo erro genérico", async () => {
    listUsers.mockResolvedValue({ data: { users: [{ id: "u9", email: "outro@x.com" }] }, error: null });
    const { useRecoveryCode } = await import("./useRecoveryCode");

    expect(await useRecoveryCode(ENTRADA)).toEqual({ ok: false, error: "invalid_or_used" });
    expect(update).not.toHaveBeenCalled();
  });

  it("código inexistente ou já usado: invalid_or_used, nada queimado", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const { useRecoveryCode } = await import("./useRecoveryCode");

    expect(await useRecoveryCode(ENTRADA)).toEqual({ ok: false, error: "invalid_or_used" });
    expect(update).not.toHaveBeenCalled();
    expect(deleteFactor).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("falha ao marcar como usado: invalid_or_used, sem apagar fatores", async () => {
    eqUpdate.mockResolvedValue({ error: { message: "db" } });
    const { useRecoveryCode } = await import("./useRecoveryCode");

    expect(await useRecoveryCode(ENTRADA)).toEqual({ ok: false, error: "invalid_or_used" });
    expect(deleteFactor).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("sucesso: busca pelo hash normalizado, queima, apaga todos os fatores, audita mascarado e vai ao /login", async () => {
    const { useRecoveryCode } = await import("./useRecoveryCode");

    await expect(useRecoveryCode(ENTRADA)).rejects.toThrow("REDIRECT:/login?recovery_used=1");

    expect(eqSelect).toHaveBeenCalledWith("user_id", "u1");
    expect(eqSelect).toHaveBeenCalledWith("code_hash", hashRecoveryCode("AB12CD34"));
    expect(update).toHaveBeenCalledWith({
      used_at: expect.any(String),
      used_ip: "192.0.2.50",
    });
    expect(eqUpdate).toHaveBeenCalledWith("id", "row1");
    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(deleteFactor).toHaveBeenCalledWith({ userId: "u1", id: "fa" });
    expect(deleteFactor).toHaveBeenCalledWith({ userId: "u1", id: "fb" });
    expect(audit).toHaveBeenCalledWith({
      action: "auth.recovery_code_used",
      actorUserId: "u1",
      metadata: { masked_code: "AB****34", next: null },
      requestId: "req-2",
      ip: "192.0.2.50",
      userAgent: "UA-test",
    });
  });

  it("next interno viaja para o /login; externo é descartado", async () => {
    const { useRecoveryCode } = await import("./useRecoveryCode");

    await expect(useRecoveryCode(ENTRADA, "/app/leads")).rejects.toThrow(
      "REDIRECT:/login?recovery_used=1&next=%2Fapp%2Fleads",
    );
    await expect(useRecoveryCode(ENTRADA, "https://evil.example")).rejects.toThrow(
      "REDIRECT:/login?recovery_used=1",
    );
  });

  it("erro ao apagar fatores é não-fatal: ainda audita e redireciona", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    listFactors.mockRejectedValue(new Error("boom"));
    const { useRecoveryCode } = await import("./useRecoveryCode");

    await expect(useRecoveryCode(ENTRADA)).rejects.toThrow("REDIRECT:/login?recovery_used=1");

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.recovery_code_used" }),
    );
    err.mockRestore();
  });
});
