import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * Poda de mensagens além da janela e segredo de exclusão (migration 0396),
 * contra o Postgres de verdade: o piso no corpo, a exclusão de queued/sending
 * e quem pode executar são propriedades do banco, não observáveis de um mock.
 */

const ORG = "39600000-0000-4000-8000-000000000001";
const CONTATO = "39600000-0000-4000-8000-000000000002";
const SESSAO = "39600000-0000-4000-8000-000000000003";
const CONVERSA = "39600000-0000-4000-8000-000000000004";

function conta(query: string): number {
  return Number(lastLine(sql(query)));
}

function semear(recebidas: number): void {
  sql(`
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-limite-msg-0396', 'Org Limite LTDA', 'Org Limite')
      on conflict (id) do nothing;
    insert into contacts (id, organization_id, name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Lead Limite', '+5511900000396')
      on conflict (id) do nothing;
    insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'sessao-0396', 'WORKING', decode('00','hex'))
      on conflict (id) do nothing;
    insert into conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}', 'open')
      on conflict (id) do nothing;
    delete from messages where conversation_id = '${CONVERSA}';
    -- 1 queued ANTIGA (a mais velha de todas) + N recebidas.
    insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
                          type, direction, status, body, sent_at)
      values ('${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'text', 'outbound', 'queued', 'pendente',
              now() - interval '10 days');
    insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
                          type, direction, status, body, sent_at)
      select '${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}', 'text', 'inbound', 'received', 'm' || g,
             now() - (g || ' minutes')::interval
      from generate_series(1, ${recebidas}) g;
  `);
}

beforeEach(() => semear(130));

describe("fn_mensagens_excedentes / fn_apagar_mensagens_excedentes", () => {
  it("devolve só as 30 excedentes, nunca a queued, e a poda deixa as 100 mais novas + a queued", () => {
    expect(conta(`select count(*) from public.fn_mensagens_excedentes(100, 1000)`)).toBe(30);
    expect(
      conta(
        `select count(*) from public.fn_mensagens_excedentes(100, 1000) e
           join messages m on m.id = e.id where m.status = 'queued'`,
      ),
    ).toBe(0);

    const apagadas = conta(`
      select public.fn_apagar_mensagens_excedentes(
        (select array_agg(id) from public.fn_mensagens_excedentes(100, 1000)), 100)`);
    expect(apagadas).toBe(30);

    expect(conta(`select count(*) from messages where conversation_id='${CONVERSA}'`)).toBe(101);
    expect(
      conta(`select count(*) from messages where conversation_id='${CONVERSA}' and status='queued'`),
    ).toBe(1);
    // As 100 que ficaram são as mais novas: m1..m100.
    expect(
      conta(
        `select count(*) from messages where conversation_id='${CONVERSA}' and status='received'
           and body in (select 'm' || g from generate_series(1,100) g)`,
      ),
    ).toBe(100);
  });

  it("o piso de 100 vale no corpo: p_manter=10 ainda mantém 100", () => {
    expect(conta(`select count(*) from public.fn_mensagens_excedentes(10, 1000)`)).toBe(30);
    const apagadas = conta(`
      select public.fn_apagar_mensagens_excedentes(
        (select array_agg(id) from public.fn_mensagens_excedentes(10, 1000)), 10)`);
    expect(apagadas).toBe(30);
    expect(
      conta(`select count(*) from messages where conversation_id='${CONVERSA}' and status='received'`),
    ).toBe(100);
  });

  it("apagar não alcança id que ainda está dentro da janela", () => {
    const apagadas = conta(`
      select public.fn_apagar_mensagens_excedentes(
        (select array_agg(id) from messages where conversation_id='${CONVERSA}'), 100)`);
    expect(apagadas).toBe(30);
    expect(conta(`select count(*) from messages where conversation_id='${CONVERSA}'`)).toBe(101);
  });
});

describe("privilégios", () => {
  it("anon e authenticated não têm EXECUTE nas duas funções; service_role tem", () => {
    for (const fn of [
      "public.fn_mensagens_excedentes(integer, integer)",
      "public.fn_apagar_mensagens_excedentes(uuid[], integer)",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        expect(lastLine(sql(`select has_function_privilege('${role}', '${fn}', 'execute')`))).toBe("f");
      }
      expect(lastLine(sql(`select has_function_privilege('service_role', '${fn}', 'execute')`))).toBe("t");
    }
  });

  it("authenticated e anon não leem o segredo de exclusão; service_role sim", () => {
    const t = "public.organization_conversation_delete_secret";
    expect(lastLine(sql(`select has_table_privilege('authenticated', '${t}', 'select')`))).toBe("f");
    expect(lastLine(sql(`select has_table_privilege('anon', '${t}', 'select')`))).toBe("f");
    expect(lastLine(sql(`select has_table_privilege('service_role', '${t}', 'select')`))).toBe("t");
  });
});
