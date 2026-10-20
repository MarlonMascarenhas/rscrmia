/**
 * APP OAUTH DO GOOGLE DA INSTALAÇÃO — gate de platform admin, cifra obrigatória
 * e segredo NUNCA na trilha nem no retorno.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invalidarCredencialDoGoogle } from "@/lib/agenda/google/config";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (k: string) => (k === "x-request-id" ? "req-1" : null) })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/agenda/google/config", () => ({ invalidarCredencialDoGoogle: vi.fn() }));

import { updateGoogleOAuth } from "./updateGoogleOAuth";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "123456789-abc.apps.googleusercontent.com";
const SEGREDO = "GOCSPX-super-secreto-123";

function adminClient(erro: { message: string } | null = null) {
  const upsert = vi.fn(async (..._args: unknown[]) => ({ error: erro }));
  const from = vi.fn(() => ({ upsert }));
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return { from, upsert };
}

describe("updateGoogleOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ user: { id: ADMIN } } as never);
    vi.mocked(encryptWebhookSecret).mockResolvedValue("CIFRADO" as never);
  });

  it("quem não é platform admin: nada é criado, cifrado, gravado ou auditado", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("NEXT_REDIRECT:/admin/forbidden"));
    await expect(updateGoogleOAuth({ client_id: CLIENT_ID })).rejects.toThrow("NEXT_REDIRECT");
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(encryptWebhookSecret).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("client_id curto demais: invalid_input com details, sem escrita", async () => {
    const r = await updateGoogleOAuth({ client_id: "curto" });
    expect(r).toMatchObject({ ok: false, error: "invalid_input" });
    expect((r as { details?: unknown }).details).toBeDefined();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("segredo curto demais: invalid_input", async () => {
    expect(await updateGoogleOAuth({ client_id: CLIENT_ID, client_secret: "x" })).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    expect(encryptWebhookSecret).not.toHaveBeenCalled();
  });

  it("cifra indisponível: RECUSA — nada é gravado em claro, sem audit, e o segredo não vaza no erro", async () => {
    vi.mocked(encryptWebhookSecret).mockResolvedValue(null as never);
    const { upsert } = adminClient();
    const r = await updateGoogleOAuth({ client_id: CLIENT_ID, client_secret: SEGREDO });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SEGREDO);
    expect(upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("erro do banco: devolve a mensagem, sem audit e sem invalidar cache", async () => {
    adminClient({ message: "boom" });
    expect(await updateGoogleOAuth({ client_id: CLIENT_ID })).toEqual({ ok: false, error: "boom" });
    expect(audit).not.toHaveBeenCalled();
    expect(invalidarCredencialDoGoogle).not.toHaveBeenCalled();
  });

  it("só o client_id: upsert do singleton SEM tocar no segredo gravado; audit sem organização", async () => {
    const { from, upsert } = adminClient();
    expect(await updateGoogleOAuth({ client_id: CLIENT_ID })).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("platform_google_oauth");
    expect(encryptWebhookSecret).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      { id: 1, client_id: CLIENT_ID, updated_by: ADMIN },
      { onConflict: "id" },
    );
    expect(invalidarCredencialDoGoogle).toHaveBeenCalledTimes(1);
    const a = vi.mocked(audit).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(a).toMatchObject({
      action: "platform_google_oauth.updated",
      actorUserId: ADMIN,
      resourceType: "platform_google_oauth",
      resourceId: null,
      actingAsPlatformAdmin: true,
      metadata: { campos: ["client_id"], segredo_trocado: false },
    });
    expect(a.organizationId).toBeUndefined();
  });

  it("com segredo: grava só o CIFRADO; segredo e client_id nunca aparecem na trilha nem no retorno", async () => {
    const { upsert } = adminClient();
    const r = await updateGoogleOAuth({ client_id: CLIENT_ID, client_secret: SEGREDO });
    expect(r).toEqual({ ok: true });
    expect(encryptWebhookSecret).toHaveBeenCalledWith(expect.anything(), SEGREDO);
    const gravado = upsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(gravado.client_secret_encrypted).toBe("CIFRADO");
    expect(JSON.stringify(gravado)).not.toContain(SEGREDO);
    const trilha = JSON.stringify(vi.mocked(audit).mock.calls[0]![0]);
    expect(trilha).not.toContain(SEGREDO);
    expect(trilha).not.toContain(CLIENT_ID);
    expect(trilha).not.toContain("CIFRADO");
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      metadata: { campos: ["client_id", "client_secret_encrypted"], segredo_trocado: true },
    });
  });
});
