-- ---- super admin exclui uma empresa inteira (migration 0399) ----
--
-- `fn_admin_excluir_organizacao(p_org_id, p_slug_confirmacao)`: apaga a organização e tudo que
-- depende dela, NUMA transação, sob trava da linha da organização. Só o service_role a executa; a
-- rota `DELETE /api/v1/admin/tenants/[id]` é quem autentica o platform admin.
--
-- Recusas (nada é mudado), na ordem em que são avaliadas:
--   nao_encontrada     -- a organização não existe (ou já foi excluída por outra chamada);
--   slug_nao_confere   -- o slug digitado não é IGUAL ao da organização (comparação exata);
--   em_acompanhamento  -- há sessão de suporte da plataforma aberta e vigente nela;
--   assinatura_ativa   -- há assinatura no Asaas que ainda renova: `asaas_assinatura_id` preenchido,
--                         situacao 'ativa' ou 'inadimplente' e `cancelada_em` nulo. Cortesia manual
--                         (sem assinatura no Asaas), assinatura cancelada/expirada e a que já recebeu
--                         SUBSCRIPTION_DELETED/INACTIVATED (cancelada_em preenchido) NÃO bloqueiam.
--
-- Por que a trava `for update` na organização basta: INSERT em qualquer filho tenant-aware pega
-- FOR KEY SHARE na linha da organização (a FK), que conflita com FOR UPDATE. Um webhook do Asaas
-- ou um convite aceito no meio da exclusão espera ela terminar e então falha pela FK.
--
-- A ORDEM do apagamento. Quase toda FK para a organização e entre filhos é CASCADE, e o
-- `delete from organizations` final cuida. O que quebra o cascade é FK ON DELETE RESTRICT entre
-- duas tabelas que AMBAS morrem com a organização (ex.: ai_agent_runs -> ai_agent_versions,
-- voice_calls -> channel_sessions, calendar_appointments/messages/conversations -> contacts):
-- RESTRICT dispara na hora, e o pai cascateado antes do filho dá 23503. A função descobre essas
-- arestas PELO CATÁLOGO (pg_constraint), não por lista: tabela do tenant = FK de `organization_id`
-- para organizations(id) com ON DELETE CASCADE; aresta = FK ON DELETE RESTRICT/NO ACTION entre duas
-- tabelas do tenant. As tabelas que são ORIGEM de alguma aresta são esvaziadas antes, filhos antes
-- dos pais (ordenação topológica que considera também o que cai por CASCADE a partir de cada
-- tabela: apagar ai_agents leva ai_agent_versions, que ai_agent_runs referencia com RESTRICT, então
-- os runs saem antes). Tabela cuja FK para a organização é SET NULL (api_audit_log,
-- cobranca_eventos*, platform_support_sessions.previous_organization_id) nunca entra: o histórico
-- sobrevive com organization_id nulo, de propósito.
-- Limite: aresta RESTRICT que parte de tabela SEM coluna organization_id (filha de filha) não é
-- alcançada; o teste de invariante cobre os pares conhecidos, e um par novo desse tipo reprova ali.
--
-- Fora do banco (a rota faz, depois do commit): sessões do provedor de canal e objetos de storage
-- `{org}/...`. Por isso a função devolve as sessões de canal COLETADAS ANTES de apagar.
-- As contas das pessoas (auth.users) ficam: os vínculos (user_organizations) morrem com a empresa.

create or replace function public.fn_admin_excluir_organizacao(p_org_id uuid, p_slug_confirmacao text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org       record;
  v_assin     record;
  v_sessoes   jsonb;
  v_contagens jsonb;
  v_tabelas   oid[];
  v_alcance   oid[];
  v_pend      oid[];
  v_ordem     text[] := '{}';
  v_t         oid;
  v_prog      boolean;
begin
  select o.id, o.slug, o.display_name into v_org
    from public.organizations o
   where o.id = p_org_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'nao_encontrada');
  end if;

  if p_slug_confirmacao is distinct from v_org.slug then
    return jsonb_build_object('ok', false, 'codigo', 'slug_nao_confere');
  end if;

  if exists (
    select 1 from public.platform_support_sessions s
     where s.organization_id = p_org_id and s.ended_at is null and s.expires_at > now()
  ) then
    return jsonb_build_object('ok', false, 'codigo', 'em_acompanhamento');
  end if;

  select a.asaas_assinatura_id, a.situacao, a.liberado_ate into v_assin
    from public.assinaturas a
   where a.organization_id = p_org_id
     and a.asaas_assinatura_id is not null
     and a.situacao in ('ativa', 'inadimplente')
     and a.cancelada_em is null;
  if found then
    return jsonb_build_object('ok', false, 'codigo', 'assinatura_ativa',
      'assinatura', jsonb_build_object(
        'asaas_assinatura_id', v_assin.asaas_assinatura_id,
        'situacao', v_assin.situacao,
        'liberado_ate', v_assin.liberado_ate));
  end if;

  -- Coleta ANTES de apagar: depois do delete não resta de onde ler.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', cs.id,
           'provider', cs.provider,
           'waha_session_name', cs.waha_session_name,
           'meta_phone_number_id', cs.meta_phone_number_id,
           'meta_token_encrypted', cs.meta_token_encrypted,
           'arquivada', cs.archived_at is not null)), '[]'::jsonb)
    into v_sessoes
    from public.channel_sessions cs
   where cs.organization_id = p_org_id;

  v_contagens := jsonb_build_object(
    'usuarios',  (select count(*) from public.user_organizations where organization_id = p_org_id and revoked_at is null),
    'conversas', (select count(*) from public.conversations where organization_id = p_org_id),
    'mensagens', (select count(*) from public.messages where organization_id = p_org_id),
    'contatos',  (select count(*) from public.contacts where organization_id = p_org_id),
    'leads',     (select count(*) from public.crm_leads where organization_id = p_org_id),
    'sessoes_de_canal', jsonb_array_length(v_sessoes));

  -- Tabelas do tenant: FK de organization_id para organizations(id), ON DELETE CASCADE.
  select coalesce(array_agg(distinct c.conrelid), '{}') into v_tabelas
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f'
     and c.confrelid = 'public.organizations'::regclass
     and c.confdeltype = 'c'
     and c.conparentid = 0
     and array_length(c.conkey, 1) = 1
     and a.attname = 'organization_id'
     and c.connamespace = 'public'::regnamespace;

  -- Alcance do tenant: as tabelas acima MAIS tudo que some por CASCADE a partir delas.
  with recursive d(rel) as (
    select t from unnest(v_tabelas) as t
    union
    select c.conrelid
      from pg_constraint c
      join d on c.confrelid = d.rel
     where c.contype = 'f' and c.confdeltype = 'c'
  )
  select coalesce(array_agg(rel), '{}') into v_alcance from d;

  -- Origens de aresta RESTRICT/NO ACTION: tabela do tenant (apagável por organization_id) cuja FK
  -- aponta para outra tabela do alcance.
  select coalesce(array_agg(distinct c.conrelid), '{}') into v_pend
    from pg_constraint c
   where c.contype = 'f'
     and c.confdeltype in ('a', 'r')
     and c.conparentid = 0
     and c.conrelid = any (v_tabelas)
     and c.confrelid = any (v_alcance)
     and c.conrelid <> c.confrelid;

  loop
    v_prog := false;
    for v_t in select unnest(v_pend) loop
      -- Apagar v_t derruba, por CASCADE, o seu fecho (ele mesmo e os filhos em cascata). Só sai
      -- quando nenhuma OUTRA origem ainda pendente tem FK RESTRICT/NO ACTION para esse fecho:
      -- senão o RESTRICT dispara no meio do cascade, com o filho ainda de pé (era o caso de apagar
      -- ai_agents antes de ai_agent_runs: o cascade leva ai_agent_versions, que o run referencia).
      if not exists (
        with recursive fecho(rel) as (
          select v_t
          union
          select c.conrelid
            from pg_constraint c
            join fecho f on c.confrelid = f.rel
           where c.contype = 'f' and c.confdeltype = 'c'
        )
        select 1
          from pg_constraint e
         where e.contype = 'f'
           and e.confdeltype in ('a', 'r')
           and e.conparentid = 0
           and e.conrelid = any (v_pend)
           and e.conrelid <> v_t
           and e.conrelid <> e.confrelid
           and e.confrelid in (select rel from fecho)
      ) then
        execute format('delete from %s where organization_id = $1', v_t::regclass) using p_org_id;
        v_ordem := v_ordem || v_t::regclass::text;
        v_pend := array_remove(v_pend, v_t);
        v_prog := true;
      end if;
    end loop;
    exit when not v_prog or cardinality(v_pend) = 0;
  end loop;

  -- O que sobrou (ciclo improvável) o delete final tenta; se o Postgres recusar, a transação inteira
  -- volta e nada foi apagado.
  delete from public.organizations where id = p_org_id;

  return jsonb_build_object(
    'ok', true,
    'codigo', 'excluida',
    'organization_id', p_org_id,
    'slug', v_org.slug,
    'display_name', v_org.display_name,
    'sessoes_de_canal', v_sessoes,
    'contagens', v_contagens,
    'tabelas_esvaziadas_antes', to_jsonb(v_ordem));
end;
$$;

revoke execute on function public.fn_admin_excluir_organizacao(uuid, text) from public, anon, authenticated;
grant  execute on function public.fn_admin_excluir_organizacao(uuid, text) to service_role;
