/**
 * MODO DE CADASTRO DA INSTALAÇÃO — gate de platform admin, validação, escrita e trilha.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { gravarModoDeCadastro, modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (k: string) =>
      (
        ({
          "x-request-id": "req-1",
          "x-forwarded-for": "203.0.113.9, 10.0.0.1",
          "user-agent": "ua",
        }) as Record<string, string>
      )[k] ?? null,
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/auth/politica-de-cadastro", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  modoDeCadastro: vi.fn(async () => "aberto"),
  gravarModoDeCadastro: vi.fn(async () => true),
}));

import { updateSignupMode } from "./updateSignupMode";

const ADMIN = "11111111-1111-4111-8111-111111111111";

describe("updateSignupMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: ADMIN } } as never);
    vi.mocked(modoDeCadastro).mockResolvedValue("aberto");
    vi.mocked(gravarModoDeCadastro).mockResolvedValue(true);
  });

  it("quem não é platform admin: o gate lança/redireciona e NADA é lido, gravado ou auditado", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("NEXT_REDIRECT:/admin/forbidden"));
    await expect(updateSignupMode({ signup_mode: "so_convite" })).rejects.toThrow("NEXT_REDIRECT");
    expect(modoDeCadastro).not.toHaveBeenCalled();
    expect(gravarModoDeCadastro).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("modo fora do vocabulário: invalid_input, sem escrita", async () => {
    const r = await updateSignupMode({ signup_mode: "qualquer" as never });
    expect(r).toEqual({ ok: false, error: "invalid_input" });
    expect(gravarModoDeCadastro).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("escrita falhou: write_failed e SEM linha de auditoria", async () => {
    vi.mocked(gravarModoDeCadastro).mockResolvedValue(false);
    expect(await updateSignupMode({ signup_mode: "so_convite" })).toEqual({
      ok: false,
      error: "write_failed",
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("caminho feliz: grava com o ator, audita de→para com o primeiro IP", async () => {
    expect(await updateSignupMode({ signup_mode: "so_convite" })).toEqual({ ok: true });
    expect(gravarModoDeCadastro).toHaveBeenCalledWith("so_convite", ADMIN);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "platform.signup_mode_updated",
      actorUserId: ADMIN,
      resourceType: "platform_settings",
      metadata: { de: "aberto", para: "so_convite" },
      requestId: "req-1",
      ip: "203.0.113.9",
      userAgent: "ua",
    });
  });
});
