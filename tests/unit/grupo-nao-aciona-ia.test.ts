/**
 * Conversa de GRUPO (`conversations.is_group = true`) NÃO aciona a IA: nem a
 * resposta automática (`workers/ai-response-worker.ts`, o caminho pré-engine),
 * nem a classificação de sentimento (`workers/ai-sentiment-worker.ts`) — as
 * duas gastam chamada paga de LLM por mensagem. Push e automações CONTINUAM
 * valendo para grupo (decisão do dono do produto); esta trava é só nestes
 * dois caminhos.
 *
 * Prova, contra os workers REAIS (admin client mockado, sem rede):
 *  - conversa de grupo → skip `group_conversation` nos dois, ANTES de
 *    qualquer consulta que levaria a uma chamada de LLM;
 *  - conversa 1:1 → nenhum dos dois pula por esse motivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "anthropic/claude-sonnet-4-6",
  DEFAULT_CLASSIFIER_MODEL: "anthropic/claude-haiku-4-5",
  gatewayConfig: () => null,
  gatewayHeaders: () => ({}),
  isAiGatewayConfigured: () => true,
  isEmbeddingProviderConfigured: () => false,
}));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));
vi.mock("ai", () => ({ generateText: vi.fn(), generateObject: vi.fn() }));

import { generateObject } from "ai";

import { processMessageReceived } from "@/workers/ai-response-worker";
import { processSentiment } from "@/workers/ai-sentiment-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: "modelo-dublê",
    modelId: "anthropic/claude-haiku-4-5",
  } as unknown as Awaited<ReturnType<typeof resolverModeloDoPonto>>);
  vi.mocked(generateObject).mockResolvedValue({
    object: { sentiment_score: 0.5, reasoning_short: "neutro" },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

// ---------------------------------------------------------------------------
// ai-response-worker (legado)
// ---------------------------------------------------------------------------

function makeResponseWorkerAdminStub(opts: { isGroup: boolean }, queried: string[]) {
  const convRow = {
    id: CONV_ID,
    organization_id: ORG_ID,
    contact_id: CONTACT_ID,
    channel_session_id: "77777777-7777-4777-8777-777777777777",
    last_inbound_at: new Date().toISOString(),
    bot_silenced_until: null,
    last_handoff_at: null,
    assignee_kind: "ai",
    is_group: opts.isGroup,
    contacts: {
      id: CONTACT_ID,
      display_name: null,
      locale: "pt-BR",
      is_blocked: false,
      force_human: false,
      ai_authorized_at: null,
    },
    channel_sessions: { metadata: {} },
  };

  const from = (table: string) => {
    queried.push(table);
    const result =
      table === "conversations"
        ? convRow
        : table === "messages"
          ? { id: MSG_ID, body: "oi", direction: "inbound", organization_id: ORG_ID }
          : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
      then: (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: result ? [result] : [], error: null }).then(r),
    };
    return chain;
  };
  return { from } as never;
}

const responseWorkerEvent = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

describe("ai-response-worker (legado) · conversa de grupo não aciona a IA", () => {
  it("conversa de grupo → skip 'group_conversation', sem consultar mensagem nenhuma", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeResponseWorkerAdminStub({ isGroup: true }, queried),
    );
    const result = await processMessageReceived(responseWorkerEvent);
    expect(result).toMatchObject({ status: "skipped", reason: "group_conversation" });
    // A trava corta ANTES da leitura de mensagem/elegibilidade/agente — só a
    // conversa foi consultada.
    expect(queried).not.toContain("messages");
    expect(queried).not.toContain("ai_agents");
  });

  it("conversa 1:1 (is_group=false) → não pula por 'group_conversation'", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeResponseWorkerAdminStub({ isGroup: false }, queried),
    );
    const result = await processMessageReceived(responseWorkerEvent);
    expect(result.reason).not.toBe("group_conversation");
    // Passou da trava e seguiu no pipeline (chegou a consultar mensagem).
    expect(queried).toContain("messages");
  });
});

// ---------------------------------------------------------------------------
// ai-sentiment-worker
// ---------------------------------------------------------------------------

type Linha = Record<string, unknown>;

/** Mini-Postgres de brinquedo: filtra por `eq` sobre as linhas da tabela. */
function makeSentimentWorkerAdminStub(banco: Record<string, Linha[]>) {
  const from = (tabela: string) => {
    const filtros: Array<[string, unknown]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_alvo, prop: string) => {
          if (prop === "eq") {
            return (col: string, val: unknown) => {
              filtros.push([col, val]);
              return chain;
            };
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => {
              let linhas = [...(banco[tabela] ?? [])];
              for (const [col, val] of filtros) linhas = linhas.filter((l) => l[col] === val);
              return Promise.resolve({ data: linhas[0] ?? null, error: null });
            };
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) => {
              let linhas = [...(banco[tabela] ?? [])];
              for (const [col, val] of filtros) linhas = linhas.filter((l) => l[col] === val);
              return Promise.resolve({ data: linhas, error: null }).then(ok);
            };
          }
          return (..._args: unknown[]) => chain;
        },
      },
    );
    return chain;
  };
  return {
    from,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as never;
}

function makeSentimentEvent(): EventRow {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    organization_id: ORG_ID,
    entity_id: MSG_ID,
    payload: { message_id: MSG_ID, conversation_id: CONV_ID },
  } as unknown as EventRow;
}

describe("ai-sentiment-worker · conversa de grupo não aciona a IA", () => {
  it("conversa de grupo → skip 'group_conversation', sem chamar o classificador", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSentimentWorkerAdminStub({
        messages: [
          {
            id: MSG_ID,
            organization_id: ORG_ID,
            conversation_id: CONV_ID,
            body: "oi, bom dia grupo",
            direction: "inbound",
            metadata: {},
          },
        ],
        conversations: [{ id: CONV_ID, organization_id: ORG_ID, is_group: true }],
      }) as unknown as ReturnType<typeof createAdminClient>,
    );

    const result = await processSentiment(makeSentimentEvent());
    expect(result).toMatchObject({ skipped: true, reason: "group_conversation" });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("conversa 1:1 (is_group=false) → não pula por 'group_conversation'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSentimentWorkerAdminStub({
        messages: [
          {
            id: MSG_ID,
            organization_id: ORG_ID,
            conversation_id: CONV_ID,
            body: "oi, minha entrega não chegou",
            direction: "inbound",
            metadata: {},
          },
        ],
        conversations: [{ id: CONV_ID, organization_id: ORG_ID, is_group: false }],
        ai_agents: [],
        ai_agent_versions: [],
      }) as unknown as ReturnType<typeof createAdminClient>,
    );

    const result = await processSentiment(makeSentimentEvent());
    expect(result.reason).not.toBe("group_conversation");
    expect(result.skipped).toBe(false);
    expect(generateObject).toHaveBeenCalled();
  });
});
