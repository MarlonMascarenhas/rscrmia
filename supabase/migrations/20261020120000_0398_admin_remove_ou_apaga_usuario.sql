-- ---- super admin remove usuário da empresa ou apaga a conta (migration 0398) ----
--
-- Duas funções `security definer` que fazem a contagem do "último admin" e a mudança NA MESMA
-- transação, sob trava (a rota do team conta e depois atualiza em dois comandos: tem race).
-- Só o service_role as executa; a rota de /api/v1/admin/users é quem autentica o platform admin.
--
-- 1. fn_admin_revogar_vinculo(p_user_id, p_org_id): revoga o vínculo ATIVO usuário x organização
--    (user_organizations.revoked_at), recusando se o alvo é o único admin ativo da organização.
-- 2. fn_admin_preparar_exclusao_de_usuario(p_user_id): prepara a exclusão da conta do Auth.
--    Nada é mudado se houver bloqueio. Sem bloqueio: anula as colunas ANULÁVEIS que referenciam
--    auth.users sem cascade (descobertas pelo catálogo pg_constraint, não por lista), e revoga
--    os vínculos ativos. Quem apaga o usuário do Auth é a rota, depois; se ela falhar, o que foi
--    anulado/revogado aqui permanece (o usuário segue existindo, sem acesso às empresas).

create or replace function public.fn_admin_revogar_vinculo(p_user_id uuid, p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_vinculo public.user_organizations%rowtype;
  v_outros  integer;
  v_agora   timestamptz := now();
begin
  perform pg_advisory_xact_lock(hashtextextended('admin-org-admins:' || p_org_id::text, 0));

  select * into v_vinculo
    from public.user_organizations
   where user_id = p_user_id and organization_id = p_org_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'codigo', 'nao_encontrado');
  end if;
  if v_vinculo.revoked_at is not null then
    return jsonb_build_object('ok', true, 'codigo', 'ja_revogado', 'role', v_vinculo.role,
                              'revoked_at', v_vinculo.revoked_at);
  end if;

  if v_vinculo.role = 'admin' then
    select count(*) into v_outros
      from public.user_organizations
     where organization_id = p_org_id and role = 'admin' and revoked_at is null
       and user_id <> p_user_id;
    if v_outros = 0 then
      return jsonb_build_object('ok', false, 'codigo', 'ultimo_admin');
    end if;
  end if;

  update public.user_organizations
     set revoked_at = v_agora, updated_at = v_agora
   where id = v_vinculo.id;

  return jsonb_build_object('ok', true, 'codigo', 'revogado', 'role', v_vinculo.role,
                            'revoked_at', v_agora);
end;
$$;

create or replace function public.fn_admin_preparar_exclusao_de_usuario(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org        record;
  v_fk         record;
  v_qtd        bigint;
  v_ultimos    jsonb := '[]'::jsonb;
  v_obrig      jsonb := '[]'::jsonb;
  v_anulaveis  jsonb := '[]'::jsonb;
  v_revogadas  jsonb;
  v_agora      timestamptz := now();
begin
  if not exists (select 1 from auth.users where id = p_user_id) then
    return jsonb_build_object('ok', false, 'codigo', 'nao_encontrado');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-user-delete:' || p_user_id::text, 0));

  if exists (select 1 from public.platform_admins
              where user_id = p_user_id and revoked_at is null) then
    return jsonb_build_object('ok', false, 'codigo', 'platform_admin');
  end if;

  -- Organizações onde o alvo é admin ativo. Trava em ordem de id (sem deadlock entre duas
  -- exclusões) e conta, na mesma transação, quem MAIS é admin ativo ali.
  for v_org in
    select uo.organization_id, o.display_name
      from public.user_organizations uo
      join public.organizations o on o.id = uo.organization_id
     where uo.user_id = p_user_id and uo.role = 'admin' and uo.revoked_at is null
     order by uo.organization_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('admin-org-admins:' || v_org.organization_id::text, 0));
    if not exists (
      select 1 from public.user_organizations
       where organization_id = v_org.organization_id and role = 'admin'
         and revoked_at is null and user_id <> p_user_id
    ) then
      v_ultimos := v_ultimos || jsonb_build_object(
        'organization_id', v_org.organization_id, 'nome', v_org.display_name);
    end if;
  end loop;

  -- FKs para auth.users que BLOQUEIAM o delete (NO ACTION / RESTRICT), pelo catálogo. As do
  -- schema auth são do GoTrue e ficam com ele.
  for v_fk in
    select c.conrelid::regclass::text as tabela, a.attname::text as coluna, a.attnotnull as obrigatoria
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'auth.users'::regclass
       and c.confdeltype in ('a', 'r')
       and array_length(c.conkey, 1) = 1
       and n.nspname <> 'auth'
     order by 1, 2
  loop
    execute format('select count(*) from %s where %I = $1', v_fk.tabela, v_fk.coluna)
      into v_qtd using p_user_id;
    if v_qtd > 0 then
      if v_fk.obrigatoria then
        v_obrig := v_obrig || jsonb_build_object(
          'tabela', v_fk.tabela, 'coluna', v_fk.coluna, 'quantidade', v_qtd);
      else
        v_anulaveis := v_anulaveis || jsonb_build_object(
          'tabela', v_fk.tabela, 'coluna', v_fk.coluna, 'quantidade', v_qtd);
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_ultimos) > 0 or jsonb_array_length(v_obrig) > 0 then
    return jsonb_build_object('ok', false, 'codigo', 'bloqueado',
      'bloqueios', jsonb_build_object('ultimos_admins', v_ultimos, 'registros_obrigatorios', v_obrig));
  end if;

  for v_fk in
    select x->>'tabela' as tabela, x->>'coluna' as coluna
      from jsonb_array_elements(v_anulaveis) x
  loop
    execute format('update %s set %I = null where %I = $1', v_fk.tabela, v_fk.coluna, v_fk.coluna)
      using p_user_id;
  end loop;

  with r as (
    update public.user_organizations
       set revoked_at = v_agora, updated_at = v_agora
     where user_id = p_user_id and revoked_at is null
    returning organization_id
  )
  select coalesce(jsonb_agg(organization_id), '[]'::jsonb) into v_revogadas from r;

  return jsonb_build_object('ok', true, 'codigo', 'preparado',
    'organizacoes_revogadas', v_revogadas, 'anuladas', v_anulaveis);
end;
$$;

revoke execute on function public.fn_admin_revogar_vinculo(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.fn_admin_revogar_vinculo(uuid, uuid) to service_role;
revoke execute on function public.fn_admin_preparar_exclusao_de_usuario(uuid) from public, anon, authenticated;
grant  execute on function public.fn_admin_preparar_exclusao_de_usuario(uuid) to service_role;
