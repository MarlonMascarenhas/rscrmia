-- ---- grupos do WhatsApp na caixa de entrada, por conexão (migration 0394) ----
--
-- Grupo já é filtrado no WAHA (`lib/waha/client.ts`, `CONVERSAS_IGNORADAS.groups`)
-- e o CLAUDE.md manda pular o vínculo de CRM quando o chat termina em `@g.us`. Até
-- aqui, grupo nunca chegava ao banco. Esta migration abre a porta: uma conexão que
-- LIGA `channel_sessions.mostrar_grupos` passa a receber os eventos do grupo (o
-- `ignore.groups` do WAHA lê essa coluna, via `conversasIgnoradas()`) e o grupo
-- entra como um CONTATO PRÓPRIO — nunca lead, nunca fundido com pessoa.
--
-- `contacts.is_group` é a marca. `conversations.is_group`/`group_chat_id` já
-- existiam (migration 0027) para a conversa; o que faltava era o contato do outro
-- lado e a função de entrada. Quem não liga `mostrar_grupos` continua exatamente
-- como estava: as duas colunas nascem `false`, e nenhum caminho hoje as grava.
--
-- ═══ AS TRÊS TRAVAS ═══
--
--   1. `fn_upsert_wa_grupo` exige a sessão ligada (`mostrar_grupos`) e o formato
--      do chat_id (`...@g.us`) — sem isso, sem contato de grupo.
--   2. `fn_contato_grupo_nao_vira_lead` — um grupo nunca entra em `crm_leads`.
--   3. `fn_contato_grupo_nao_mescla` — um grupo nunca é lado de uma fusão de
--      contatos (nem como perdedor, nem recebendo o merge de outro).
--
-- E o roteamento: grupo nunca cai na fila humana (decisão do dono) — os dois
-- gatilhos de `conversation.routing_requested` ganham `and new.is_group = false`
-- no WHEN, preservando por completo o resto da condição atual. `comando_da_conversa`
-- passa a responder 'aguardando' (nunca 'automatico') para conversa de grupo sem
-- dono, pelo mesmo motivo: ninguém decidiu que o robô atende grupo.

alter table public.contacts add column if not exists is_group boolean not null default false;
alter table public.channel_sessions add column if not exists mostrar_grupos boolean not null default false;

comment on column public.contacts.is_group is
  'Linha que representa um GRUPO do WhatsApp (conversa @g.us). Nunca é pessoa: fora de listagens, campanhas, funil, limite de plano e fusão.';
comment on column public.channel_sessions.mostrar_grupos is
  'Grupos deste número entram na caixa de entrada. Controla também o ignore.groups da sessão no WAHA.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Um grupo por organização (por `waha_group_chat_id`)
-- ─────────────────────────────────────────────────────────────────────────────

-- Auto-cura: banco de teste local que já rodou a versão anterior deste bloco
-- (sem `is_merged_into is null`) tem o índice com o predicado antigo, e
-- `create unique index if not exists` não o recria. Dropa se a definição no
-- catálogo não bater com o predicado atual.
do $$
begin
  if exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'contacts'
       and indexname = 'uniq_contacts_org_grupo_wa'
       and indexdef not like '%is_merged_into%'
  ) then
    drop index public.uniq_contacts_org_grupo_wa;
  end if;
end $$;

-- Índice de identidade: ficha mesclada (`is_merged_into is not null`) não
-- segura o `waha_group_chat_id` — a regra dos outros índices de identidade de
-- `contacts` (ver `tests/unit/indice-de-contato-ignora-ficha-mesclada.test.ts`).
create unique index if not exists uniq_contacts_org_grupo_wa
  on public.contacts (organization_id, (source_metadata->>'waha_group_chat_id'))
  where is_group and is_merged_into is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `fn_upsert_wa_grupo` — a âncora de entrada de um grupo
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fn_upsert_wa_grupo(
  p_org uuid, p_session uuid, p_group_chat_id text, p_nome text, p_reabrir boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_contact uuid; v_conv uuid; v_nome text;
begin
  if p_org is null or p_session is null or p_group_chat_id is null
     or length(p_group_chat_id) > 128
     or p_group_chat_id !~ '^[0-9]+(-[0-9]+)?@g\.us$' then
    raise exception 'grupo_chat_id_invalido' using errcode = '22023';
  end if;
  if not exists (select 1 from public.channel_sessions s
                  where s.id = p_session and s.organization_id = p_org and s.mostrar_grupos) then
    raise exception 'grupo_sessao_sem_permissao' using errcode = '42501';
  end if;
  v_nome := left(coalesce(nullif(btrim(p_nome), ''),
                 'Grupo ' || right(split_part(p_group_chat_id, '@', 1), 4)), 120);
  insert into public.contacts (organization_id, display_name, source, consent, tags, source_metadata, is_group)
  values (p_org, v_nome, 'whatsapp', '{}'::jsonb, '{}'::text[],
          jsonb_build_object('waha_group_chat_id', p_group_chat_id), true)
  on conflict (organization_id, (source_metadata->>'waha_group_chat_id')) where is_group and is_merged_into is null
  do update set display_name = coalesce(contacts.display_name, excluded.display_name), updated_at = now()
  returning id into v_contact;
  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status,
                                    is_group, group_chat_id, unread_count_for_assignee, metadata)
  values (p_org, v_contact, p_session, 'whatsapp', 'open', true, p_group_chat_id, 0, '{}'::jsonb)
  on conflict on constraint conversations_unique_per_contact_session
  do update set updated_at = now(),
    status = case when p_reabrir and conversations.status in ('closed','resolved','archived') then 'open' else conversations.status end,
    status_changed_at = case when p_reabrir and conversations.status in ('closed','resolved','archived') then clock_timestamp() else conversations.status_changed_at end
  returning id into v_conv;
  return jsonb_build_object('contact_id', v_contact, 'conversation_id', v_conv);
end; $$;

revoke execute on function public.fn_upsert_wa_grupo(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant  execute on function public.fn_upsert_wa_grupo(uuid, uuid, text, text, boolean) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Trava 2: grupo nunca vira lead
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fn_contato_grupo_nao_vira_lead()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.contact_id is not null and exists (select 1 from public.contacts c where c.id = new.contact_id and c.is_group) then
    raise exception 'contato_grupo_nao_vira_lead' using errcode = '23514';
  end if;
  return new;
end; $$;

revoke execute on function public.fn_contato_grupo_nao_vira_lead() from public, anon, authenticated;

drop trigger if exists trg_crm_leads_sem_contato_grupo on public.crm_leads;
create trigger trg_crm_leads_sem_contato_grupo before insert or update of contact_id on public.crm_leads
  for each row execute function public.fn_contato_grupo_nao_vira_lead();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Trava 3: grupo nunca é lado de uma fusão de contatos
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fn_contato_grupo_nao_mescla()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_merged_into is not null and new.is_merged_into is distinct from old.is_merged_into
     and (old.is_group or exists (select 1 from public.contacts c where c.id = new.is_merged_into and c.is_group)) then
    raise exception 'contato_grupo_nao_mescla' using errcode = '23514';
  end if;
  return new;
end; $$;

revoke execute on function public.fn_contato_grupo_nao_mescla() from public, anon, authenticated;

drop trigger if exists trg_contacts_grupo_nao_mescla on public.contacts;
create trigger trg_contacts_grupo_nao_mescla before update of is_merged_into on public.contacts
  for each row execute function public.fn_contato_grupo_nao_mescla();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `comando_da_conversa` — grupo sem dono é "aguardando", nunca "automatico"
-- ─────────────────────────────────────────────────────────────────────────────
-- Decisão do dono: grupo fica na Fila sem dono, nunca com o robô. A chamada a
-- `fn_comando_da_conversa` é IDÊNTICA à vigente (mesmos argumentos, mesma ordem);
-- só o `case` de grupo foi acrescentado por fora.

create or replace function public.comando_da_conversa(c public.conversations)
returns text language sql stable set search_path = public as $comando$
  select case when c.is_group and r.comando = 'automatico' then 'aguardando' else r.comando end
  from (select public.fn_comando_da_conversa(
          c.status, c.assigned_to_user_id, c.bot_silenced_until,
          coalesce((select ct.force_human from public.contacts ct where ct.id = c.contact_id), false),
          coalesce((select ct.is_blocked  from public.contacts ct where ct.id = c.contact_id), false),
          now()) as comando) r;
$comando$;

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Roteamento: grupo nunca cai na fila humana
-- ─────────────────────────────────────────────────────────────────────────────
-- Os dois gatilhos são IDÊNTICOS aos vigentes; só `and new.is_group = false`
-- entra no WHEN.

drop trigger if exists trg_conversation_routing_requested on public.conversations;
create trigger trg_conversation_routing_requested
  after insert on public.conversations
  for each row
  when (new.assigned_to_user_id is null and new.status in ('open', 'pending') and new.is_group = false)
  execute function public.fn_emit_conversation_routing();

drop trigger if exists trg_service_reopened_routing on public.conversations;
create trigger trg_service_reopened_routing after update of status on public.conversations
 for each row when (old.status in ('closed','resolved','archived') and new.status in ('open','pending')
  and new.assigned_to_user_id is null and new.is_group = false) execute function public.fn_emit_conversation_routing();

notify pgrst, 'reload schema';
