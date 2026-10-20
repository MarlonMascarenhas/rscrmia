/**
 * CONVITES EM LOTE DO ONBOARDING — o e-mail que não sai NÃO some em silêncio.
 *
 * O token é assinado de verdade: o que se prova é que a organização dentro dele
 * é a da SESSÃO (`requireOnboardingCtx`), nunca algo vindo do payload.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { sendEmail } from "@/lib/email/roteador";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br/" } }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: vi.fn(async () => ({ nome: "Marca" })) }));
vi.mock("@/lib/email/templates/invite", () => ({
  buildInviteEmail: vi.fn(() => ({ subject: "s", html: "<p>h</p>", text: "t" })),
}));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: vi.fn() }));
vi.mock("./_shared", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireOnboardingCtx: vi.fn(),
  patchOnboardingState: vi.fn(async () => undefined),
}));

import { sendOnboardingInvites } from "./sendOnboardingInvites";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

describe("sendOnboardingInvites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireOnboardingCtx).mockResolvedValue({
      userId: USER,
      orgId: ORG,
      orgName: "Acme",
      role: "admin",
      fullName: "Dona",
      email: "dona@acme.com.br",
    });
    vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never);
  });

  it("sem sessão: auth_required, sem e-mail nem auditoria", async () => {
    vi.mocked(requireOnboardingCtx).mockRejectedValue(new OnboardingError("auth_required", "x"));
    const r = await sendOnboardingInvites({ invitations: [{ email: "a@b.com", role: "agent" }] });
    expect(r).toEqual({ ok: false, error: "auth_required" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem organização ativa: no_active_org", async () => {
    vi.mocked(requireOnboardingCtx).mockRejectedValue(new OnboardingError("no_active_org", "x"));
    const r = await sendOnboardingInvites({ invitations: [{ email: "a@b.com", role: "agent" }] });
    expect(r).toEqual({ ok: false, error: "no_active_org" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("erro que não é do onboarding é relançado", async () => {
    vi.mocked(requireOnboardingCtx).mockRejectedValue(new Error("boom"));
    await expect(sendOnboardingInvites({ invitations: [] })).rejects.toThrow("boom");
  });

  it("skip: grava estado, audita onboarding.team_invited e sai pelo onboarding, sem e-mail", async () => {
    await expect(sendOnboardingInvites({ invitations: [], skip: true })).rejects.toThrow(
      "NEXT_REDIRECT:/onboarding",
    );
    expect(patchOnboardingState).toHaveBeenCalledWith(ORG, {
      team: { invites_sent: 0, skipped: true },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "onboarding.team_invited",
        actorUserId: USER,
        organizationId: ORG,
        metadata: { skipped: true, count: 0 },
      }),
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["e-mail inválido", { invitations: [{ email: "nao-e-email", role: "agent" as const }] }],
    ["papel fora do vocabulário (ai_operator)", { invitations: [{ email: "a@b.com", role: "ai_operator" as never }] }],
    ["lista vazia", { invitations: [] }],
  ])("%s: invalid_input, sem e-mail nem escrita", async (_n, payload) => {
    const r = await sendOnboardingInvites(payload);
    expect(r).toMatchObject({ ok: false, error: "invalid_input" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(patchOnboardingState).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("tudo entregue: token com a org da SESSÃO, e-mail normalizado, 2 audits por convite+resumo, redirect", async () => {
    await expect(
      sendOnboardingInvites({ invitations: [{ email: "Novo@Acme.com.br", role: "manager" }] }),
    ).rejects.toThrow("NEXT_REDIRECT:/onboarding");

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0]![0]).toMatchObject({ to: "novo@acme.com.br" });

    const { buildInviteEmail } = await import("@/lib/email/templates/invite");
    const { acceptUrl } = vi.mocked(buildInviteEmail).mock.calls[0]![0];
    expect(acceptUrl.startsWith("https://crm.exemplo.com.br/team/accept-invite/")).toBe(true);
    const payload = verifyInviteToken(acceptUrl.split("/team/accept-invite/")[1]!);
    expect(payload).toMatchObject({ organization_id: ORG, email: "novo@acme.com.br", role: "manager" });

    const acoes = vi.mocked(audit).mock.calls.map((c) => c[0].action);
    expect(acoes).toEqual(["member.invited", "onboarding.team_invited"]);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      actorUserId: USER,
      organizationId: ORG,
      metadata: { email: "novo@acme.com.br", role: "manager", email_dispatched: true, source: "onboarding" },
    });
    expect(patchOnboardingState).toHaveBeenCalledWith(ORG, {
      team: { invites_sent: 1, skipped: false },
    });
  });

  it("e-mail não saiu: NÃO redireciona; devolve o link de aceite para envio manual e audita email_dispatched=false", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false } as never);
    const r = await sendOnboardingInvites({
      invitations: [{ email: "novo@acme.com.br", role: "agent" }],
    });
    expect(r).toMatchObject({ ok: true, sent: 0, failed: 1 });
    const und = (r as { undelivered?: { email: string; accept_url: string }[] }).undelivered;
    expect(und).toHaveLength(1);
    expect(und![0]!.email).toBe("novo@acme.com.br");
    expect(und![0]!.accept_url).toContain("/team/accept-invite/");
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "member.invited",
      metadata: expect.objectContaining({ email_dispatched: false }),
    });
  });
});
