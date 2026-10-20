/**
 * enrollMfa — início do cadastro TOTP. Mede por efeito: sem usuário vai para
 * /login; fatores TOTP não verificados antigos são removidos (e só eles); o
 * enroll leva a marca da instalação em `issuer`; erro do provedor vira
 * enroll_failed; sucesso devolve o QR como PNG data URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "MarcaTeste" })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const getUser = vi.fn();
const listFactors = vi.fn();
const unenroll = vi.fn(async () => ({ error: null }));
const enroll = vi.fn();

const URI = "otpauth://totp/MarcaTeste:pessoa@example.com?secret=ABC123&issuer=MarcaTeste";

describe("enrollMfa", () => {
  beforeEach(() => {
    vi.resetModules();
    getUser.mockReset();
    listFactors.mockReset();
    unenroll.mockClear();
    enroll.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    listFactors.mockResolvedValue({ data: { all: [] } });
    enroll.mockResolvedValue({
      data: { id: "f-new", totp: { uri: URI, secret: "ABC123" } },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser, mfa: { listFactors, unenroll, enroll } },
    } as never);
  });

  it("sem usuário: redireciona para /login e não toca em fatores", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const { enrollMfa } = await import("./enrollMfa");

    await expect(enrollMfa()).rejects.toThrow("REDIRECT:/login");

    expect(listFactors).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
  });

  it("caminho feliz: enroll TOTP com issuer da marca e QR em PNG data URL", async () => {
    const { enrollMfa } = await import("./enrollMfa");

    const r = await enrollMfa();

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.factor_id).toBe("f-new");
      expect(r.uri).toBe(URI);
      expect(r.secret).toBe("ABC123");
      expect(r.qr_data_url.startsWith("data:image/png;base64,")).toBe(true);
    }
    expect(enroll).toHaveBeenCalledWith({
      factorType: "totp",
      friendlyName: expect.stringMatching(/^Acesso \d{4}-\d{2}-\d{2}$/),
      issuer: "MarcaTeste",
    });
    expect(unenroll).not.toHaveBeenCalled();
  });

  it("remove só fatores TOTP não verificados antes de recadastrar", async () => {
    listFactors.mockResolvedValue({
      data: {
        all: [
          { id: "velho", factor_type: "totp", status: "unverified" },
          { id: "ativo", factor_type: "totp", status: "verified" },
          { id: "outro", factor_type: "phone", status: "unverified" },
        ],
      },
    });
    const { enrollMfa } = await import("./enrollMfa");

    await enrollMfa();

    expect(unenroll).toHaveBeenCalledTimes(1);
    expect(unenroll).toHaveBeenCalledWith({ factorId: "velho" });
  });

  it("erro do provedor no enroll: enroll_failed com a mensagem", async () => {
    enroll.mockResolvedValue({ data: null, error: { message: "friendly name exists" } });
    const { enrollMfa } = await import("./enrollMfa");

    const r = await enrollMfa();

    expect(r).toEqual({ ok: false, error: "enroll_failed", message: "friendly name exists" });
  });
});
