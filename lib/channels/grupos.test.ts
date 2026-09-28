import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerMostrarGrupos } from "./grupos";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

function database(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  const db = { from: vi.fn().mockReturnValue(query) };
  return { db: db as unknown as SupabaseClient, query };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lerMostrarGrupos: nunca lança", () => {
  it("true quando a coluna vale true", async () => {
    const { db } = database({ mostrar_grupos: true });
    await expect(lerMostrarGrupos(db, "org-a", "canal-a")).resolves.toBe(true);
  });

  it("false quando a coluna vale false", async () => {
    const { db } = database({ mostrar_grupos: false });
    await expect(lerMostrarGrupos(db, "org-a", "canal-a")).resolves.toBe(false);
  });

  it("false quando não há linha (null)", async () => {
    const { db } = database(null);
    await expect(lerMostrarGrupos(db, "org-a", "canal-a")).resolves.toBe(false);
  });

  it("false quando o banco devolve erro — sem lançar", async () => {
    const { db } = database(null, { message: "column mostrar_grupos does not exist" });
    await expect(lerMostrarGrupos(db, "org-a", "canal-a")).resolves.toBe(false);
  });

  it("false quando a chamada lança — sem propagar a exceção", async () => {
    const db = {
      from: vi.fn(() => {
        throw new Error("ECONNRESET");
      }),
    } as unknown as SupabaseClient;
    await expect(lerMostrarGrupos(db, "org-a", "canal-a")).resolves.toBe(false);
  });

  it("filtra por organização e id da conexão", async () => {
    const { db, query } = database({ mostrar_grupos: true });
    await lerMostrarGrupos(db, "org-a", "canal-a");
    expect(query.eq.mock.calls).toEqual([
      ["organization_id", "org-a"],
      ["id", "canal-a"],
    ]);
  });
});
