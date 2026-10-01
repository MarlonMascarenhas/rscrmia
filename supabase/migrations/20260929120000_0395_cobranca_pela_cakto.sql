-- ---- cobrança pela Cakto; o Stripe sai do código (migration 0395) ----
--
-- O provedor de pagamento das assinaturas passa a ser a Cakto. O Stripe sai do
-- CÓDIGO, não do BANCO: toda coluna stripe_* fica, comentada como MORTA, porque o
-- update.sh do clone roda sem ON_ERROR_STOP e derrubar coluna é dívida com quem
-- clonou. Nenhum DROP COLUMN.

alter table public.planos add column if not exists cakto_produto_id text;
create unique index if not exists planos_cakto_produto_id_key
  on public.planos (cakto_produto_id) where cakto_produto_id is not null;
comment on column public.planos.cakto_produto_id is
  'Produto da Cakto que cobra este plano (migration 0395). Criado pelo sistema na primeira venda (POST /public_api/products/, X-Idempotency-Key produto:<planos.id>), nunca pelo painel. null = ainda não existe na Cakto.';

alter table public.plano_precos add column if not exists cakto_oferta_id text;
create unique index if not exists plano_precos_cakto_oferta_id_key
  on public.plano_precos (cakto_oferta_id) where cakto_oferta_id is not null;
alter table public.plano_precos drop constraint if exists plano_precos_publicado_tem_provedor;
update public.plano_precos set publicado_em = null
 where publicado_em is not null and cakto_oferta_id is null;
alter table public.plano_precos
  add constraint plano_precos_publicado_tem_provedor
    check (publicado_em is null or cakto_oferta_id is not null);
comment on column public.plano_precos.cakto_oferta_id is
  'Oferta da Cakto que cobra este preço (migration 0395). Criada pelo sistema na primeira venda (POST /public_api/offers/, X-Idempotency-Key oferta:<plano_precos.id>). Link de pagamento: https://pay.cakto.com.br/<cakto_oferta_id>. Imutável como o preço: reajuste é linha nova e oferta nova.';
comment on column public.plano_precos.stripe_price_id is
  'MORTA desde a migration 0395: o Stripe saiu do código. Mantida para não derrubar coluna em clone.';

alter table public.assinaturas
  add column if not exists cakto_assinatura_id text,
  add column if not exists cakto_cliente_id    text;
create unique index if not exists assinaturas_cakto_assinatura_id_key
  on public.assinaturas (cakto_assinatura_id) where cakto_assinatura_id is not null;
create index if not exists assinaturas_cakto_cliente_idx
  on public.assinaturas (cakto_cliente_id) where cakto_cliente_id is not null;
comment on column public.assinaturas.cakto_assinatura_id is
  'Assinatura VIGENTE da organização na Cakto (migration 0395). Evento de outra assinatura não mexe no acesso. É o que o cancelamento pela tela cancela.';
comment on column public.assinaturas.cakto_cliente_id is
  'Cliente da Cakto que pagou (migration 0395). Resolve a organização só quando casa com exatamente uma.';
comment on column public.assinaturas.stripe_customer_id is 'MORTA desde a migration 0395: o Stripe saiu do código.';
comment on column public.assinaturas.stripe_subscription_id is 'MORTA desde a migration 0395: o Stripe saiu do código.';

alter table public.cobranca_checkouts
  add column if not exists provedor            text not null default 'stripe',
  add column if not exists cakto_oferta_id     text,
  add column if not exists cakto_assinatura_id text,
  add column if not exists cakto_cliente_id    text,
  add column if not exists cakto_pedido_id     text,
  add column if not exists pago_em             timestamptz;
alter table public.cobranca_checkouts alter column provedor set default 'cakto';
alter table public.cobranca_checkouts drop constraint if exists cobranca_checkouts_provedor;
alter table public.cobranca_checkouts
  add constraint cobranca_checkouts_provedor check (provedor in ('stripe', 'cakto'));
alter table public.cobranca_checkouts drop constraint if exists cobranca_checkouts_token_da_cakto;
alter table public.cobranca_checkouts
  add constraint cobranca_checkouts_token_da_cakto
    check (provedor <> 'cakto' or session_id ~ '^[A-Za-z0-9._~-]{1,255}$');
create index if not exists cobranca_checkouts_cakto_assinatura_idx
  on public.cobranca_checkouts (cakto_assinatura_id) where cakto_assinatura_id is not null;
comment on column public.cobranca_checkouts.session_id is
  'Id da sessão de pagamento que ESTE produto criou. Para provedor = cakto, é o token opaco enviado em ?callback= e devolvido pela Cakto em data.callback (migration 0395).';
comment on column public.cobranca_checkouts.stripe_customer_id is 'MORTA desde a migration 0395: o Stripe saiu do código.';
comment on column public.cobranca_checkouts.stripe_subscription_id is 'MORTA desde a migration 0395: o Stripe saiu do código.';

comment on table public.cobranca_eventos is
  'MORTA desde a migration 0395: recibo dos eventos do Stripe, que saiu do código. Os eventos da Cakto vivem em cobranca_eventos_cakto.';

create table if not exists public.cobranca_eventos_cakto (
  chave           text        primary key,
  evento          text        not null,
  pedido_id       text,
  enviado_em      timestamptz,
  autenticacao    text        not null,
  organization_id uuid        references public.organizations(id) on delete set null,
  recebido_em     timestamptz not null default now(),
  processado_em   timestamptz,
  resultado       text,
  erro            text,
  entrada         jsonb       not null default '{}'::jsonb,
  vinculado_por   uuid,
  constraint cobranca_eventos_cakto_recibo check (
    (processado_em is null and resultado is null) or
    (processado_em is not null and resultado is not null)),
  constraint cobranca_eventos_cakto_autenticacao check (autenticacao in ('hmac', 'segredo_no_corpo')),
  constraint cobranca_eventos_cakto_chave_tamanho check (char_length(chave) between 3 and 400)
);
comment on table public.cobranca_eventos_cakto is
  'Recibo de cada evento do webhook da Cakto (migration 0395). PK chave = <event>:<data.id> (idempotência). organization_id anulável: evento sem dono é REGISTRADO (resultado sem_organizacao) para ligação manual em /admin. entrada guarda só identificadores, nunca dado pessoal do pagador. Só o service_role toca.';
create index if not exists cobranca_eventos_cakto_org_idx
  on public.cobranca_eventos_cakto (organization_id, recebido_em desc);
create index if not exists cobranca_eventos_cakto_pendentes_idx
  on public.cobranca_eventos_cakto (recebido_em desc)
  where processado_em is null or resultado in ('sem_organizacao', 'ignorado_sem_periodo', 'ignorado_assinatura_antiga');
alter table public.cobranca_eventos_cakto enable row level security;
revoke all on public.cobranca_eventos_cakto from anon, authenticated;
grant select, insert, update on public.cobranca_eventos_cakto to service_role;

create or replace function public.fn_cobranca_orgs_do_admin_por_email(p_email text)
returns table (organization_id uuid)
language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct uo.organization_id
    from auth.users u
    join public.user_organizations uo on uo.user_id = u.id
    join public.organizations o on o.id = uo.organization_id
   where p_email is not null
     and char_length(trim(p_email)) between 3 and 320
     and lower(u.email) = lower(trim(p_email))
     and uo.role = 'admin'
     and uo.revoked_at is null
     and uo.accepted_at is not null
     and o.status in ('active', 'suspended')
   limit 2;
$$;
revoke execute on function public.fn_cobranca_orgs_do_admin_por_email(text) from public, anon, authenticated;
grant  execute on function public.fn_cobranca_orgs_do_admin_por_email(text) to service_role;

notify pgrst, 'reload schema';
