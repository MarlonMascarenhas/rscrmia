/**
 * NINGUÉM FICA PRESO SEM EMPRESA — provado EXECUTANDO o layout de `/app`.
 *
 * Autenticado, sem vínculo ativo e não revogado: o layout manda para
 * `/get-started`, que resolve conforme a política de cadastro. Antes, a pessoa
 * caía no Perfil, sem menu, sem saída. Revogado segue para `/acesso-revogado`;
 * platform admin e sessão de suporte seguem passando (operam cross-tenant).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = {
  user: {
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null as unknown,
    organizations: [],
  },
  org: null as unknown,
  revogado: false,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { onboarded_at: "2026-01-01", status: "active", settings: null },
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => estado.user,
  resolveActiveOrg: async () => estado.org,
  isMfaEnrolled: async () => true,
  requiresMfa: async () => false,
}));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => estado.revogado }));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({
  resolverMarcaDaOrganizacao: () => ({
    name: "Deskcomm",
    logoUrl: null,
    cor: "#000000",
    origens: { nome: "instalacao", logoUrl: "instalacao", cor: "instalacao" },
  }),
}));

beforeEach(() => {
  estado.user = {
    id: "user-1",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  };
  estado.org = null;
  estado.revogado = false;
});

async function renderizar() {
  const { default: AppLayout } = await import("@/app/app/layout");
  return AppLayout({ children: null });
}

describe("layout de /app sem empresa", () => {
  it("sem vínculo e não revogado → /get-started", async () => {
    await expect(renderizar()).rejects.toThrow("REDIRECT:/get-started");
  });

  it("revogado → /acesso-revogado (não /get-started)", async () => {
    estado.revogado = true;
    await expect(renderizar()).rejects.toThrow("REDIRECT:/acesso-revogado");
  });

  it("com empresa → passa", async () => {
    estado.org = { orgId: "org-1", role: "admin", interface_settings: null };
    await expect(renderizar()).resolves.toBeTruthy();
  });

  it("platform admin sem empresa própria → passa", async () => {
    estado.user.is_platform_admin = true;
    await expect(renderizar()).resolves.toBeTruthy();
  });

  it("sessão de suporte sem empresa própria → passa", async () => {
    estado.user.support = {
      organization_id: "org-9",
      name: "X",
      expires_at: "2099-01-01",
      access_mode: "read",
    };
    await expect(renderizar()).resolves.toBeTruthy();
  });
});
