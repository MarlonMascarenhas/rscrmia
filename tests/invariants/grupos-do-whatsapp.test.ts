/**
 * Migration 0394 — grupo do WhatsApp como CONTATO PRÓPRIO, nunca pessoa.
 *
 * Prova, contra Postgres de verdade (não há mock de banco):
 *
 *   1. as duas colunas nascem NOT NULL DEFAULT false;
 *   2. `fn_upsert_wa_grupo` é EXECUTE-ONLY de `service_role` (anon e
 *      authenticated recusados);
 *   3. a âncora de entrada é idempotente por `(organization_id,
 *      waha_group_chat_id)` — duas chamadas com o mesmo chat_id devolvem o
 *      MESMO contato e a MESMA conversa;
 *   4. a sessão de OUTRA organização não abre grupo nenhum (nem cria contato);
 *   5. sessão com `mostrar_grupos=false` recusa;
 *   6. chat_id fora do formato `...@g.us` recusa;
 *   7. o MESMO chat_id em duas organizações produz DOIS contatos distintos —
 *      o índice único é por organização;
 *   8. grupo nunca vira lead (`trg_crm_leads_sem_contato_grupo`);
 *   9. grupo nunca é lado de uma fusão de contato
 *      (`trg_contacts_grupo_nao_mescla`);
 *  10. `comando_da_conversa` de grupo aberto sem dono é 'aguardando', nunca
 *      'automatico' (decisão do dono: grupo fica na Fila, nunca com o robô);
 *  11. inserir conversa de grupo NÃO emite `conversation.routing_requested`
 *      (grupo não entra no rodízio);
 *  12. `p_reabrir=true` reabre conversa de grupo fechada.
 *
 * Referência de estrutura:
 * tests/invariants/eco-do-proprio-envio-nao-cria-segunda-mensagem.test.ts
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ORG_A = "94000000-0394-4000-8000-000000000001";
const ORG_B = "94000000-0394-4000-8000-000000000002";

/** ORG_A, grupos ligados. */
const SESSAO_A_ON = "94000000-0394-4000-8000-0000000000a1";
/** ORG_A, grupos DESLIGADOS — caso 5. */
const SESSAO_A_OFF = "94000000-0394-4000-8000-0000000000a2";
/** ORG_B, grupos ligados — caso 7. */
const SESSAO_B_ON = "94000000-0394-4000-8000-0000000000b1";

const PIPELINE_A = "94000000-0394-4000-8000-0000000000c1";
const STAGE_A = "94000000-0394-4000-8000-0000000000c2";

/** Contato comum (não-grupo) de ORG_A, usado nas duas travas. */
const CONTATO_COMUM_A = "94000000-0394-4000-8000-0000000000d1";

const CHAT_GRUPO = "120363000000001234@g.us";
const CHAT_GRUPO_REABRIR = "120363000000005678@g.us";
const CHAT_1A1 = "5511999999999@c.us";

interface ErroPg {
  code?: string;
  message?: string;
}

async function semear(): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'grupos-wa-a', 'Grupos WA A LTDA', 'Grupos WA A'),
            ($2, 'grupos-wa-b', 'Grupos WA B LTDA', 'Grupos WA B')
     on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, mostrar_grupos)
     values ($1, $2, 'sessao-grupos-a-on', '\\x00'::bytea, true),
            ($3, $2, 'sessao-grupos-a-off', '\\x00'::bytea, false),
            ($4, $5, 'sessao-grupos-b-on', '\\x00'::bytea, true)
     on conflict (id) do nothing`,
    [SESSAO_A_ON, ORG_A, SESSAO_A_OFF, SESSAO_B_ON, ORG_B],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug)
     values ($1, $2, 'Grupos WA', 'grupos-wa') on conflict (id) do nothing`,
    [PIPELINE_A, ORG_A],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Novo', 'novo', 1000) on conflict (id) do nothing`,
    [STAGE_A, ORG_A, PIPELINE_A],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name)
     values ($1, $2, 'Contato comum A') on conflict (id) do nothing`,
    [CONTATO_COMUM_A, ORG_A],
  );
}

interface UpsertResultado {
  contact_id: string;
  conversation_id: string;
}

async function upsertGrupo(
  org: string,
  sessao: string,
  chatId: string,
  nome: string | null,
  reabrir: boolean,
): Promise<UpsertResultado> {
  const { rows } = await pool.query<{ v: UpsertResultado }>(
    "select public.fn_upsert_wa_grupo($1,$2,$3,$4,$5) as v",
    [org, sessao, chatId, nome, reabrir],
  );
  return rows[0]!.v;
}

/** Chama em transação própria: erro é isolado sem derrubar a conexão do pool. */
async function upsertGrupoEsperaErro(
  org: string,
  sessao: string,
  chatId: string,
  nome: string | null,
  reabrir: boolean,
): Promise<ErroPg> {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    await cliente.query("select public.fn_upsert_wa_grupo($1,$2,$3,$4,$5)", [
      org,
      sessao,
      chatId,
      nome,
      reabrir,
    ]);
    await cliente.query("commit");
    throw new Error("esperava erro e não houve");
  } catch (e) {
    return e as ErroPg;
  } finally {
    await cliente.query("rollback").catch(() => undefined);
    cliente.release();
  }
}

async function contarContatosDaOrg(org: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*)::text as n from contacts where organization_id = $1",
    [org],
  );
  return Number(rows[0]!.n);
}

async function privilegio(role: string, assinatura: string): Promise<boolean> {
  const { rows } = await pool.query<{ v: boolean }>(
    "select has_function_privilege($1, $2, 'EXECUTE') as v",
    [role, assinatura],
  );
  return rows[0]!.v;
}

beforeAll(async () => {
  await pool.query("select 1");
  await semear();
});

afterAll(async () => {
  await pool.end();
});

describe("migration 0394 — grupos do WhatsApp", () => {
  it("caso 1: as duas colunas nascem NOT NULL DEFAULT false", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select table_name, column_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public'
          and (table_name, column_name) in (('contacts','is_group'), ('channel_sessions','mostrar_grupos'))
        order by table_name`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.is_nullable, `${r.table_name}.${r.column_name}`).toBe("NO");
      expect(r.column_default, `${r.table_name}.${r.column_name}`).toContain("false");
    }
  });

  it("caso 2: fn_upsert_wa_grupo é EXECUTE-ONLY de service_role", async () => {
    const assinatura = "public.fn_upsert_wa_grupo(uuid,uuid,text,text,boolean)";
    expect(await privilegio("anon", assinatura)).toBe(false);
    expect(await privilegio("authenticated", assinatura)).toBe(false);
    expect(await privilegio("service_role", assinatura)).toBe(true);
  });

  it("caso 3: duas chamadas com o mesmo chat_id devolvem o MESMO contato e a MESMA conversa", async () => {
    const primeira = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO, null, false);
    const segunda = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO, null, false);

    expect(segunda.contact_id).toBe(primeira.contact_id);
    expect(segunda.conversation_id).toBe(primeira.conversation_id);

    const { rows: contato } = await pool.query<{ display_name: string; is_group: boolean }>(
      "select display_name, is_group from contacts where id = $1",
      [primeira.contact_id],
    );
    expect(contato[0]!.display_name).toBe("Grupo 1234");
    expect(contato[0]!.is_group).toBe(true);

    const { rows: conversa } = await pool.query<{ is_group: boolean; group_chat_id: string | null }>(
      "select is_group, group_chat_id from conversations where id = $1",
      [primeira.conversation_id],
    );
    expect(conversa[0]!.is_group).toBe(true);
    expect(conversa[0]!.group_chat_id).toBe(CHAT_GRUPO);
  });

  it("caso 4: sessão de OUTRA organização recusa — B não ganha contato novo", async () => {
    const antes = await contarContatosDaOrg(ORG_B);
    const erro = await upsertGrupoEsperaErro(ORG_B, SESSAO_A_ON, CHAT_GRUPO, null, false);
    expect(erro.message).toContain("grupo_sessao_sem_permissao");
    expect(await contarContatosDaOrg(ORG_B)).toBe(antes);
  });

  it("caso 5: sessão com mostrar_grupos=false recusa", async () => {
    const erro = await upsertGrupoEsperaErro(ORG_A, SESSAO_A_OFF, CHAT_GRUPO, null, false);
    expect(erro.message).toContain("grupo_sessao_sem_permissao");
  });

  it("caso 6: chat_id fora do formato ...@g.us recusa", async () => {
    const erro = await upsertGrupoEsperaErro(ORG_A, SESSAO_A_ON, CHAT_1A1, null, false);
    expect(erro.message).toContain("grupo_chat_id_invalido");
  });

  it("caso 7: o mesmo chat_id em duas organizações produz contatos distintos", async () => {
    const daA = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO, null, false);
    const daB = await upsertGrupo(ORG_B, SESSAO_B_ON, CHAT_GRUPO, null, false);
    expect(daB.contact_id).not.toBe(daA.contact_id);
  });

  it("caso 8: grupo nunca vira lead", async () => {
    const grupo = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO, null, false);
    await expect(
      pool.query(
        `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title)
         values ($1, $2, $3, $4, 'Lead de grupo, não deveria existir')`,
        [ORG_A, PIPELINE_A, STAGE_A, grupo.contact_id],
      ),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("contato_grupo_nao_vira_lead") });
  });

  it("caso 9: grupo nunca é lado de uma fusão de contatos", async () => {
    const grupo = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO, null, false);
    await expect(
      pool.query("update contacts set is_merged_into = $1 where id = $2", [
        grupo.contact_id,
        CONTATO_COMUM_A,
      ]),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("contato_grupo_nao_mescla") });
  });

  it("caso 10: comando_da_conversa de grupo aberto sem dono é 'aguardando'", async () => {
    const grupo = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO, null, false);
    const { rows } = await pool.query<{ comando: string }>(
      "select public.comando_da_conversa(t) as comando from conversations t where t.id = $1",
      [grupo.conversation_id],
    );
    expect(rows[0]!.comando).toBe("aguardando");
  });

  it("caso 11: inserir conversa de grupo não emite conversation.routing_requested", async () => {
    const { rows: antes } = await pool.query<{ n: string }>(
      "select count(*)::text as n from event_log where event_type = 'conversation.routing_requested'",
    );
    await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO, null, false);
    const { rows: depois } = await pool.query<{ n: string }>(
      "select count(*)::text as n from event_log where event_type = 'conversation.routing_requested'",
    );
    expect(Number(depois[0]!.n)).toBe(Number(antes[0]!.n));
  });

  it("caso 12: p_reabrir=true reabre conversa de grupo fechada", async () => {
    const grupo = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO_REABRIR, "Grupo pra reabrir", false);
    await pool.query("update conversations set status = 'closed' where id = $1", [grupo.conversation_id]);

    const semReabrir = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO_REABRIR, null, false);
    expect(semReabrir.conversation_id).toBe(grupo.conversation_id);
    const { rows: aindaFechada } = await pool.query<{ status: string }>(
      "select status from conversations where id = $1",
      [grupo.conversation_id],
    );
    expect(aindaFechada[0]!.status).toBe("closed");

    const comReabrir = await upsertGrupo(ORG_A, SESSAO_A_ON, CHAT_GRUPO_REABRIR, null, true);
    expect(comReabrir.conversation_id).toBe(grupo.conversation_id);
    const { rows: reaberta } = await pool.query<{ status: string }>(
      "select status from conversations where id = $1",
      [grupo.conversation_id],
    );
    expect(reaberta[0]!.status).toBe("open");
  });
});
