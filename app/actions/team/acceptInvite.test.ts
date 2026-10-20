/**
 * ACEITAR CONVITE — org, papel e convidador vêm do TOKEN; o usuário, do JWT.
 *
 * O token é assinado de verdade (`signInviteToken`), não dublado: o que se mede
 * é que a action entrega a `aplicarConvite` a organização DO TOKEN e o usuário
 * da sessão, e que nenhuma recusa chega a gravar vínculo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { signInviteToken, type InvitePayload } from "@/lib/auth/invite-token";
import { readSupportContext } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ readSupportContext: vi.fn(async () => null) }));
vi.mock("@/lib/auth/aplicar-convite", () => ({ aplicarConvite: vi.fn() }));

import { acceptInviteAction } from "./acceptInvite";

const ORG_DO_TOKEN = "22222222-2222-4222-8222-222222222222";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const CONVITE = "44444444-4444-4444-8444-444444444444";

function token(over: Partial<InvitePayload> = {}): string {
  return signInviteToken({
    invite_id: CONVITE,
    email: "Ana@Exemplo.com.br",
    organization_id: ORG_DO_TOKEN,
    role: "agent",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  });
}

function comSessao(email: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: email === null ? null : { id: USUARIO, email } },
      })),
    },
  } as never);
}

describe("acceptInviteAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readSupportContext).mockResolvedValue(null);
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: true, membershipId: "m1", mudou: true });
  });

  it("token adulterado: invalid_or_expired, sem nem abrir sessão", async () => {
    const t = token();
    const r = await acceptInviteAction(t.slice(0, -2) + "xx");
    expect(r).toEqual({ ok: false, error: "invalid_or_expired" });
    expect(createClient).not.toHaveBeenCalled();
    expect(aplicarConvite).not.toHaveBeenCalled();
  });

  it("token expirado: invalid_or_expired, sem vínculo", async () => {
    const r = await acceptInviteAction(token({ exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(r).toEqual({ ok: false, error: "invalid_or_expired" });
    expect(aplicarConvite).not.toHaveBeenCalled();
  });

  it("lixo que nem é token: invalid_or_expired", async () => {
    expect(await acceptInviteAction("lixo")).toEqual({ ok: false, error: "invalid_or_expired" });
  });

  it("sem sessão: not_authenticated, sem vínculo", async () => {
    comSessao(null);
    expect(await acceptInviteAction(token())).toEqual({ ok: false, error: "not_authenticated" });
    expect(aplicarConvite).not.toHaveBeenCalled();
  });

  it("e-mail da sessão diverge do convite: email_mismatch com o esperado, sem vínculo", async () => {
    comSessao("outra@exemplo.com.br");
    expect(await acceptInviteAction(token())).toEqual({
      ok: false,
      error: "email_mismatch",
      expectedEmail: "Ana@Exemplo.com.br",
    });
    expect(aplicarConvite).not.toHaveBeenCalled();
  });

  it("em acompanhamento de suporte: recusa sem vínculo", async () => {
    comSessao("ana@exemplo.com.br");
    vi.mocked(readSupportContext).mockResolvedValue({ id: "s1" } as never);
    const r = await acceptInviteAction(token());
    expect(r).toMatchObject({ ok: false, error: "internal_error" });
    expect(aplicarConvite).not.toHaveBeenCalled();
  });

  it("convite revogado (aplicarConvite recusa): devolve o motivo e não redireciona", async () => {
    comSessao("ana@exemplo.com.br");
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: false, motivo: "invalid_or_expired" });
    expect(await acceptInviteAction(token())).toEqual({ ok: false, error: "invalid_or_expired" });
  });

  it("falha de infraestrutura: internal_error", async () => {
    comSessao("ana@exemplo.com.br");
    vi.mocked(aplicarConvite).mockResolvedValue({ ok: false, motivo: "internal_error" });
    expect(await acceptInviteAction(token())).toEqual({ ok: false, error: "internal_error" });
  });

  it("aceite feliz (e-mail com caixa/espaço diferente): vínculo na org do TOKEN, usuário do JWT, e redireciona", async () => {
    comSessao("  ANA@exemplo.com.br ");
    await expect(acceptInviteAction(token())).rejects.toThrow("NEXT_REDIRECT:/app");
    expect(aplicarConvite).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(aplicarConvite).mock.calls[0]![0];
    expect(arg.userId).toBe(USUARIO);
    expect(arg.payload.organization_id).toBe(ORG_DO_TOKEN);
    expect(arg.payload.role).toBe("agent");
    expect(arg.payload.invite_id).toBe(CONVITE);
  });
});
