-- ---- cobrança pelo Asaas; a Cakto sai do código (migration 0397) ----
--
-- O provedor de pagamento das assinaturas passa a ser o Asaas (ADR-0006). A Cakto sai
-- do CÓDIGO, não do BANCO — como o Stripe saiu na 0395: toda coluna cakto_* e a tabela
-- cobranca_eventos_cakto ficam, comentadas como MORTAS, porque o update.sh do clone roda
-- sem ON_ERROR_STOP e derrubar coluna é dívida com quem clonou. Nenhum DROP.

-- 1. Assinatura vigente da organização, cliente do Asaas e a fatura em aberto.
alter table public.assinaturas
  add column if not exists asaas_assinatura_id      text,
  add column if not exists asaas_cliente_id         text,
  add column if not exists asaas_fatura_url         text,
  add column if not exists asaas_fatura_vencimento  date;
create unique index if not exists assinaturas_asaas_assinatura_id_key
  on public.assinaturas (asaas_assinatura_id) where asaas_assinatura_id is not null;
create index if not exists assinaturas_asaas_cliente_idx
  on public.assinaturas (asaas_cliente_id) where asaas_cliente_id is not null;
comment on column public.assinaturas.asaas_assinatura_id is
  'Assinatura VIGENTE da organização no Asaas (migration 0397). Evento de outra assinatura não mexe no acesso. É o que o cancelamento pela tela remove.';
comment on column public.assinaturas.asaas_cliente_id is
  'Cliente (pagador) da organização no Asaas (migration 0397). O CPF/CNPJ NUNCA é guardado aqui: vai só ao Asaas, e guardamos apenas o id.';
comment on column public.assinaturas.asaas_fatura_url is
  'Link da fatura em aberto hospedada no Asaas (migration 0397), gravado por PAYMENT_CREATED/PAYMENT_OVERDUE e limpo quando ela é paga. A tela mostra "Fatura em aberto — pagar".';
comment on column public.assinaturas.asaas_fatura_vencimento is
  'Vencimento (data) da fatura em aberto (migration 0397).';
comment on column public.assinaturas.cakto_assinatura_id is 'MORTA desde a migration 0397: a Cakto saiu do código.';
comment on column public.assinaturas.cakto_cliente_id is 'MORTA desde a migration 0397: a Cakto saiu do código.';

-- 2. O mapa "sessão de pagamento -> organização". O provedor passa a admitir 'asaas' e a ser o padrão.
alter table public.cobranca_checkouts
  add column if not exists asaas_assinatura_id text,
  add column if not exists asaas_cliente_id    text,
  add column if not exists asaas_pagamento_id  text;
alter table public.cobranca_checkouts alter column provedor set default 'asaas';
alter table public.cobranca_checkouts drop constraint if exists cobranca_checkouts_provedor;
alter table public.cobranca_checkouts
  add constraint cobranca_checkouts_provedor check (provedor in ('stripe', 'cakto', 'asaas'));
alter table public.cobranca_checkouts drop constraint if exists cobranca_checkouts_token_do_asaas;
alter table public.cobranca_checkouts
  add constraint cobranca_checkouts_token_do_asaas
    check (provedor <> 'asaas' or session_id ~ '^[A-Za-z0-9._~-]{1,255}$');
create index if not exists cobranca_checkouts_asaas_assinatura_idx
  on public.cobranca_checkouts (asaas_assinatura_id) where asaas_assinatura_id is not null;
comment on column public.cobranca_checkouts.session_id is
  'Id da sessão de pagamento que ESTE produto criou. Para provedor = asaas, é o token opaco enviado como externalReference da assinatura (migration 0397); para cakto, o token do ?callback= (0395).';
comment on column public.cobranca_checkouts.asaas_cliente_id is
  'Cliente do Asaas desta organização, gravado ANTES de criar a assinatura (migration 0397): uma tentativa que falha no meio não perde o cliente nem o recria.';
comment on column public.cobranca_checkouts.cakto_oferta_id     is 'MORTA desde a migration 0397: a Cakto saiu do código.';
comment on column public.cobranca_checkouts.cakto_assinatura_id is 'MORTA desde a migration 0397: a Cakto saiu do código.';
comment on column public.cobranca_checkouts.cakto_cliente_id    is 'MORTA desde a migration 0397: a Cakto saiu do código.';
comment on column public.cobranca_checkouts.cakto_pedido_id     is 'MORTA desde a migration 0397: a Cakto saiu do código.';

-- 3. O Asaas não tem produto nem oferta: o preço publicado não exige mais id externo. A regra que
--    sobra é a que independe de provedor — um preço publicado tem de ser cobrável (valor > 0).
alter table public.plano_precos drop constraint if exists plano_precos_publicado_tem_provedor;
update public.plano_precos set publicado_em = null
 where publicado_em is not null and valor_cents <= 0;
alter table public.plano_precos
  add constraint plano_precos_publicado_tem_provedor
    check (publicado_em is null or valor_cents > 0);
comment on column public.plano_precos.cakto_oferta_id is 'MORTA desde a migration 0397: a Cakto saiu do código.';
comment on column public.planos.cakto_produto_id is 'MORTA desde a migration 0397: a Cakto saiu do código.';

-- 4. O recibo de cada evento do webhook do Asaas. PK = `id` do evento (o Asaas repete o mesmo id nas reentregas).
create table if not exists public.cobranca_eventos_asaas (
  chave           text        primary key,
  evento          text        not null,
  pagamento_id    text,
  organization_id uuid        references public.organizations(id) on delete set null,
  recebido_em     timestamptz not null default now(),
  processado_em   timestamptz,
  resultado       text,
  erro            text,
  entrada         jsonb       not null default '{}'::jsonb,
  vinculado_por   uuid,
  constraint cobranca_eventos_asaas_recibo check (
    (processado_em is null and resultado is null) or
    (processado_em is not null and resultado is not null)),
  constraint cobranca_eventos_asaas_chave_tamanho check (char_length(chave) between 3 and 400)
);
comment on table public.cobranca_eventos_asaas is
  'Recibo de cada evento do webhook do Asaas (migration 0397). PK chave = id do evento (idempotência; entrega at-least-once). organization_id anulável: evento sem dono é REGISTRADO (resultado sem_organizacao) para ligação manual em /admin. entrada guarda só identificadores e o link da fatura, nunca dado pessoal do pagador. Só o service_role toca.';
create index if not exists cobranca_eventos_asaas_org_idx
  on public.cobranca_eventos_asaas (organization_id, recebido_em desc);
create index if not exists cobranca_eventos_asaas_pendentes_idx
  on public.cobranca_eventos_asaas (recebido_em desc)
  where processado_em is null or resultado in ('sem_organizacao', 'ignorado_sem_periodo', 'ignorado_assinatura_antiga');
alter table public.cobranca_eventos_asaas enable row level security;
revoke all on public.cobranca_eventos_asaas from anon, authenticated;
grant select, insert, update on public.cobranca_eventos_asaas to service_role;

comment on table public.cobranca_eventos_cakto is
  'MORTA desde a migration 0397: recibo dos eventos da Cakto, que saiu do código. Os eventos do Asaas vivem em cobranca_eventos_asaas.';

notify pgrst, 'reload schema';
