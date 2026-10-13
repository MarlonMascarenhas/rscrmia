import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { MENSAGENS_POR_CONVERSA } from "@/lib/retencao/politica";

/** Conversa com `total` mensagens; i=0 é a mais antiga. Entende só o que o handler emite. */
function fake(total: number): SupabaseClient {
  const todas = Array.from({ length: total }, (_, i) => ({
    id: `m-${String(i).padStart(4, "0")}`,
    sent_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  })).reverse(); // mais nova primeiro
  return {
    from() {
      const ors: string[] = [];
      let lim = Infinity;
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        or: (raw: string) => {
          ors.push(raw);
          return b;
        },
        limit: (n: number) => {
          lim = n;
          return b;
        },
        then(res: (v: unknown) => unknown) {
          let rows = todas;
          for (const raw of ors) {
            const gt = /sent_at\.gt\.([^,]+),and\(sent_at\.eq\.[^,]+,id\.gte\.([^)]+)\)/.exec(raw);
            const lt = /sent_at\.lt\.([^,]+),and\(sent_at\.eq\.[^,]+,id\.lt\.([^)]+)\)/.exec(raw);
            if (gt) rows = rows.filter((r) => r.sent_at > gt[1]! || (r.sent_at === gt[1] && r.id >= gt[2]!));
            if (lt) rows = rows.filter((r) => r.sent_at < lt[1]! || (r.sent_at === lt[1] && r.id < lt[2]!));
          }
          return Promise.resolve({ data: rows.slice(0, lim), error: null }).then(res);
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const ctx = { organization_id: "org", requestId: "r" } as unknown as HandlerCtx;

describe("listMessagesHandler — janela das mais recentes", () => {
  it("nunca devolve a 101ª, nem pelo cursor, e fecha com has_more=false", async () => {
    const sb = fake(MENSAGENS_POR_CONVERSA + 20);
    const ids: string[] = [];
    let cursor: string | undefined;
    let ultimaHasMore = true;
    for (let i = 0; i < 10 && ultimaHasMore; i += 1) {
      const r = await listMessagesHandler(sb, ctx, "c", { limit: 50, cursor } as never);
      ids.push(...r.messages.map((m) => m.id));
      ultimaHasMore = r.has_more;
      cursor = r.cursor ?? undefined;
    }
    expect(ids).toHaveLength(MENSAGENS_POR_CONVERSA);
    expect(ids).not.toContain("m-0019"); // a 101ª mais recente
    expect(ids).toContain("m-0020"); // a 100ª
    expect(ultimaHasMore).toBe(false);
  });

  it("conversa curta não é afetada", async () => {
    const r = await listMessagesHandler(fake(30), ctx, "c", { limit: 50 } as never);
    expect(r.messages).toHaveLength(30);
    expect(r.has_more).toBe(false);
  });
});
