import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { encerrarSessoesDaEmpresaExcluida } from "@/lib/channels/encerrar-sessoes";
import { removerObjetosDaEmpresa } from "@/lib/tenants/limpar-armazenamento";

/**
 * DELETE /api/v1/admin/tenants/[id] — exclui a empresa inteira.
 * A regra (slug, assinatura ativa, ordem do apagamento) mora na função SQL
 * `fn_admin_excluir_organizacao`; aqui se prova o que a ROTA faz com a resposta dela.
 */

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/encerrar-sessoes", () => ({ encerrarSessoesDaEmpresaExcluida: vi.fn() }));
vi.mock("@/lib/tenants/limpar-armazenamento", () => ({ removerObjetosDaEmpresa: vi.fn() }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const SESSOES = [{ id: "s1", provider: "x" }];

function montarRpc(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
  return rpc;
}

async function chamar(corpo: unknown = { confirmacao_slug: "acme" }, id = ORG_ID) {
  const { DELETE } = await import("./route");
  return DELETE(
    new NextRequest(`http://localhost/api/v1/admin/tenants/${id}`, {
      method: "DELETE",
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const EXCLUIDA = {
  ok: true,
  codigo: "excluida",
  slug: "acme",
  display_name: "Acme",
  sessoes_de_canal: SESSOES,
  contagens: { usuarios: 2, conversas: 3, mensagens: 10, contatos: 4, leads: 5, sessoes_de_canal: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
  vi.mocked(encerrarSessoesDaEmpresaExcluida).mockResolvedValue({ encerradas: 1, ignoradas: 0, falhas: [] });
  vi.mocked(removerObjetosDaEmpresa).mockResolvedValue({ removidos: 7, falhas: [] });
});

describe("DELETE /api/v1/admin/tenants/[id]", () => {
  it("403 sem platform admin, sem tocar no banco", async () => {
    vi.mocked(requirePlatformAdmin).mockRejectedValue(new Error("NEXT_REDIRECT"));
    const rpc = montarRpc(null);
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("403 para platform admin de leitura", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      user: { id: ADMIN_ID },
      platformAdmin: { user_id: ADMIN_ID, scope: "read", mfa_required: true },
    } as never);
    const rpc = montarRpc(null);
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("400 quando o corpo não passa no Zod", async () => {
    const rpc = montarRpc(null);
    expect((await chamar({})).status).toBe(400);
    expect((await chamar({ confirmacao_slug: "" })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("400 quando o id não é uuid", async () => {
    const rpc = montarRpc(null);
    expect((await chamar({ confirmacao_slug: "acme" }, "nao-e-uuid")).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("422 quando o slug não confere, sem limpeza nem audit", async () => {
    montarRpc({ ok: false, codigo: "slug_nao_confere" });
    const res = await chamar({ confirmacao_slug: "errado" });
    expect(res.status).toBe(422);
    expect(encerrarSessoesDaEmpresaExcluida).not.toHaveBeenCalled();
    expect(removerObjetosDaEmpresa).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("409 com assinatura ativa, sem limpeza nem audit", async () => {
    montarRpc({
      ok: false,
      codigo: "assinatura_ativa",
      assinatura: { asaas_assinatura_id: "sub_1", situacao: "ativa", liberado_ate: null },
    });
    const res = await chamar();
    expect(res.status).toBe(409);
    const corpo = (await res.json()) as { error: { code: string; details: { assinatura: unknown } } };
    expect(corpo.error.code).toBe("assinatura_ativa");
    expect(corpo.error.details.assinatura).toMatchObject({ asaas_assinatura_id: "sub_1" });
    expect(removerObjetosDaEmpresa).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("409 com acompanhamento de suporte aberto", async () => {
    montarRpc({ ok: false, codigo: "em_acompanhamento" });
    const res = await chamar();
    expect(res.status).toBe(409);
    expect(removerObjetosDaEmpresa).not.toHaveBeenCalled();
  });

  it("404 quando a empresa não existe", async () => {
    montarRpc({ ok: false, codigo: "nao_encontrada" });
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("500 quando a função falha", async () => {
    montarRpc(null, { message: "boom" });
    const res = await chamar();
    expect(res.status).toBe(500);
    expect(removerObjetosDaEmpresa).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("200: chama a função com o slug digitado, faz a limpeza e audita com organização nula", async () => {
    const rpc = montarRpc(EXCLUIDA);
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith("fn_admin_excluir_organizacao", {
      p_org_id: ORG_ID,
      p_slug_confirmacao: "acme",
    });
    expect(encerrarSessoesDaEmpresaExcluida).toHaveBeenCalledWith(expect.anything(), SESSOES);
    expect(removerObjetosDaEmpresa).toHaveBeenCalledWith(expect.anything(), ORG_ID);

    const corpo = (await res.json()) as {
      data: { deleted: boolean; limpeza: { midias_removidas: number; sessoes_encerradas: number; falhas: string[] } };
    };
    expect(corpo.data.deleted).toBe(true);
    expect(corpo.data.limpeza).toEqual({ midias_removidas: 7, sessoes_encerradas: 1, falhas: [] });

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada.action).toBe("admin.tenant_deleted");
    expect(entrada.organizationId).toBeNull();
    expect(entrada.actorUserId).toBe(ADMIN_ID);
    expect(entrada.resourceId).toBe(ORG_ID);
    expect(entrada.metadata).toMatchObject({
      organization_id: ORG_ID,
      slug: "acme",
      display_name: "Acme",
      contagens: EXCLUIDA.contagens,
      limpeza: { midias_removidas: 7, sessoes_encerradas: 1, falhas: [] },
    });
  });

  it("200 mesmo se a limpeza falhar: reporta as falhas no corpo e no audit", async () => {
    montarRpc(EXCLUIDA);
    vi.mocked(encerrarSessoesDaEmpresaExcluida).mockRejectedValue(new Error("transporte fora"));
    vi.mocked(removerObjetosDaEmpresa).mockResolvedValue({
      removidos: 2,
      falhas: ["whatsapp-media: não foi possível listar uma pasta (timeout)."],
    });
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { limpeza: { falhas: string[]; midias_removidas: number } } };
    expect(corpo.data.limpeza.midias_removidas).toBe(2);
    expect(corpo.data.limpeza.falhas).toHaveLength(2);
    expect(corpo.data.limpeza.falhas.join(" ")).toContain("transporte fora");
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect((entrada.metadata as { limpeza: { falhas: string[] } }).limpeza.falhas).toHaveLength(2);
  });
});
