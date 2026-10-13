-- Limite de mensagens por conversa e senha da organização para excluir conversa (migration 0396).
-- 1. Mensagens além da janela das N mais recentes por conversa.
--    O piso de 100 mora NO CORPO: quem chama não consegue pedir menos que isso.
--    `queued`/`sending` têm dono (o envio ainda vai acontecer) e nunca entram.
create or replace function public.fn_mensagens_excedentes(p_manter integer, p_limite integer)
returns table(id uuid, organization_id uuid, conversation_id uuid, media_storage_path text)
language sql
stable
security definer
set search_path = public
as $fn$
  select x.id, x.organization_id, x.conversation_id, x.media_storage_path
  from (
    select m.id, m.organization_id, m.conversation_id, m.media_storage_path, m.status, m.sent_at,
           row_number() over (
             partition by m.conversation_id
             order by m.sent_at desc nulls first, m.id desc
           ) as posicao
    from public.messages m
  ) x
  where x.posicao > greatest(coalesce(p_manter, 100), 100)
    and x.status not in ('queued', 'sending')
  order by x.sent_at asc, x.id asc
  limit greatest(coalesce(p_limite, 1), 1);
$fn$;

-- 2. Apaga só os ids pedidos que AINDA estão fora da janela (mesma regra e piso).
create or replace function public.fn_apagar_mensagens_excedentes(p_ids uuid[], p_manter integer)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_apagadas integer;
begin
  with fora as (
    select m.id
    from public.messages m
    where m.id = any(coalesce(p_ids, '{}'::uuid[]))
      and m.status not in ('queued', 'sending')
      and (
        select count(*)
        from public.messages n
        where n.conversation_id = m.conversation_id
          and (n.sent_at, n.id) > (m.sent_at, m.id)
      ) >= greatest(coalesce(p_manter, 100), 100)
  ),
  del as (
    delete from public.messages d using fora where d.id = fora.id returning d.id
  )
  select count(*) into v_apagadas from del;
  return v_apagadas;
end;
$fn$;

revoke execute on function public.fn_mensagens_excedentes(integer, integer) from public, anon, authenticated;
grant  execute on function public.fn_mensagens_excedentes(integer, integer) to service_role;
revoke execute on function public.fn_apagar_mensagens_excedentes(uuid[], integer) from public, anon, authenticated;
grant  execute on function public.fn_apagar_mensagens_excedentes(uuid[], integer) to service_role;

-- 3. Senha da organização para excluir conversa.
--    NÃO fica em organizations.settings: settings é legível por membros da
--    organização, e o hash ali ficaria exposto a brute force offline. Tabela
--    própria, RLS ligada e ZERO policies: só o service_role lê e escreve.
create table if not exists public.organization_conversation_delete_secret (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  password_hash text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.organization_conversation_delete_secret enable row level security;
revoke all on table public.organization_conversation_delete_secret from anon, authenticated, public;
grant select, insert, update, delete on table public.organization_conversation_delete_secret to service_role;

notify pgrst, 'reload schema';
