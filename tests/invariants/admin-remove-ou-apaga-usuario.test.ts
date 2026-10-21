import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0398 — as duas funções com que o super admin tira um usuário de uma
 * empresa (`fn_admin_revogar_vinculo`) ou prepara a exclusão da conta
 * (`fn_admin_preparar_exclusao_de_usuario`).
 *
 * O que se prova, contra o banco que o cliente instala (baseline aplicado):
 *  - EXECUTE só para service_role (nem PUBLIC, nem anon, nem authenticated);
 *  - o último admin ativo de uma empresa NÃO sai — e a contagem e a mudança são atômicas
 *    (duas revogações concorrentes não deixam a empresa sem admin);
 *  - a exclusão recusa platform admin ativo, último admin de qualquer empresa e FK
 *    NOT NULL sem cascade para auth.users (descoberta pelo catálogo — aqui, por uma tabela
 *    do próprio teste, sem depender de `commissions`), e nesse caso NADA muda;
 *  - sem bloqueio, anula as FKs anuláveis e revoga os vínculos ativos.
 */

const run = promisify(execFile);
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db`");
}

const ORG_1 = "eeeeeeee-0000-4000-8000-000000000001";
const ORG_2 = "eeeeeeee-0000-4000-8000-000000000002";
const ORG_3 = "eeeeeeee-0000-4000-8000-000000000003";
const U_ADMIN1 = "eeeeeeee-1111-4000-8000-000000000001"; // admin da ORG_1 e da ORG_2
const U_ADMIN2 = "eeeeeeee-1111-4000-8000-000000000002"; // admin da ORG_1
const U_AGENTE = "eeeeeeee-1111-4000-8000-000000000003"; // agente da ORG_1
const U_SOLO = "eeeeeeee-1111-4000-8000-000000000004"; // único admin da ORG_3
const U_PLAT = "eeeeeeee-1111-4000-8000-000000000005"; // platform admin ativo
const U_OBRIG = "eeeeeeee-1111-4000-8000-000000000006"; // tem registro NOT NULL
const U_ANULA = "eeeeeeee-1111-4000-8000-000000000007"; // tem registro anulável + agente ORG_1
const U_RACE1 = "eeeeeeee-1111-4000-8000-000000000008"; // admin da ORG_2 (par da corrida)
const U_RACE2 = "eeeeeeee-1111-4000-8000-000000000009"; // admin da ORG_2 (par da corrida)

const U_TODOS = [U_ADMIN1, U_ADMIN2, U_AGENTE, U_SOLO, U_PLAT, U_OBRIG, U_ANULA, U_RACE1, U_RACE2];

function json(script: string): Record<string, unknown> {
  const out = sql(script).split("\n");
  return JSON.parse(out[out.length - 1] as string) as Record<string, unknown>;
}

function vinculo(user: string, org: string): { revoked: boolean } {
  const v = sql(
    `select (revoked_at is not null)::text from public.user_organizations where user_id='${user}' and organization_id='${org}'`,
  );
  return { revoked: v === "true" };
}

beforeAll(() => {
  const usuarios = U_TODOS.map(
    (u, i) => `insert into auth.users (id, email) values ('${u}', 'adm-del-${i}@invariant.test') on conflict (id) do nothing;`,
  ).join("\n");
  sql(`
    ${usuarios}
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_1}', 'adm-del-1', 'Adm Del 1', 'Empresa Um'),
      ('${ORG_2}', 'adm-del-2', 'Adm Del 2', 'Empresa Dois'),
      ('${ORG_3}', 'adm-del-3', 'Adm Del 3', 'Empresa Tres')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${U_ADMIN1}', '${ORG_1}', 'admin', now()),
      ('${U_ADMIN1}', '${ORG_2}', 'admin', now()),
      ('${U_ADMIN2}', '${ORG_1}', 'admin', now()),
      ('${U_AGENTE}', '${ORG_1}', 'agent', now()),
      ('${U_SOLO}', '${ORG_3}', 'admin', now()),
      ('${U_PLAT}', '${ORG_3}', 'agent', now()),
      ('${U_OBRIG}', '${ORG_1}', 'agent', now()),
      ('${U_ANULA}', '${ORG_1}', 'agent', now()),
      ('${U_RACE1}', '${ORG_2}', 'admin', now()),
      ('${U_RACE2}', '${ORG_2}', 'admin', now());
    insert into public.platform_admins (user_id, granted_by, reason)
      values ('${U_PLAT}', '${U_ADMIN1}', 'invariante 0398');
    -- Tabela do teste: uma FK NOT NULL e uma anulável, as duas sem cascade para auth.users.
    -- A função as acha pelo catálogo; não há lista de tabelas no corpo dela.
    create table if not exists public.zz_inv_0398_fk (
      id serial primary key,
      obrigatorio uuid not null references auth.users(id),
      anulavel uuid references auth.users(id)
    );
    delete from public.zz_inv_0398_fk;
    -- anulavel ligado ao U_ANULA numa linha cujo obrigatorio é de OUTRO usuário.
    insert into public.zz_inv_0398_fk (obrigatorio, anulavel) values ('${U_ADMIN2}', '${U_ANULA}');
    insert into public.zz_inv_0398_fk (obrigatorio, anulavel) values ('${U_OBRIG}', null);
  `);
});

describe("0398 — superfície de EXECUTE", () => {
  const FNS = [
    "public.fn_admin_revogar_vinculo(uuid,uuid)",
    "public.fn_admin_preparar_exclusao_de_usuario(uuid)",
  ];
  it.each(FNS)("%s: service_role executa; PUBLIC, anon e authenticated não", (fn) => {
    const r = sql(`
      select has_function_privilege('service_role', '${fn}', 'EXECUTE')::text || ',' ||
             has_function_privilege('anon', '${fn}', 'EXECUTE')::text || ',' ||
             has_function_privilege('authenticated', '${fn}', 'EXECUTE')::text || ',' ||
             exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where p.oid = '${fn}'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE')::text;
    `);
    expect(r).toBe("true,false,false,false");
  });
});

describe("0398 — fn_admin_revogar_vinculo", () => {
  it("vínculo inexistente", () => {
    expect(json(`select public.fn_admin_revogar_vinculo('${U_AGENTE}', '${ORG_3}')::text`).codigo).toBe("nao_encontrado");
  });

  it("revoga um não-admin e é idempotente", () => {
    const a = json(`select public.fn_admin_revogar_vinculo('${U_AGENTE}', '${ORG_1}')::text`);
    expect(a.codigo).toBe("revogado");
    expect(vinculo(U_AGENTE, ORG_1).revoked).toBe(true);
    const b = json(`select public.fn_admin_revogar_vinculo('${U_AGENTE}', '${ORG_1}')::text`);
    expect(b.codigo).toBe("ja_revogado");
  });

  it("recusa o único admin ativo e não muda nada", () => {
    const r = json(`select public.fn_admin_revogar_vinculo('${U_SOLO}', '${ORG_3}')::text`);
    expect(r).toMatchObject({ ok: false, codigo: "ultimo_admin" });
    expect(vinculo(U_SOLO, ORG_3).revoked).toBe(false);
  });

  it("revoga um admin quando há outro ativo; depois o que sobrou é o último", () => {
    expect(json(`select public.fn_admin_revogar_vinculo('${U_ADMIN2}', '${ORG_1}')::text`).codigo).toBe("revogado");
    // U_ADMIN1 é agora o único admin ativo da ORG_1.
    expect(json(`select public.fn_admin_revogar_vinculo('${U_ADMIN1}', '${ORG_1}')::text`).codigo).toBe("ultimo_admin");
  });

  it("duas revogações CONCORRENTES não deixam a empresa sem admin", async () => {
    // Sessão 1 revoga RACE1 e segura a transação aberta por 2s; a sessão 2 chega no meio.
    const psql = (script: string) =>
      run("docker", ["exec", "-i", container as string, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", script]);
    const s1 = psql(
      `begin; select public.fn_admin_revogar_vinculo('${U_RACE1}', '${ORG_2}')::text; select pg_sleep(2); commit;`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const s2 = psql(`select public.fn_admin_revogar_vinculo('${U_RACE2}', '${ORG_2}')::text`);
    const [o1, o2] = await Promise.all([s1, s2]);
    const saida = o1.stdout + o2.stdout;
    expect(saida.match(/"codigo": "revogado"/g)).toHaveLength(1);
    expect(saida.match(/"codigo": "ultimo_admin"/g)).toHaveLength(1);
    const ativos = sql(
      `select count(*) from public.user_organizations where organization_id='${ORG_2}' and role='admin' and revoked_at is null and user_id in ('${U_RACE1}','${U_RACE2}')`,
    );
    expect(ativos).toBe("1");
  });
});

describe("0398 — fn_admin_preparar_exclusao_de_usuario", () => {
  const preparar = (u: string) => json(`select public.fn_admin_preparar_exclusao_de_usuario('${u}')::text`);

  it("usuário inexistente", () => {
    expect(preparar("eeeeeeee-9999-4000-8000-000000000000").codigo).toBe("nao_encontrado");
  });

  it("recusa platform admin ativo", () => {
    expect(preparar(U_PLAT).codigo).toBe("platform_admin");
    expect(vinculo(U_PLAT, ORG_3).revoked).toBe(false);
  });

  it("recusa o único admin de uma empresa, lista nome e id, e não muda nada", () => {
    const r = preparar(U_SOLO) as { codigo: string; bloqueios: { ultimos_admins: Array<{ organization_id: string; nome: string }> } };
    expect(r.codigo).toBe("bloqueado");
    expect(r.bloqueios.ultimos_admins).toEqual([{ organization_id: ORG_3, nome: "Empresa Tres" }]);
    expect(vinculo(U_SOLO, ORG_3).revoked).toBe(false);
  });

  it("lista TODAS as empresas sem outro admin (U_ADMIN1 é o último da ORG_1; a ORG_2 tem outros)", () => {
    const r = preparar(U_ADMIN1) as { bloqueios: { ultimos_admins: Array<{ organization_id: string }> } };
    expect(r.bloqueios.ultimos_admins.map((o) => o.organization_id)).toEqual([ORG_1]);
  });

  it("recusa FK NOT NULL sem cascade (achada pelo catálogo) e NADA muda", () => {
    const r = preparar(U_OBRIG) as {
      codigo: string;
      bloqueios: { registros_obrigatorios: Array<{ tabela: string; coluna: string; quantidade: number }> };
    };
    expect(r.codigo).toBe("bloqueado");
    expect(r.bloqueios.registros_obrigatorios).toEqual([
      { tabela: "zz_inv_0398_fk", coluna: "obrigatorio", quantidade: 1 },
    ]);
    expect(vinculo(U_OBRIG, ORG_1).revoked).toBe(false);
  });

  it("sem bloqueio: anula a FK anulável e revoga os vínculos ativos", () => {
    const r = preparar(U_ANULA) as {
      ok: boolean;
      organizacoes_revogadas: string[];
      anuladas: Array<{ tabela: string; coluna: string; quantidade: number }>;
    };
    expect(r.ok).toBe(true);
    expect(r.organizacoes_revogadas).toEqual([ORG_1]);
    expect(r.anuladas).toEqual([{ tabela: "zz_inv_0398_fk", coluna: "anulavel", quantidade: 1 }]);
    expect(vinculo(U_ANULA, ORG_1).revoked).toBe(true);
    expect(sql(`select count(*) from public.zz_inv_0398_fk where anulavel = '${U_ANULA}'`)).toBe("0");
    // A linha em si continua: só a referência foi anulada.
    expect(sql(`select count(*) from public.zz_inv_0398_fk where obrigatorio = '${U_ADMIN2}'`)).toBe("1");
  });

  it("depois do preparo o delete do auth.users passa (a FK anulada não bloqueia mais)", () => {
    sql(`delete from auth.users where id = '${U_ANULA}'`);
    expect(sql(`select count(*) from auth.users where id = '${U_ANULA}'`)).toBe("0");
  });
});
