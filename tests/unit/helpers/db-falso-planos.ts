/**
 * Um cliente Supabase FALSO, o mínimo para exercitar `lib/planos/estado.ts` e
 * `uso.ts` sem banco.
 *
 * Cada tabela responde o que o teste configurou; qualquer encadeamento
 * (`select().eq().is().gte()...`) devolve o próprio construtor, e `await` no fim
 * entrega `{ data, error, count }`. Não interpreta filtro nenhum — quem prova o
 * filtro é `tests/invariants/planos-isolamento.test.ts`, contra Postgres de
 * verdade. Aqui se prova a LÓGICA: o que a camada faz com cada resposta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RespostaFalsa {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
}

export interface ChamadaGravada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

export interface DbFalso {
  db: SupabaseClient;
  /** Tabelas consultadas, na ordem — para provar o que NÃO foi lido. */
  consultas: string[];
  /** Toda chamada de ESCRITA (insert/update/upsert/delete) com os argumentos — para
   *  provar o CONTEÚDO do que foi gravado, que é o que importa. */
  escritas: ChamadaGravada[];
}

export function dbFalso(
  tabelas: Record<string, RespostaFalsa | RespostaFalsa[]>,
  rpcs: Record<string, RespostaFalsa> = {},
): DbFalso {
  const consultas: string[] = [];
  const escritas: ChamadaGravada[] = [];
  const contadores = new Map<string, number>();

  const proxima = (tabela: string): RespostaFalsa => {
    const r = tabelas[tabela];
    if (r === undefined) return { data: null, error: null, count: 0 };
    if (!Array.isArray(r)) return r;
    const i = contadores.get(tabela) ?? 0;
    contadores.set(tabela, i + 1);
    return r[Math.min(i, r.length - 1)]!;
  };

  const construtor = (tabela: string) => {
    const resposta = proxima(tabela);
    const final = { data: resposta.data ?? null, error: resposta.error ?? null, count: resposta.count ?? null };
    const alvo: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(alvo, {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: typeof final) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve(final).then(ok, ko);
        }
        // select/eq/is/gt/gte/in/not/order/limit/maybeSingle/single — tudo encadeia.
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
          return (...args: unknown[]) => {
            escritas.push({ tabela, metodo: prop, args });
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
  };

  const db = {
    from(tabela: string) {
      consultas.push(tabela);
      return construtor(tabela);
    },
    rpc(nome: string) {
      consultas.push(`rpc:${nome}`);
      const r = rpcs[nome] ?? { data: null, error: null };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  } as unknown as SupabaseClient;

  return { db, consultas, escritas };
}
