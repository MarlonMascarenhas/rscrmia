import { beforeEach, describe, expect, it, vi } from "vitest";

// Mesma cadeia cortada dos demais testes de ingest.ts (@/lib/audit → supabase/server).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// Os dois efeitos de negócio do 1:1 que GRUPO nunca pode disparar.
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn() }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn() }));
// A chave `channel_sessions.mostrar_grupos`, controlada por teste.
vi.mock("@/lib/channels/grupos", () => ({ lerMostrarGrupos: vi.fn() }));
// Nome real do grupo (busca no WAHA) — mockado por inteiro: este arquivo só
// prova QUE é chamado com os dados certos, não o que ele faz por dentro.
vi.mock("@/lib/waha/nome-do-grupo", () => ({ atualizarNomeDoGrupo: vi.fn() }));

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { lerMostrarGrupos } from "@/lib/channels/grupos";
import { atualizarNomeDoGrupo } from "@/lib/waha/nome-do-grupo";

/**
 * MENSAGEM DE GRUPO: com `mostrar_grupos` desligado (padrão), o comportamento
 * é o de hoje — descarta, sem contato, sem conversa. Ligado, grava na conversa
 * do grupo com o autor em `metadata.autor`, mas NUNCA passa por binding de
 * lead, opt-out, despacho de IA nem pausa de IA por humano — os dois mocks
 * acima são a prova disso: se algum dia grupo chamar qualquer um dos dois,
 * este arquivo fica vermelho.
 */

interface LinhaMessage {
  id: string;
  organization_id: string;
  external_id: string | null;
  direction?: string;
  body?: string | null;
  metadata?: unknown;
  [k: string]: unknown;
}

interface Duplo {
  admin: unknown;
  messages: LinhaMessage[];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

function bancoDeMentira(preexistentes: Array<Partial<LinhaMessage>> = []): Duplo {
  const messages: LinhaMessage[] = preexistentes.map((m, i) => ({
    id: `pre-${i + 1}`,
    organization_id: "org-1",
    external_id: null,
    ...m,
  }));
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const consultaMessages = () => {
    let org: string | null = null;
    let externos: string[] = [];
    const q = {
      eq(coluna: string, valor: string) {
        if (coluna === "organization_id") org = valor;
        return q;
      },
      in(coluna: string, valores: string[]) {
        if (coluna === "external_id") externos = valores;
        return q;
      },
      limit() {
        return q;
      },
      async maybeSingle() {
        const achou = messages.find(
          (m) => m.organization_id === org && m.external_id !== null && externos.includes(m.external_id),
        );
        return { data: achou ? { id: achou.id } : null, error: null };
      },
    };
    return q;
  };

  const admin = {
    from: (nome: string) => ({
      select: () => consultaMessages(),
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          async maybeSingle() {
            if (nome !== "messages") return { data: { id: "x" }, error: null };
            const externo = linha.external_id as string | null;
            const colide =
              externo !== null &&
              messages.some((m) => m.organization_id === linha.organization_id && m.external_id === externo);
            if (colide) {
              return {
                data: null,
                error: { code: "23505", message: 'duplicate key value violates "messages_org_external_id_unique"' },
              };
            }
            const nova = { id: `msg-${messages.length + 1}`, ...linha } as LinhaMessage;
            messages.push(nova);
            return { data: { id: nova.id }, error: null };
          },
        }),
      }),
      update: () => {
        const encadeavel: { error: null; eq: () => typeof encadeavel; in: () => typeof encadeavel } = {
          error: null,
          eq: () => encadeavel,
          in: () => encadeavel,
        };
        return encadeavel;
      },
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_grupo") {
        return { data: { contact_id: "contato-grupo-1", conversation_id: "conversa-grupo-1" }, error: null };
      }
      return { data: null, error: null };
    },
  };

  return { admin, messages, rpcs };
}

const SESSION = { id: "sessao-1", organization_id: "org-1", waha_session_name: "sessao-waha-1" };

function envelope(event: string, payload: WahaPayload): WahaEnvelope {
  return { event, session: "default", payload };
}

const INBOUND_GRUPO: WahaPayload = {
  id: "false_120363000000000000@g.us_3EB0ABCDEF_5511999999999@s.whatsapp.net",
  from: "120363000000000000@g.us",
  fromMe: false,
  body: "oi grupo",
  participant: "5511999999999@s.whatsapp.net",
  _data: {
    notifyName: "Fulano do Grupo",
    key: { participantAlt: "5511988888888@s.whatsapp.net" },
  },
} as WahaPayload;

const OUTBOUND_GRUPO: WahaPayload = {
  // Sem `to`/`from` de grupo — força o fallback pelo id de 4 segmentos
  // (`{fromMe}_{chatId}_{msgId}_{participant}`, formato documentado do WAHA).
  id: "true_120363000000000000@g.us_3EB0ABCDEF_5511999999999@s.whatsapp.net",
  fromMe: true,
  body: "resposta no grupo pelo celular",
};

beforeEach(() => {
  vi.mocked(lerMostrarGrupos).mockReset();
  vi.mocked(aplicarEfeitosPosEntrada).mockClear();
  vi.mocked(pausarIaPorAtendimentoManual).mockClear();
  vi.mocked(atualizarNomeDoGrupo).mockReset().mockResolvedValue(undefined);
});

describe("mostrar_grupos desligado (padrão) — comportamento de hoje: descarta", () => {
  it("inbound de grupo não grava nem chama RPC de grupo", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(false);
    const { admin, messages, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", INBOUND_GRUPO), "req-1");

    expect(messages).toHaveLength(0);
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_grupo")).toBe(false);
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_contact")).toBe(false);
  });

  it("outbound de grupo (celular) não grava nem chama RPC de grupo", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(false);
    const { admin, messages, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", OUTBOUND_GRUPO), "req-1");

    expect(messages).toHaveLength(0);
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_grupo")).toBe(false);
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_contact")).toBe(false);
  });
});

describe("mostrar_grupos ligado — inbound", () => {
  it("chama a RPC com p_reabrir:true e grava metadata.autor a partir de participantAlt", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(true);
    const { admin, messages, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", INBOUND_GRUPO), "req-1");

    const chamada = rpcs.find((c) => c.fn === "fn_upsert_wa_grupo");
    expect(chamada, "não chamou fn_upsert_wa_grupo").toBeDefined();
    expect(chamada!.args.p_reabrir).toBe(true);
    expect(chamada!.args.p_group_chat_id).toBe("120363000000000000@g.us");

    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe("inbound");
    expect(messages[0]!.contact_id).toBe("contato-grupo-1");
    expect(messages[0]!.conversation_id).toBe("conversa-grupo-1");
    const autor = (messages[0]!.metadata as { autor: { telefone: string | null } }).autor;
    expect(autor.telefone).toBe("+5511988888888");
  });

  it("NÃO chama aplicarEfeitosPosEntrada", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(true);
    const { admin } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", INBOUND_GRUPO), "req-1");

    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("chama atualizarNomeDoGrupo com o contact_id que a RPC devolveu", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(true);
    const { admin } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", INBOUND_GRUPO), "req-1");

    expect(atualizarNomeDoGrupo).toHaveBeenCalledWith(admin, {
      organizationId: "org-1",
      contactId: "contato-grupo-1",
      sessionName: "sessao-waha-1",
      groupChatId: "120363000000000000@g.us",
    });
  });

  it("se atualizarNomeDoGrupo rejeitar, a mensagem ainda é gravada", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(true);
    vi.mocked(atualizarNomeDoGrupo).mockRejectedValue(new Error("waha fora do ar"));
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", INBOUND_GRUPO), "req-1");

    expect(messages).toHaveLength(1);
  });
});

describe("mostrar_grupos ligado — outbound (fromMe pelo celular)", () => {
  it("id de 4 segmentos: grava direction outbound e NÃO chama pausarIaPorAtendimentoManual", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(true);
    const { admin, messages, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", OUTBOUND_GRUPO), "req-1");

    const chamada = rpcs.find((c) => c.fn === "fn_upsert_wa_grupo");
    expect(chamada, "não chamou fn_upsert_wa_grupo").toBeDefined();
    expect(chamada!.args.p_reabrir).toBe(false);
    expect(chamada!.args.p_group_chat_id).toBe("120363000000000000@g.us");

    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe("outbound");
    expect(messages[0]!.external_id).toBe(OUTBOUND_GRUPO.id);

    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("mensagem já registrada com external_id = segmento 3 (id cru) não insere de novo", async () => {
    vi.mocked(lerMostrarGrupos).mockResolvedValue(true);
    const { admin, messages, rpcs } = bancoDeMentira([
      { organization_id: "org-1", external_id: "3EB0ABCDEF", direction: "outbound", body: "já tinha entrado" },
    ]);

    await dispatchWahaEvent(admin as never, SESSION as never, envelope("message.any", OUTBOUND_GRUPO), "req-1");

    expect(messages, "dedup não reconheceu o id cru do webhook de grupo").toHaveLength(1);
    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_grupo"), "não devia ter chegado a chamar a RPC").toBe(false);
  });
});

describe("handleAck com id de 4 segmentos (grupo)", () => {
  it("inclui o segmento 3 (id cru) entre os candidatos consultados", async () => {
    const { admin } = bancoDeMentira();
    let candidatosConsultados: string[] = [];
    const adminComEspiao = {
      ...(admin as { from: (n: string) => unknown; rpc: unknown }),
      from: (nome: string) => {
        if (nome !== "messages") return (admin as { from: (n: string) => unknown }).from(nome);
        return {
          update: () => {
            const encadeavel = {
              error: null,
              eq: () => encadeavel,
              in: (coluna: string, valores: string[]) => {
                if (coluna === "external_id") candidatosConsultados = valores;
                return encadeavel;
              },
            };
            return encadeavel;
          },
        };
      },
    };

    await dispatchWahaEvent(
      adminComEspiao as never,
      SESSION as never,
      envelope("message.ack", { id: OUTBOUND_GRUPO.id, ack: 2 }),
      "req-1",
    );

    expect(candidatosConsultados).toContain("3EB0ABCDEF");
  });
});
