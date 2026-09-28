import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/waha/client", () => ({ getWahaClient: vi.fn() }));

import { getWahaClient } from "@/lib/waha/client";
import { atualizarNomeDoGrupo, esquecerNomesDeGrupo } from "@/lib/waha/nome-do-grupo";

const ORG = "org-1";
const CONTACT = "contato-grupo-1";
const GROUP_CHAT_ID = "120363000000000000@g.us";
const SESSION_NAME = "sessao-waha-1";

interface Chamada {
  tabela: string;
  op: "update";
  valores: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
}

function bancoDeMentira(opts: { updateFalha?: { message: string }; updateLanca?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const admin = {
    from: (tabela: string) => ({
      update: (valores: Record<string, unknown>) => {
        const eqs: Array<[string, unknown]> = [];
        const encadeavel = {
          eq(coluna: string, valor: unknown) {
            eqs.push([coluna, valor]);
            return encadeavel;
          },
          then(resolve: (v: { error: { message: string } | null }) => void) {
            chamadas.push({ tabela, op: "update", valores, eqs });
            if (opts.updateLanca) throw new Error("conexão caiu");
            resolve({ error: opts.updateFalha ? { message: opts.updateFalha.message } : null });
          },
        };
        return encadeavel;
      },
    }),
  };
  return { admin, chamadas };
}

function clienteWaha(nome: string | null) {
  return { obterNomeDoGrupo: vi.fn().mockResolvedValue(nome) };
}

beforeEach(() => {
  esquecerNomesDeGrupo();
  vi.mocked(getWahaClient).mockReset();
});

describe("atualizarNomeDoGrupo", () => {
  it("busca no WAHA e grava display_name filtrando organization_id, id e is_group", async () => {
    const waha = clienteWaha("Elok");
    vi.mocked(getWahaClient).mockReturnValue(waha as never);
    const { admin, chamadas } = bancoDeMentira();

    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
    });

    expect(waha.obterNomeDoGrupo).toHaveBeenCalledWith(SESSION_NAME, GROUP_CHAT_ID);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.tabela).toBe("contacts");
    expect(chamadas[0]!.valores).toEqual({ display_name: "Elok" });
    expect(chamadas[0]!.eqs).toEqual([
      ["organization_id", ORG],
      ["id", CONTACT],
      ["is_group", true],
    ]);
  });

  it("segunda chamada dentro de 6h não chama o WAHA de novo", async () => {
    const waha = clienteWaha("Elok");
    vi.mocked(getWahaClient).mockReturnValue(waha as never);
    const { admin } = bancoDeMentira();
    const t0 = 1_000_000;

    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
      agora: t0,
    });
    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
      agora: t0 + 60_000, // bem dentro das 6h
    });

    expect(waha.obterNomeDoGrupo).toHaveBeenCalledTimes(1);
  });

  it("depois de 6h consulta o WAHA de novo", async () => {
    const waha = clienteWaha("Elok");
    vi.mocked(getWahaClient).mockReturnValue(waha as never);
    const { admin } = bancoDeMentira();
    const t0 = 1_000_000;
    const SEIS_HORAS_MS = 6 * 60 * 60 * 1000;

    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
      agora: t0,
    });
    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
      agora: t0 + SEIS_HORAS_MS + 1,
    });

    expect(waha.obterNomeDoGrupo).toHaveBeenCalledTimes(2);
  });

  it("nome null não faz update, mas ainda memoriza (não martela o WAHA)", async () => {
    const waha = clienteWaha(null);
    vi.mocked(getWahaClient).mockReturnValue(waha as never);
    const { admin, chamadas } = bancoDeMentira();
    const t0 = 1_000_000;

    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
      agora: t0,
    });
    expect(chamadas).toHaveLength(0);

    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
      agora: t0 + 60_000,
    });
    expect(waha.obterNomeDoGrupo).toHaveBeenCalledTimes(1);
  });

  it("erro no update não lança", async () => {
    const waha = clienteWaha("Elok");
    vi.mocked(getWahaClient).mockReturnValue(waha as never);
    const { admin } = bancoDeMentira({ updateFalha: { message: "boom" } });

    await expect(
      atualizarNomeDoGrupo(admin as never, {
        organizationId: ORG,
        contactId: CONTACT,
        sessionName: SESSION_NAME,
        groupChatId: GROUP_CHAT_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("exceção no update não lança", async () => {
    const waha = clienteWaha("Elok");
    vi.mocked(getWahaClient).mockReturnValue(waha as never);
    const { admin } = bancoDeMentira({ updateLanca: true });

    await expect(
      atualizarNomeDoGrupo(admin as never, {
        organizationId: ORG,
        contactId: CONTACT,
        sessionName: SESSION_NAME,
        groupChatId: GROUP_CHAT_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("sem cliente WAHA configurado, não faz nada", async () => {
    vi.mocked(getWahaClient).mockReturnValue(null);
    const { admin, chamadas } = bancoDeMentira();

    await atualizarNomeDoGrupo(admin as never, {
      organizationId: ORG,
      contactId: CONTACT,
      sessionName: SESSION_NAME,
      groupChatId: GROUP_CHAT_ID,
    });

    expect(chamadas).toHaveLength(0);
  });
});
