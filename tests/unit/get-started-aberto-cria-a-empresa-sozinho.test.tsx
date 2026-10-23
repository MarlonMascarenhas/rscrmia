/**
 * `/get-started` EM INSTALAÇÃO `aberto` CRIA A EMPRESA SOZINHO.
 *
 * Quem chega logado, sem empresa, sem convite pendente e sem vínculo revogado
 * não preenche outro formulário: a página provisiona e segue para o onboarding.
 * Convite, revogado, `so_convite`, `com_aprovacao`, teto de tentativas e falha
 * de provisão mantêm a tela atual.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  modo: "aberto" as "aberto" | "com_aprovacao" | "so_convite",
  revogado: false,
  limitado: false,
  metadata: { org_name: "Plata Iphones" } as Record<string, unknown>,
};
const ensureTenantForUser = vi.fn();

vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u-1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => null,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "u-1", email: "dono@plata.test", user_metadata: estado.metadata } },
      }),
    },
  }),
}));
vi.mock("@/lib/branding", () => ({ branding: () => ({ name: "Deskcomm" }) }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: async () => estado.modo }));
vi.mock("@/lib/auth/registration-requests", () => ({ estadoDoPedido: async () => null }));
vi.mock("@/lib/auth/provision", () => ({
  ensureTenantForUser: (...a: unknown[]) => ensureTenantForUser(...a),
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => estado.revogado }));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: async () => estado.limitado,
  AUTH_LIMITS: { org_recovery: {} },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/components/auth/RecoverOrganizationForm", () => ({
  RecoverOrganizationForm: () => null,
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));

beforeEach(() => {
  estado.modo = "aberto";
  estado.revogado = false;
  estado.limitado = false;
  estado.metadata = { org_name: "Plata Iphones" };
  ensureTenantForUser.mockReset();
  ensureTenantForUser.mockResolvedValue({ provisioned: true, organizationId: "org-1" });
});

async function abrir() {
  const { default: Page } = await import("@/app/get-started/page");
  return Page();
}

describe("/get-started", () => {
  it("aberto, sem convite: provisiona com o nome digitado e vai ao onboarding", async () => {
    await expect(abrir()).rejects.toThrow("REDIRECT:/onboarding/welcome");
    expect(ensureTenantForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "u-1",
        user_metadata: { org_name: "Plata Iphones" },
      }),
      { source: "signup" },
    );
  });

  it("convite pendente: NÃO provisiona", async () => {
    // Token inválido ainda é "havia convite": a decisão não é `provisionar`.
    estado.metadata = { invite_token: "lixo" };
    await expect(abrir()).resolves.toBeTruthy();
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("revogado: NÃO provisiona", async () => {
    estado.revogado = true;
    await expect(abrir()).resolves.toBeTruthy();
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("so_convite: NÃO provisiona", async () => {
    estado.modo = "so_convite";
    await expect(abrir()).resolves.toBeTruthy();
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("com_aprovacao: NÃO provisiona (o pedido segue o fluxo atual)", async () => {
    estado.modo = "com_aprovacao";
    await expect(abrir()).resolves.toBeTruthy();
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("teto de tentativas: NÃO provisiona", async () => {
    estado.limitado = true;
    await expect(abrir()).resolves.toBeTruthy();
    expect(ensureTenantForUser).not.toHaveBeenCalled();
  });

  it("falha de provisão: mostra o formulário com a mensagem de erro", async () => {
    ensureTenantForUser.mockRejectedValue(new Error("db fora"));
    const el = (await abrir()) as { props: unknown };
    expect(JSON.stringify(el.props)).toContain("Não foi possível criar a empresa agora");
  });
});
