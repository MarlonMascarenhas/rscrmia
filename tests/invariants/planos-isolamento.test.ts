import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Planos e assinaturas (migration 0393) — a prova que importa: uma organização
 * NUNCA vê nem escreve a assinatura de outra, e o catálogo da instalação é
 * inalcançável por `anon` e `authenticated`.
 *
 * Roda no Postgres efêmero de `scripts/test-db.sh` (baseline.sql já aplicado),
 * com o JWT simulado por `set_config('request.jwt.claims', ...)` — o mesmo
 * caminho `auth.uid()` / `fn_user_org_ids()` que as policies de produção usam.
 *
 * ⚠️ O prelude de `scripts/test-db.sh` reproduz o default ACL de TABELAS do
 * Supabase (issue #887). Isso importa aqui: o `ALTER DEFAULT PRIVILEGES` dá
 * `GRANT ALL` a `anon` em toda tabela nova, então "a tabela não tem policy" não
 * prova nada — o que protege é o `revoke` explícito da 0393, e só um banco que
 * reproduz o default consegue reprovar a sua ausência. As sondas de grant abaixo
 * medem o universo certo por isso.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function rodar(script: string, exitOnError = true): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres",
      "-v", `ON_ERROR_STOP=${exitOnError ? 1 : 0}`, "-tA", "-f", "-",
    ],
    { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

/** Devolve a mensagem de erro do psql, ou `null` se o script passou. */
function erroDe(script: string): string | null {
  try {
    rodar(script);
    return null;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? err.message ?? e);
  }
}

/** Última linha da saída, como número. */
function contarComo(papel: "authenticated" | "anon", userId: string | null, consulta: string): number {
  const claims = userId ? `select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);` : "";
  const out = rodar(`set role ${papel}; ${claims} ${consulta}`).split("\n");
  const ultima = out[out.length - 1];
  if (ultima === undefined || !/^\d+$/.test(ultima)) throw new Error(`saída inesperada: ${out.join("|")}`);
  return Number(ultima);
}

const ORG_A = "cccccccc-0000-4000-8000-000000000001";
const ORG_B = "dddddddd-0000-4000-8000-000000000002";
const USER_A = "cccccccc-1111-4000-8000-000000000001";
const USER_B = "dddddddd-1111-4000-8000-000000000002";
const PLANO = "eeeeeeee-0000-4000-8000-000000000001";

const TABELAS_DO_CATALOGO = ["planos", "plano_capacidades", "plano_limites", "plano_precos"] as const;

/** Os knobs como o baseline os deixa — capturado ANTES de qualquer teste mexer neles. */
let knobsDeFabrica = "";

beforeAll(() => {
  knobsDeFabrica = rodar(
    `select chave || '=' || valor from public.platform_config
      where chave in ('COBRANCA_LIGADA', 'LIMITES_MODO', 'DIAS_DE_TESTE', 'CARENCIA_DIAS') order by 1;`,
  );
  rodar(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'plano-a@invariant.test'), ('${USER_B}', 'plano-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'plano-inv-a', 'Plano Inv A', 'Plano A'),
      ('${ORG_B}', 'plano-inv-b', 'Plano Inv B', 'Plano B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'admin', now()), ('${USER_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;
    insert into public.planos (id, codigo, nome) values ('${PLANO}', 'inv_plano', 'Plano de invariante')
      on conflict (id) do nothing;
    insert into public.assinaturas (organization_id, plano_id, situacao, liberado_ate, motivo) values
      ('${ORG_A}', '${PLANO}', 'ativa', now() + interval '30 days', 'invariante A'),
      ('${ORG_B}', '${PLANO}', 'ativa', now() + interval '30 days', 'invariante B')
      on conflict (organization_id) do nothing;
  `);
});

afterAll(() => {
  // Devolve a chave ao estado de fábrica: o gatilho lê dela, e um teste que a
  // deixasse ligada mudaria o resultado de todo INSERT em `organizations` que
  // rodar depois na mesma suíte.
  rodar(`update public.platform_config set valor = 'desligado' where chave = 'COBRANCA_LIGADA';`);
});

describe("assinaturas — uma organização nunca vê nem escreve a de outra", () => {
  it("o membro da A vê a assinatura da A", () => {
    expect(contarComo("authenticated", USER_A, `select count(*) from public.assinaturas where organization_id = '${ORG_A}';`)).toBe(1);
  });

  it("o membro da A vê ZERO assinaturas da B", () => {
    expect(contarComo("authenticated", USER_A, `select count(*) from public.assinaturas where organization_id = '${ORG_B}';`)).toBe(0);
  });

  it("e o total que a A enxerga é exatamente 1 — não há vazamento por outro caminho", () => {
    // `where` por organização não prova nada se a policy vazar: a contagem SEM
    // filtro é a que mede o universo que a RLS entrega.
    expect(contarComo("authenticated", USER_A, `select count(*) from public.assinaturas;`)).toBe(1);
  });

  it("usuário sem sessão (anon) não lê assinatura nenhuma", () => {
    const erro = erroDe(`set role anon; select count(*) from public.assinaturas;`);
    expect(erro, "anon leu assinaturas: o revoke da 0393 não valeu").toMatch(/permission denied/i);
  });

  it("authenticated NÃO escreve a própria assinatura — senão se liberaria de graça", () => {
    const erro = erroDe(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
      update public.assinaturas set liberado_ate = now() + interval '100 years'
        where organization_id = '${ORG_A}';
    `);
    expect(erro, "a organização conseguiu estender o próprio acesso pelo PostgREST").toMatch(/permission denied/i);
  });

  it("authenticated NÃO cria assinatura, nem para a própria organização", () => {
    const erro = erroDe(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
      insert into public.assinaturas (organization_id, situacao) values ('${ORG_A}', 'cortesia')
        on conflict (organization_id) do nothing;
    `);
    expect(erro).toMatch(/permission denied/i);
  });

  it("a assinatura da B continua intacta depois das tentativas da A", () => {
    const dias = rodar(`select round(extract(epoch from (liberado_ate - now())) / 86400) from public.assinaturas where organization_id = '${ORG_B}';`);
    expect(Number(dias)).toBeGreaterThanOrEqual(29);
  });
});

describe("o catálogo da instalação é inalcançável por anon e authenticated", () => {
  // O universo certo: sob o default ACL do Supabase, o que protege é o `revoke`
  // explícito. Esta é a sonda de `tests/invariants/retencao-poda-e-expurgo`, no
  // formato que CLAUDE.md recomenda para conferir grant na fonte.
  it.each(TABELAS_DO_CATALOGO)("%s: nenhum privilégio para anon/authenticated/PUBLIC", (tabela) => {
    const linhas = rodar(`
      select grantee || ':' || privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = '${tabela}'
         and grantee in ('anon', 'authenticated', 'PUBLIC');
    `);
    expect(linhas, `${tabela} concede privilégio a papel do PostgREST`).toBe("");
  });

  it.each(TABELAS_DO_CATALOGO)("%s: authenticated não consegue nem ler", (tabela) => {
    const erro = erroDe(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
      select count(*) from public.${tabela};
    `);
    expect(erro).toMatch(/permission denied/i);
  });

  it.each(TABELAS_DO_CATALOGO)("%s: anon não consegue nem ler", (tabela) => {
    expect(erroDe(`set role anon; select count(*) from public.${tabela};`)).toMatch(/permission denied/i);
  });

  it("assinaturas: authenticated tem SÓ select, e anon não tem nada", () => {
    const linhas = rodar(`
      select grantee || ':' || privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'assinaturas'
         and grantee in ('anon', 'authenticated', 'PUBLIC')
       order by 1;
    `);
    expect(linhas).toBe("authenticated:SELECT");
  });

  it("as funções security definer da 0393 não são executáveis por anon nem PUBLIC", () => {
    // As DUAS origens de EXECUTE (CLAUDE.md, migrations item 9): o grant direto
    // a anon do ALTER DEFAULT PRIVILEGES e o grant a PUBLIC que o Postgres dá.
    const linhas = rodar(`
      select p.proname || ':' || r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (select rolname from pg_roles where rolname in ('anon')) r
       where n.nspname = 'public'
         and p.proname in ('fn_definir_teste_da_organizacao', 'fn_sincronizar_acesso_da_organizacao')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
    `);
    expect(linhas, "função exposta a anon").toBe("");
    const publico = rodar(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('fn_definir_teste_da_organizacao', 'fn_sincronizar_acesso_da_organizacao')
         and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE');
    `);
    expect(publico, "função com EXECUTE para PUBLIC").toBe("");
  });
});

describe("o teste grátis nasce por gatilho — e só com a cobrança ligada", () => {
  const nova = (id: string, slug: string, extra = "") =>
    `insert into public.organizations (id, slug, legal_name, display_name ${extra ? ", acesso_liberado_ate" : ""})
       values ('${id}', '${slug}', '${slug}', '${slug}' ${extra ? `, ${extra}` : ""}) on conflict (id) do nothing;`;
  const prazoDe = (id: string) =>
    rodar(`select coalesce(round(extract(epoch from (acesso_liberado_ate - now())) / 86400)::text, 'null') from public.organizations where id = '${id}';`);

  it("COBRANÇA DESLIGADA: a organização nasce SEM PRAZO (null), e não com 14 dias", () => {
    // O defeito que esta guarda fecha: sem ela, quem cria organizações antes de
    // ligar a cobrança teria todas trancadas no dia em que ligasse.
    rodar(`update public.platform_config set valor = 'desligado' where chave = 'COBRANCA_LIGADA';`);
    const id = "ffffffff-0000-4000-8000-000000000001";
    rodar(nova(id, "plano-inv-desligada"));
    expect(prazoDe(id)).toBe("null");
  });

  it("COBRANÇA LIGADA: a organização nasce com o teste de DIAS_DE_TESTE", () => {
    rodar(`
      update public.platform_config set valor = 'ligado' where chave = 'COBRANCA_LIGADA';
      update public.platform_config set valor = '7' where chave = 'DIAS_DE_TESTE';
    `);
    const id = "ffffffff-0000-4000-8000-000000000002";
    rodar(nova(id, "plano-inv-ligada"));
    expect(Number(prazoDe(id))).toBe(7);
  });

  it("uma data passada explicitamente MANDA, mesmo com a cobrança ligada", () => {
    rodar(`update public.platform_config set valor = 'ligado' where chave = 'COBRANCA_LIGADA';`);
    const id = "ffffffff-0000-4000-8000-000000000003";
    rodar(nova(id, "plano-inv-explicita", "now() + interval '90 days'"));
    expect(Number(prazoDe(id))).toBe(90);
  });

  it("DIAS_DE_TESTE ilegível cai em 14 — não derruba a criação da conta", () => {
    rodar(`
      update public.platform_config set valor = 'ligado' where chave = 'COBRANCA_LIGADA';
      update public.platform_config set valor = 'quatorze' where chave = 'DIAS_DE_TESTE';
    `);
    const id = "ffffffff-0000-4000-8000-000000000004";
    rodar(nova(id, "plano-inv-ilegivel"));
    expect(Number(prazoDe(id))).toBe(14);
    rodar(`update public.platform_config set valor = '14' where chave = 'DIAS_DE_TESTE';`);
  });
});

describe("a assinatura sincroniza a organização na mesma transação", () => {
  const prazoDaOrg = (id: string) =>
    rodar(`select coalesce(round(extract(epoch from (acesso_liberado_ate - now())) / 86400)::text, 'null') from public.organizations where id = '${id}';`);

  it("gravar `liberado_ate` na assinatura muda `organizations.acesso_liberado_ate`", () => {
    rodar(`update public.assinaturas set liberado_ate = now() + interval '45 days' where organization_id = '${ORG_A}';`);
    expect(Number(prazoDaOrg(ORG_A))).toBe(45);
  });

  it("`liberado_ate` NULL propaga como SEM PRAZO — é como se marca 'não vence nunca'", () => {
    rodar(`update public.assinaturas set liberado_ate = null where organization_id = '${ORG_A}';`);
    expect(prazoDaOrg(ORG_A)).toBe("null");
  });

  it("não escreve a organização quando nada mudou (updated_at não mente)", () => {
    rodar(`update public.assinaturas set liberado_ate = now() + interval '10 days' where organization_id = '${ORG_A}';`);
    const antes = rodar(`select updated_at from public.organizations where id = '${ORG_A}';`);
    rodar(`update public.assinaturas set motivo = 'só o motivo mudou' where organization_id = '${ORG_A}';`);
    expect(rodar(`select updated_at from public.organizations where id = '${ORG_A}';`)).toBe(antes);
  });
});

describe("as constraints que impedem o catálogo de mentir", () => {
  it("não se PUBLICA preço sem o objeto de cobrança no provedor", () => {
    const erro = erroDe(`
      insert into public.plano_precos (plano_id, intervalo, valor_cents, publicado_em)
        values ('${PLANO}', 'mensal', 19700, now());
    `);
    expect(erro, "publicou um preço que o checkout não consegue cobrar").toMatch(/plano_precos_publicado_tem_provedor/);
  });

  it("limite ZERO é recusado — zero é 'não pode nada', não 'sem limite'", () => {
    const erro = erroDe(`insert into public.plano_limites (plano_id, limite, valor) values ('${PLANO}', 'usuarios', 0);`);
    expect(erro).toMatch(/plano_limites_valor_positivo/);
  });

  it("capacidade fora do vocabulário é recusada", () => {
    const erro = erroDe(`insert into public.plano_capacidades (plano_id, capacidade) values ('${PLANO}', 'inventada');`);
    expect(erro).toMatch(/plano_capacidades_vocabulario/);
  });

  it("a situação da assinatura só aceita o vocabulário fechado", () => {
    const erro = erroDe(`update public.assinaturas set situacao = 'talvez' where organization_id = '${ORG_B}';`);
    expect(erro).toMatch(/assinaturas_situacao/);
  });

  it("dois preços vigentes para o mesmo plano/intervalo/moeda são recusados", () => {
    rodar(`insert into public.plano_precos (plano_id, intervalo, valor_cents) values ('${PLANO}', 'anual', 100000) on conflict do nothing;`);
    const erro = erroDe(`insert into public.plano_precos (plano_id, intervalo, valor_cents) values ('${PLANO}', 'anual', 120000);`);
    expect(erro).toMatch(/plano_precos_vigente_idx|duplicate key/);
  });

  it("organizations.status NÃO ganhou valor de cobrança — inadimplência não vive ali", () => {
    // A decisão mais cara de reverter: misturar inadimplência em `status` faria
    // o webhook de pagamento reativar quem foi suspenso por abuso.
    const erro = erroDe(`update public.organizations set status = 'inadimplente' where id = '${ORG_B}';`);
    expect(erro).toMatch(/violates check constraint/);
  });
});

describe("o pagamento: duas tabelas que só o SERVIDOR toca", () => {
  const TABELAS_DO_SERVIDOR = ["cobranca_checkouts", "cobranca_eventos"] as const;

  it.each(TABELAS_DO_SERVIDOR)("%s: nenhum privilégio para anon/authenticated/PUBLIC", (tabela) => {
    const linhas = rodar(`
      select grantee || ':' || privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = '${tabela}'
         and grantee in ('anon', 'authenticated', 'PUBLIC');
    `);
    expect(linhas, `${tabela} concede privilégio a papel do PostgREST`).toBe("");
  });

  it.each(TABELAS_DO_SERVIDOR)("%s: nem o MEMBRO da própria organização lê", (tabela) => {
    // É fila do servidor, não dado do cliente: o membro da A não lê nem as linhas da A.
    const erro = erroDe(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
      select count(*) from public.${tabela};
    `);
    expect(erro).toMatch(/permission denied/i);
  });

  it("cobranca_eventos: o MESMO evento duas vezes é recusado por 23505 — a idempotência do webhook", () => {
    rodar(`insert into public.cobranca_eventos (stripe_event_id, tipo, stripe_criado_em) values ('evt_inv_1', 'invoice.paid', now()) on conflict do nothing;`);
    const erro = erroDe(`insert into public.cobranca_eventos (stripe_event_id, tipo, stripe_criado_em) values ('evt_inv_1', 'invoice.paid', now());`);
    expect(erro).toMatch(/duplicate key|23505/);
  });

  it("cobranca_eventos: o recibo é processado COM resultado, ou nem um nem outro", () => {
    // O meio-termo que nenhum leitor sabe interpretar: "processado, mas o quê?".
    const erro = erroDe(`insert into public.cobranca_eventos (stripe_event_id, tipo, stripe_criado_em, processado_em) values ('evt_inv_2', 'x', now(), now());`);
    expect(erro).toMatch(/cobranca_eventos_recibo/);
  });

  it("cobranca_eventos: organização anulável — evento sem dono é REGISTRADO, não perdido", () => {
    rodar(`insert into public.cobranca_eventos (stripe_event_id, tipo, stripe_criado_em, processado_em, resultado) values ('evt_inv_3', 'invoice.paid', now(), now(), 'sem_organizacao') on conflict do nothing;`);
    expect(rodar(`select organization_id is null from public.cobranca_eventos where stripe_event_id = 'evt_inv_3';`)).toBe("t");
  });

  it("cobranca_checkouts: apagar a organização leva os checkouts (cascade), sem órfão", () => {
    const org = "cccccccc-9999-4000-8000-000000000009";
    rodar(`
      insert into public.organizations (id, slug, legal_name, display_name) values ('${org}', 'plano-inv-cascade', 'c', 'c') on conflict (id) do nothing;
      insert into public.cobranca_checkouts (session_id, organization_id) values ('cs_inv_cascade', '${org}') on conflict do nothing;
    `);
    rodar(`delete from public.organizations where id = '${org}';`);
    expect(rodar(`select count(*) from public.cobranca_checkouts where session_id = 'cs_inv_cascade';`)).toBe("0");
  });
});

describe("os knobs da instalação nascem no valor SEGURO", () => {
  it("COBRANCA_LIGADA nasce desligado, e LIMITES_MODO nasce avisar", () => {
    // Estado de fábrica, capturado no `beforeAll`: os testes do gatilho ligam a cobrança
    // depois, e ler aqui mediria o que ELES deixaram. A cobrança desligada é o que faz
    // uma instalação que só atualizou não mudar em nada.
    const linhas = knobsDeFabrica.split("\n");
    expect(linhas).toContain("COBRANCA_LIGADA=desligado");
    expect(linhas).toContain("LIMITES_MODO=avisar");
  });

  it("DIAS_DE_TESTE e CARENCIA_DIAS nascem 14 e 5", () => {
    const linhas = knobsDeFabrica.split("\n");
    expect(linhas).toContain("DIAS_DE_TESTE=14");
    expect(linhas).toContain("CARENCIA_DIAS=5");
  });
});
