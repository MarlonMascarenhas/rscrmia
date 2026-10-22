import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0399 — `fn_admin_excluir_organizacao(org, slug_digitado)`: o super admin exclui uma
 * empresa inteira, numa transação.
 *
 * O que se prova, contra o banco que o cliente instala (baseline aplicado):
 *  - EXECUTE só para service_role (nem PUBLIC, nem anon, nem authenticated);
 *  - premissa do fixture: os pares RESTRICT/NO ACTION que o cascade sozinho não resolve EXISTEM no
 *    catálogo (senão o caso de sucesso passaria de forma vazia);
 *  - empresa inexistente, slug diferente, acompanhamento aberto e assinatura do Asaas que ainda
 *    renova são RECUSADOS e nada é apagado;
 *  - cortesia manual e assinatura já cancelada NÃO bloqueiam;
 *  - com a empresa cheia (agente + versão + run, canal + chamada de voz, contato + conversa +
 *    mensagem + agendamento, auditoria, recibo de cobrança, membros) a função apaga sem erro; a
 *    auditoria e o recibo de cobrança SOBREVIVEM com organization_id nulo; as contas das pessoas
 *    continuam em auth.users; a empresa vizinha não é tocada.
 *
 * Todos os ids abaixo são deste arquivo (prefixo b0399000).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db`");
}

const ORG_OK = "b0399000-0000-4000-8000-000000000001"; // a empresa cheia, excluída com sucesso
const ORG_ASSIN = "b0399000-0000-4000-8000-000000000002"; // assinatura do Asaas ativa -> bloqueia
const ORG_CORTESIA = "b0399000-0000-4000-8000-000000000003"; // cortesia manual, sem Asaas -> libera
const ORG_CANCELADA = "b0399000-0000-4000-8000-000000000004"; // Asaas já cancelada -> libera
const ORG_SUPORTE = "b0399000-0000-4000-8000-000000000005"; // acompanhamento aberto -> bloqueia
const ORG_INEXISTENTE = "b0399000-0000-4000-8000-0000000000ff";

const U1 = "b0399000-1111-4000-8000-000000000001"; // admin da ORG_OK
const U2 = "b0399000-1111-4000-8000-000000000002"; // agent da ORG_OK e admin da ORG_ASSIN

const SESSAO_DE_CANAL = "b0399000-2222-4000-8000-000000000001";
const CONTATO = "b0399000-3333-4000-8000-000000000001";
const CONTATO_VIZINHO = "b0399000-3333-4000-8000-000000000002";
const CONVERSA = "b0399000-4444-4000-8000-000000000001";
const AGENTE = "b0399000-5555-4000-8000-000000000001";
const VERSAO = "b0399000-5555-4000-8000-000000000002";
const RUN = "b0399000-5555-4000-8000-000000000003";
const SESSAO_DE_SUPORTE_AUTH = "b0399000-6666-4000-8000-000000000001";

const TAG_AUDITORIA = "excl-0399-ok";
const CHAVE_RECIBO = "excl-0399-evento-ok";
const NOME_DA_SESSAO = "excl-0399-sessao-ok";

const ORGS = [ORG_OK, ORG_ASSIN, ORG_CORTESIA, ORG_CANCELADA, ORG_SUPORTE];

/** Roda UM select que devolve um jsonb em texto e o interpreta (psql -tA: última linha). */
function json(script: string): Record<string, unknown> {
  const linhas = sql(script).split("\n");
  return JSON.parse(linhas[linhas.length - 1] as string) as Record<string, unknown>;
}

function excluir(org: string, slug: string): Record<string, unknown> {
  return json(`select public.fn_admin_excluir_organizacao('${org}', '${slug}')::text`);
}

function contar(tabela: string, org: string): number {
  return Number(sql(`select count(*) from public.${tabela} where organization_id = '${org}'`));
}

function orgExiste(org: string): boolean {
  return sql(`select exists (select 1 from public.organizations where id = '${org}')::text`) === "true";
}

const TABELAS_DO_TENANT = [
  "user_organizations",
  "channel_sessions",
  "contacts",
  "conversations",
  "messages",
  "calendar_appointments",
  "ai_agents",
  "ai_agent_versions",
  "ai_agent_runs",
  "voice_calls",
] as const;

function fotografia(org: string): string {
  return TABELAS_DO_TENANT.map((t) => `${t}=${contar(t, org)}`).join(",");
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${U1}', 'excl-0399-u1@invariant.test'),
      ('${U2}', 'excl-0399-u2@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_OK}', 'excl-0399-ok', 'Excl 0399 Ok', 'Empresa Cheia'),
      ('${ORG_ASSIN}', 'excl-0399-assin', 'Excl 0399 Assin', 'Empresa Com Assinatura'),
      ('${ORG_CORTESIA}', 'excl-0399-cortesia', 'Excl 0399 Cortesia', 'Empresa Cortesia'),
      ('${ORG_CANCELADA}', 'excl-0399-cancelada', 'Excl 0399 Cancelada', 'Empresa Cancelada'),
      ('${ORG_SUPORTE}', 'excl-0399-suporte', 'Excl 0399 Suporte', 'Empresa Em Suporte')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${U1}', '${ORG_OK}', 'admin', now()),
      ('${U2}', '${ORG_OK}', 'agent', now()),
      ('${U2}', '${ORG_ASSIN}', 'admin', now())
      on conflict do nothing;

    -- ORG_OK: o grafo com os pares RESTRICT.
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO_DE_CANAL}', '${ORG_OK}', '${NOME_DA_SESSAO}', '\\x00'::bytea);
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${ORG_OK}', 'Contato da empresa cheia');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${ORG_OK}', '${CONTATO}', '${SESSAO_DE_CANAL}', 'open');
    insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${ORG_OK}', '${CONVERSA}', '${SESSAO_DE_CANAL}', '${CONTATO}', 'text', 'inbound', 'mensagem do invariante 0399');
    insert into public.calendar_appointments (organization_id, contact_id, conversation_id, title, starts_at, ends_at, status)
      values ('${ORG_OK}', '${CONTATO}', '${CONVERSA}', 'Consulta 0399', now() - interval '2 hours', now() - interval '1 hour', 'confirmed');
    insert into public.voice_calls (organization_id, channel_session_id, contact_id, wacalls_call_id, direction, peer_phone, status)
      values ('${ORG_OK}', '${SESSAO_DE_CANAL}', '${CONTATO}', 'excl-0399-chamada', 'inbound', '5511900000000', 'ended');
    insert into public.ai_agents (id, organization_id, name, system_prompt)
      values ('${AGENTE}', '${ORG_OK}', 'Agente 0399', 'system');
    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, tool_ids)
      values ('${VERSAO}', '${ORG_OK}', '${AGENTE}', 1, 'system', 'anthropic', 'claude-sonnet-4-6', '${SESSAO_DE_CANAL}', 'published',
              array['crm_get_lead']);
    update public.ai_agents set published_version_id = '${VERSAO}' where id = '${AGENTE}';
    insert into public.ai_agent_runs (id, organization_id, agent_id, agent_version_id, status, is_dry_run, started_at)
      values ('${RUN}', '${ORG_OK}', '${AGENTE}', '${VERSAO}', 'completed', false, now());

    -- O que tem de SOBREVIVER à exclusão (FK SET NULL).
    insert into public.api_audit_log (organization_id, action, resource_type, metadata)
      values ('${ORG_OK}', 'ai.handoff_triggered', 'conversation', '{"tag":"${TAG_AUDITORIA}"}'::jsonb);
    insert into public.cobranca_eventos_asaas (chave, evento, organization_id)
      values ('${CHAVE_RECIBO}', 'PAYMENT_RECEIVED', '${ORG_OK}')
      on conflict (chave) do nothing;

    -- ORG_ASSIN: assinatura do Asaas que ainda renova, e um contato para provar que nada some.
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_VIZINHO}', '${ORG_ASSIN}', 'Contato da empresa com assinatura');
    insert into public.assinaturas (organization_id, situacao, liberado_ate, asaas_assinatura_id)
      values ('${ORG_ASSIN}', 'ativa', now() + interval '30 days', 'sub_excl_0399_ativa');

    -- ORG_CORTESIA: liberação manual, sem assinatura no Asaas.
    insert into public.assinaturas (organization_id, situacao, liberado_ate)
      values ('${ORG_CORTESIA}', 'cortesia', now() + interval '30 days');

    -- ORG_CANCELADA: veio do Asaas, mas já recebeu o cancelamento (cancelada_em preenchido).
    insert into public.assinaturas (organization_id, situacao, liberado_ate, cancelada_em, asaas_assinatura_id)
      values ('${ORG_CANCELADA}', 'ativa', now() + interval '30 days', now(), 'sub_excl_0399_cancelada');

    -- ORG_SUPORTE: acompanhamento de suporte aberto e vigente.
    insert into public.platform_support_sessions (organization_id, actor_user_id, auth_session_id, access_mode, expires_at)
      values ('${ORG_SUPORTE}', '${U1}', '${SESSAO_DE_SUPORTE_AUTH}', 'full', now() + interval '1 hour');
  `);
});

afterAll(() => {
  const lista = ORGS.map((o) => `'${o}'`).join(",");
  sql(`
    delete from public.platform_support_sessions where organization_id in (${lista});
    delete from public.organizations where id in (${lista});
    delete from public.api_audit_log where metadata->>'tag' = '${TAG_AUDITORIA}';
    delete from public.cobranca_eventos_asaas where chave = '${CHAVE_RECIBO}';
    delete from auth.users where id in ('${U1}', '${U2}');
  `);
});

describe("0399 — superfície de EXECUTE", () => {
  it("service_role executa; PUBLIC, anon e authenticated não", () => {
    const fn = "public.fn_admin_excluir_organizacao(uuid,text)";
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

describe("0399 — o fixture exercita os pares que o cascade sozinho não resolve", () => {
  // Sem estes pares no catálogo, o caso de sucesso abaixo passaria sem provar a ordem do apagamento.
  const PARES: Array<[string, string]> = [
    ["ai_agent_runs", "ai_agent_versions"],
    ["voice_calls", "channel_sessions"],
    ["calendar_appointments", "contacts"],
    ["messages", "contacts"],
    ["conversations", "contacts"],
  ];
  it.each(PARES)("%s -> %s é FK RESTRICT/NO ACTION", (origem, destino) => {
    const n = sql(`
      select count(*) from pg_constraint
       where contype = 'f' and confdeltype in ('r', 'a')
         and conrelid = 'public.${origem}'::regclass and confrelid = 'public.${destino}'::regclass;
    `);
    expect(Number(n)).toBeGreaterThan(0);
  });
});

describe("0399 — recusas (nada é apagado)", () => {
  it("empresa inexistente", () => {
    expect(excluir(ORG_INEXISTENTE, "qualquer")).toEqual({ ok: false, codigo: "nao_encontrada" });
  });

  it("slug diferente: recusa e não apaga NADA da empresa cheia", () => {
    const antes = fotografia(ORG_OK);
    // Controle positivo: a empresa tem linha em todas as tabelas da fotografia.
    expect(antes).not.toMatch(/=0/);
    expect(excluir(ORG_OK, "excl-0399-OK")).toEqual({ ok: false, codigo: "slug_nao_confere" });
    expect(excluir(ORG_OK, " excl-0399-ok")).toEqual({ ok: false, codigo: "slug_nao_confere" });
    expect(excluir(ORG_OK, "")).toEqual({ ok: false, codigo: "slug_nao_confere" });
    expect(orgExiste(ORG_OK)).toBe(true);
    expect(fotografia(ORG_OK)).toBe(antes);
  });

  it("assinatura do Asaas ativa: bloqueia, diz qual, e não apaga nada", () => {
    const r = excluir(ORG_ASSIN, "excl-0399-assin") as {
      ok: boolean;
      codigo: string;
      assinatura: { asaas_assinatura_id: string; situacao: string };
    };
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe("assinatura_ativa");
    expect(r.assinatura).toMatchObject({ asaas_assinatura_id: "sub_excl_0399_ativa", situacao: "ativa" });
    expect(orgExiste(ORG_ASSIN)).toBe(true);
    expect(contar("contacts", ORG_ASSIN)).toBe(1);
    expect(contar("assinaturas", ORG_ASSIN)).toBe(1);
  });

  it("acompanhamento de suporte aberto: bloqueia e não apaga nada", () => {
    expect(excluir(ORG_SUPORTE, "excl-0399-suporte")).toEqual({ ok: false, codigo: "em_acompanhamento" });
    expect(orgExiste(ORG_SUPORTE)).toBe(true);
    expect(contar("platform_support_sessions", ORG_SUPORTE)).toBe(1);
  });
});

describe("0399 — o que NÃO bloqueia", () => {
  it("cortesia manual (sem assinatura no Asaas) é excluída", () => {
    const r = excluir(ORG_CORTESIA, "excl-0399-cortesia");
    expect(r).toMatchObject({ ok: true, codigo: "excluida", slug: "excl-0399-cortesia" });
    expect(orgExiste(ORG_CORTESIA)).toBe(false);
    expect(contar("assinaturas", ORG_CORTESIA)).toBe(0);
  });

  it("assinatura do Asaas já cancelada (cancelada_em preenchido) é excluída", () => {
    const r = excluir(ORG_CANCELADA, "excl-0399-cancelada");
    expect(r).toMatchObject({ ok: true, codigo: "excluida" });
    expect(orgExiste(ORG_CANCELADA)).toBe(false);
    expect(contar("assinaturas", ORG_CANCELADA)).toBe(0);
  });
});

describe("0399 — a exclusão da empresa cheia", () => {
  it("apaga sem erro, devolve o relatório, e o resto fica como deve", () => {
    // Antes: o histórico está ligado à empresa (controle positivo da sobrevivência).
    expect(
      sql(`select count(*) from public.api_audit_log where organization_id = '${ORG_OK}' and metadata->>'tag' = '${TAG_AUDITORIA}'`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.cobranca_eventos_asaas where chave = '${CHAVE_RECIBO}' and organization_id = '${ORG_OK}'`),
    ).toBe("1");

    const r = excluir(ORG_OK, "excl-0399-ok") as {
      ok: boolean;
      codigo: string;
      organization_id: string;
      slug: string;
      display_name: string;
      sessoes_de_canal: Array<{ id: string; waha_session_name: string; arquivada: boolean }>;
      contagens: Record<string, number>;
      tabelas_esvaziadas_antes: string[];
    };

    expect(r.ok).toBe(true);
    expect(r.codigo).toBe("excluida");
    expect(r.organization_id).toBe(ORG_OK);
    expect(r.slug).toBe("excl-0399-ok");
    expect(r.display_name).toBe("Empresa Cheia");
    expect(r.sessoes_de_canal).toHaveLength(1);
    expect(r.sessoes_de_canal[0]).toMatchObject({
      id: SESSAO_DE_CANAL,
      waha_session_name: NOME_DA_SESSAO,
      arquivada: false,
    });
    expect(r.contagens).toEqual({
      usuarios: 2,
      conversas: 1,
      mensagens: 1,
      contatos: 1,
      leads: 0,
      sessoes_de_canal: 1,
    });
    // A ordem foi de fato calculada: as origens de FK RESTRICT saíram antes do delete final.
    expect(r.tabelas_esvaziadas_antes).toEqual(
      expect.arrayContaining(["ai_agent_runs", "calendar_appointments", "messages", "conversations", "voice_calls"]),
    );

    // A empresa e tudo que era dela sumiram.
    expect(orgExiste(ORG_OK)).toBe(false);
    for (const tabela of TABELAS_DO_TENANT) {
      expect(contar(tabela, ORG_OK), tabela).toBe(0);
    }

    // O histórico SOBREVIVE, sem organização.
    expect(
      sql(`select count(*) from public.api_audit_log where organization_id is null and metadata->>'tag' = '${TAG_AUDITORIA}'`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.cobranca_eventos_asaas where chave = '${CHAVE_RECIBO}' and organization_id is null`),
    ).toBe("1");

    // As CONTAS das pessoas continuam; só perderam o vínculo com a empresa.
    expect(sql(`select count(*) from auth.users where id in ('${U1}', '${U2}')`)).toBe("2");
    expect(sql(`select count(*) from public.user_organizations where user_id = '${U2}' and organization_id = '${ORG_ASSIN}'`)).toBe("1");

    // A empresa vizinha não foi tocada.
    expect(orgExiste(ORG_ASSIN)).toBe(true);
    expect(contar("contacts", ORG_ASSIN)).toBe(1);

    // E repetir o pedido não reexclui nada: a empresa já não existe.
    expect(excluir(ORG_OK, "excl-0399-ok")).toEqual({ ok: false, codigo: "nao_encontrada" });
  });
});
