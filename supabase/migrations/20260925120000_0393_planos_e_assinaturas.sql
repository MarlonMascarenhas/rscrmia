-- ---- planos, assinaturas e o prazo de acesso (migration 0393) ----
--
-- A instalação passa a poder atender vários clientes PAGANTES: um catálogo de
-- planos que quem administra edita pela tela, uma assinatura por organização, e
-- um prazo de acesso que o produto consulta para decidir se a organização
-- trabalha ou vê a tela de vencimento.
--
-- ═══ INERTE POR PADRÃO — LEIA ISTO ANTES DE QUALQUER COISA ═══
--
-- `platform_config.COBRANCA_LIGADA` nasce `desligado`, e é o PRIMEIRO degrau da
-- decisão (`lib/planos/decisao.ts`): desligada, nada tranca, nenhuma tela some,
-- nenhuma faixa aparece. Uma instalação que apenas aplicou esta migration não
-- muda de comportamento em nada.
--
-- Isso não é diplomacia com a doutrina — é o que faz
-- `docs/doctrine/extensoes.md:128-130` ("não pôr atrás de pagamento o que já foi
-- distribuído") seguir verdadeiro em CÓDIGO e não em prosa. Quem liga a cobrança
-- é quem quer vender; quem não liga não perde nada.
--
-- ═══ UMA COLUNA RESPONDE O GATE ═══
--
-- `organizations.acesso_liberado_ate` é o ÚNICO fato que o gate consulta, e as
-- quatro situações do negócio são a MESMA comparação de data:
--
--   teste grátis      a coluna nasce em now() + DIAS_DE_TESTE (gatilho abaixo)
--   pago              o webhook do provedor empurra a data para frente
--   liberado à mão    quem administra grava a data em /admin
--   vencido           now() >= a data
--
-- Isso tira o vencimento do caminho de qualquer cron: não há job que precise ter
-- rodado para a cobrança valer. Cron, mais tarde, serve para AVISAR antes de
-- vencer — nunca para bloquear.
--
-- E o gate não custa consulta: `loadAuthUser` (lib/auth/server.ts:190) já faz
-- embed de `organizations` na consulta de memberships, então a coluna viaja para
-- tela e rota sem uma ida a mais ao banco.
--
-- ═══ `null` É "SEM PRAZO", NUNCA "VENCIDO" ═══
--
-- A decisão que mais importa neste arquivo, e a que mais parece errada de fora.
--
-- Esta migration roda em instalações que JÁ atendem alguém. Se `null` fosse
-- "vencido", toda organização existente seria trancada no `update.sh`; e se o
-- backfill preenchesse `now() + N dias`, ela seria trancada N dias depois, por
-- ter atualizado. As duas leituras transformam atualização de rotina em perda de
-- acesso de quem já pagava — exatamente o que a doutrina de migrations proíbe (o
-- contraste deliberado entre a 0234 e a 0142, citado em `lib/voice/opt-in.ts`).
--
-- Então: organização que já existe fica com `null` e continua trabalhando para
-- sempre. Só organização NOVA, criada com `COBRANCA_LIGADA = ligado`, nasce com
-- prazo (o gatilho abaixo explica por quê). E `null` ganha, de brinde, o
-- significado operacional que o dono vai querer: "esta não vence nunca" — a
-- própria organização dele, um parceiro, um contrato vitalício.
--
-- É também o lado para o qual o gate de ACESSO erra de propósito: falhar fechado
-- num soluço de banco trancaria a base pagante inteira numa tela de paywall,
-- enquanto falhar aberto dá alguns minutos a quem venceu. O mesmo lado que
-- `lib/agent-engine/edge/llm/orcamento.ts:24-28` escolheu, pela mesma razão.
-- (CAPACIDADE erra para o outro lado — o raio é uma feature, não o produto. A
-- justificativa mora em `lib/planos/decisao.ts`.)
--
-- ═══ POR QUE NÃO REUSAR `organizations.status` ═══
--
-- `status` (active|suspended|redacted|archived) já significa suspensão
-- ADMINISTRATIVA, com `suspended_at/reason/by` e as rotas /admin/tenants/[id]/
-- suspend e /reactivate. Pôr inadimplência ali faria quatro estragos:
--
--   1. É uma coluna só, com dois escritores. Um tenant suspenso por abuso que
--      pagasse seria REATIVADO pelo webhook do provedor — o pagamento desfazendo
--      uma decisão de moderação. É porta de abuso, não detalhe.
--   2. O inverso trava a porta manual: o operador reativa à mão e a cobrança
--      re-suspende, sobrescrevendo `suspended_reason`.
--   3. `redacted` e `archived` são terminais de LGPD e de ciclo de vida. Um teste
--      vencendo não pode mover um tenant para fora de `redacted`.
--   4. `tenant.suspended` deixaria de significar "um humano decidiu".
--
-- ═══ ONDE OS KNOBS MORAM, E POR QUE NÃO EM `platform_settings` ═══
--
-- Em `platform_config`, uma linha por chave. A razão está no cabeçalho da 0384 e
-- vale igual aqui: `platform_settings` é SINGLETON, e criar a linha dele faz
-- `signup_mode` nascer 'aberto' e vencer o `SIGNUP_MODE` do `.env` de quem nunca
-- abriu a tela. Um knob de cobrança não pode ligar cadastro aberto por efeito
-- colateral.
--
-- ═══ ESTADO DE TESTE É DERIVADO, NÃO GRAVADO ═══
--
-- Não há linha em `assinaturas` durante o teste: ausência de linha + data no
-- futuro JÁ É "em teste". Gravar linha para dizer o que a ausência já diz seria
-- duplicar sem fonte (DIRC: Calcular vence Duplicar). A linha nasce quando existe
-- assinatura de verdade — liberação manual ou provedor de pagamento — e aí tem
-- autor (`liberado_por`) porque ato intencional tem de ser visível.
--
-- ═══ AS DUAS COLUNAS EM `organizations` SÃO DUPLICAÇÃO DELIBERADA ═══
--
-- A fonte da verdade é `assinaturas`. `organizations.acesso_liberado_ate` e
-- `.plano_id` são cópia, porque o gate roda em toda requisição e não pode pagar
-- um join. A sincronia é GATILHO, na mesma transação — nunca cron (anti-pattern 5
-- do CLAUDE.md). `fn_sincronizar_acesso_da_organizacao` abaixo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. O CATÁLOGO — da INSTALAÇÃO, sem organization_id
-- ─────────────────────────────────────────────────────────────────────────────
-- O plano não pertence a organização nenhuma: quem o cria é quem administra a
-- instalação, e ele é oferecido a todas. Pôr `organization_id` aqui faria cada
-- empresa ter o próprio catálogo, que é o oposto do pedido.
--
-- Mesmo desenho de `platform_config` e `registration_requests`: RLS ligada, ZERO
-- policies de propósito, e só o `service_role` alcança. A tela do cliente vê o
-- catálogo por uma ROTA, que filtra o que está publicado — o PostgREST não sabe
-- filtrar intenção.

create table if not exists public.planos (
  id             uuid        primary key default gen_random_uuid(),
  -- Estável e legível: é o que aparece em log, em suporte e em conversa. O uuid
  -- serve de chave; o código serve de nome próprio.
  codigo         citext      not null unique,
  nome           text        not null,
  descricao      text,
  ordem          integer     not null default 0,
  -- O nível que libera tudo (o requisito do dono). Coluna e não "ausência de
  -- limites": a intenção fica declarada, e um plano que libera tudo continua
  -- liberando tudo quando uma capacidade NOVA nascer amanhã. Sem isto, todo
  -- recurso novo teria de ser acrescentado à mão a cada plano de topo.
  libera_tudo    boolean     not null default false,
  -- null = rascunho. Não é ofertável, e é assim que o dono monta um plano em paz
  -- antes de alguém poder comprá-lo.
  publicado_em   timestamptz,
  -- Arquivamento é LÓGICO: assinatura viva aponta para cá, e `on delete restrict`
  -- recusaria o delete de qualquer forma.
  arquivado_em   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  constraint planos_codigo_formato check (codigo ~ '^[a-z][a-z0-9_]{1,31}$')
);

comment on table public.planos is
  'Catálogo de planos da INSTALAÇÃO (migration 0393). Sem organization_id: o plano é oferecido a todas as organizações e só quem administra a instalação o edita. `libera_tudo` é o nível que inclui toda capacidade, inclusive as que nascerem depois. `publicado_em` null = rascunho, não ofertável.';

create index if not exists planos_ofertaveis_idx
  on public.planos (ordem, created_at)
  where publicado_em is not null and arquivado_em is null;

alter table public.planos enable row level security;
-- ZERO POLICIES, DE PROPÓSITO: a linha não pertence a organização nenhuma.
-- E o ALTER DEFAULT PRIVILEGES deste baseline dá GRANT ALL em TABLES a `anon`:
-- toda tabela nova nasce EXPOSTA e precisa revogar por conta própria.
revoke all on public.planos from anon, authenticated;
grant select, insert, update, delete on public.planos to service_role;

-- As capacidades que o plano libera. Tabela filha e não `text[]` nem coluna
-- booleana por capacidade: a tela é uma lista de caixas de marcar (que é um
-- join), e capacidade nova não pede migration de coluna.
--
-- O CHECK de vocabulário existe de propósito: ele faz
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre colunas
-- que JÁ têm CHECK — vigiar esta lista de graça. Capacidade acrescentada no
-- TypeScript sem a migration reprova o CI sozinha.
create table if not exists public.plano_capacidades (
  plano_id   uuid not null references public.planos(id) on delete cascade,
  capacidade text not null,
  primary key (plano_id, capacidade),
  constraint plano_capacidades_vocabulario check (capacidade in (
    'campanhas', 'voz', 'banco_externo', 'extensoes', 'mcp_e_api',
    'anuncios', 'agenda_google', 'multiplas_conexoes', 'relatorios_avancados'
  ))
);

comment on table public.plano_capacidades is
  'Capacidades que um plano libera (migration 0393). AUSÊNCIA de linha = capacidade NÃO liberada (é uma concessão). Contraste deliberado com plano_limites, onde ausência = sem limite (é uma restrição). Vocabulário espelhado em lib/planos/capacidades.ts.';

-- Os limites numéricos. AUSÊNCIA DE LINHA = SEM LIMITE.
--
-- A assimetria com `plano_capacidades` é intencional e natural: capacidade é
-- CONCESSÃO (sem linha = não tem), limite é RESTRIÇÃO (sem linha = não há teto).
-- Escolhido contra um `ilimitado boolean` com XOR porque um teto ausente já é a
-- forma mais simples de dizer "sem teto", e a coluna extra só criaria um segundo
-- jeito de dizer a mesma coisa — que é como dois leitores discordam.
--
-- `0` é recusado no CHECK: zero não é "sem limite", é "não pode nada", e um zero
-- digitado por engano travaria a organização inteira sem que nenhuma mensagem de
-- erro soubesse dizer por quê.
create table if not exists public.plano_limites (
  plano_id uuid   not null references public.planos(id) on delete cascade,
  limite   text   not null,
  valor    bigint not null,
  primary key (plano_id, limite),
  constraint plano_limites_valor_positivo check (valor > 0),
  constraint plano_limites_vocabulario check (limite in (
    'usuarios', 'conexoes', 'contatos', 'mensagens_por_mes',
    'campanhas_por_mes', 'tokens_de_api', 'agentes'
  ))
);

comment on table public.plano_limites is
  'Tetos numéricos de um plano (migration 0393). AUSÊNCIA de linha = SEM LIMITE. valor > 0 sempre: zero seria "não pode nada" disfarçado de "ilimitado". Vocabulário espelhado em lib/planos/limites.ts.';

alter table public.plano_capacidades enable row level security;
revoke all on public.plano_capacidades from anon, authenticated;
grant select, insert, update, delete on public.plano_capacidades to service_role;

alter table public.plano_limites enable row level security;
revoke all on public.plano_limites from anon, authenticated;
grant select, insert, update, delete on public.plano_limites to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. OS PREÇOS — APPEND-ONLY, PORQUE PREÇO NÃO SE REESCREVE
-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela própria, e não uma coluna `preco_cents` em `planos`, por duas razões
-- que se somam:
--
--   1. O `Price` do provedor de pagamento é IMUTÁVEL por construção — não se
--      muda o valor de um Price criado. Uma coluna que aceita UPDATE
--      divergiria do provedor no primeiro reajuste, e a divergência seria
--      silenciosa.
--   2. Quem já assinou continua no preço que assinou. Subir preço de cliente
--      existente sem novo consentimento não é só deselegante — no Brasil é
--      problema de CDC.
--
-- Então: editar preço na tela = LINHA NOVA + `arquivado_em` na antiga. Nunca um
-- UPDATE em `valor_cents`. Divergência fica impossível porque não há o que
-- divergir, e a tela mostra o histórico em vez de fingir que só existe o atual.

create table if not exists public.plano_precos (
  id              uuid        primary key default gen_random_uuid(),
  plano_id        uuid        not null references public.planos(id) on delete cascade,
  intervalo       text        not null,
  valor_cents     bigint      not null,
  moeda           text        not null default 'BRL',
  -- null = ainda não existe no provedor de pagamento. A liberação manual não
  -- precisa dele, então um preço sem isto é plenamente vendável à mão.
  stripe_price_id text        unique,
  publicado_em    timestamptz,
  arquivado_em    timestamptz,
  created_at      timestamptz not null default now(),
  constraint plano_precos_intervalo   check (intervalo in ('mensal', 'anual')),
  constraint plano_precos_valor       check (valor_cents >= 0),
  constraint plano_precos_moeda_iso   check (moeda ~ '^[A-Z]{3}$'),
  -- ⚠️ A CONSTRAINT QUE IMPEDE OFERECER O QUE NÃO EXISTE.
  --
  -- É a lição do cabeçalho de `orcamento.ts:5-16` em forma de CHECK: lá a tela
  -- editava um campo e o enforcement lia outro, e "quem preenchia a tela
  -- acreditava estar protegido e não estava". Aqui o equivalente seria publicar
  -- um preço cujo objeto de cobrança não existe: a vitrine mostraria o valor, o
  -- checkout estouraria, e quem publicou acreditaria ter publicado.
  --
  -- O valor fica INERTE até existir a coisa que o cobra. Para venda manual, não
  -- publique — grave e venda pela porta do /admin.
  constraint plano_precos_publicado_tem_provedor
    check (publicado_em is null or stripe_price_id is not null)
);

comment on table public.plano_precos is
  'Preços de um plano, APPEND-ONLY (migration 0393). Editar preço cria linha nova e arquiva a antiga; nunca UPDATE em valor_cents — o Price do provedor é imutável e quem já assinou fica no preço que assinou. publicado_em exige stripe_price_id: preço sem objeto de cobrança não é ofertável.';

-- Um preço vigente por (plano, intervalo, moeda). O histórico fica arquivado ao
-- lado; a vitrine só vê o vigente.
create unique index if not exists plano_precos_vigente_idx
  on public.plano_precos (plano_id, intervalo, moeda)
  where arquivado_em is null;

alter table public.plano_precos enable row level security;
revoke all on public.plano_precos from anon, authenticated;
grant select, insert, update, delete on public.plano_precos to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. A ASSINATURA — tenant-aware, uma linha por organização
-- ─────────────────────────────────────────────────────────────────────────────
-- `organization_id` é a PK, não só `unique`: o gate é uma leitura por chave
-- primária e NÃO PODE SER AMBÍGUA. "Qual das três linhas é a vigente?" é
-- exatamente a classe de ambiguidade que faz um enforcement ler o campo errado.
--
-- O histórico vive onde já é append-only por construção: `api_audit_log` (quem
-- mudou o quê — e sem GRANT de UPDATE/DELETE/TRUNCATE nem para `service_role`,
-- migration 0258) e, na fase do provedor de pagamento, as faturas.

create table if not exists public.assinaturas (
  organization_id        uuid        primary key
                                     references public.organizations(id) on delete cascade,
  plano_id               uuid        references public.planos(id) on delete restrict,
  preco_id               uuid        references public.plano_precos(id) on delete restrict,
  situacao               text        not null,
  -- Cópia do que foi CONTRATADO. Não é duplicação sem fonte (anti-pattern 2):
  -- `plano_precos` é append-only, mas o que a cobrança AFIRMA precisa sobreviver
  -- ao arquivamento do preço — senão uma fatura antiga passa a citar outro valor.
  valor_cents            bigint,
  moeda                  text,
  liberado_ate           timestamptz,
  carencia_ate           timestamptz,
  cancelada_em           timestamptz,
  stripe_customer_id     text        unique,
  stripe_subscription_id text        unique,
  -- ⚠️ GUARDA DE ORDEM. O provedor de pagamento NÃO garante ordem de entrega e
  -- reentrega por dias. Sem isto, um evento de assinatura atrasado descancela ou
  -- re-tranca uma conta — em silêncio, porque nada estoura.
  ultimo_evento_em       timestamptz,
  -- A porta manual do dono (Pix por fora, cortesia, webhook que falhou) deixa
  -- rastro na própria linha, além do audit log.
  liberado_por           uuid,
  motivo                 text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint assinaturas_situacao check (situacao in
    ('ativa', 'cortesia', 'inadimplente', 'cancelada', 'expirada')),
  constraint assinaturas_moeda_iso check (moeda is null or moeda ~ '^[A-Z]{3}$')
);

comment on table public.assinaturas is
  'Assinatura vigente de uma organização (migration 0393). PK em organization_id: o gate lê por chave primária e não pode ser ambíguo. FONTE DA VERDADE do acesso; organizations.acesso_liberado_ate é cópia mantida por gatilho. AUSÊNCIA de linha + data no futuro em organizations = teste grátis (estado derivado, nunca gravado).';

create index if not exists assinaturas_situacao_idx
  on public.assinaturas (situacao, liberado_ate);

alter table public.assinaturas enable row level security;

-- LEITURA: qualquer membro. A tela de vencimento precisa explicar o que
-- aconteceu a quem esbarrou nela, e isso inclui quem não é admin.
drop policy if exists tenant_isolation_assinaturas_select on public.assinaturas;
create policy tenant_isolation_assinaturas_select on public.assinaturas
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

-- ESCRITA: NENHUMA POLICY. Só o `service_role`, pela rota — o mesmo desenho que
-- a 0160 deu a `ai_budgets` depois de descobrir que a regra morava só na rota
-- enquanto o PostgREST servia as colunas. Uma organização que pudesse escrever a
-- própria `liberado_ate` pelo PostgREST se liberaria de graça.
-- ⚠️ `revoke all` e não `revoke insert, update, delete`: o ALTER DEFAULT PRIVILEGES
-- deste baseline concede ALL em tabelas a `authenticated`, e ALL inclui TRUNCATE,
-- REFERENCES e TRIGGER. Revogar só os três verbos do DML deixava `authenticated`
-- com TRUNCATE na tabela que decide quem trabalha — medido por
-- tests/invariants/planos-isolamento.test.ts, e é a mesma lição que a 0258 pagou em
-- `api_audit_log`: enumerar o que se concede não protege nada sob o default ACL do
-- Supabase, o que protege é o revoke explícito do que se NÃO quer.
revoke all on public.assinaturas from anon, authenticated;
grant select on public.assinaturas to authenticated;
grant select, insert, update, delete on public.assinaturas to service_role;

-- ═══ O PAGAMENTO — duas tabelas que só o SERVIDOR toca ═══
--
-- `cobranca_checkouts`: cada sessão de pagamento que ESTE produto criou, com a
-- organização de quem pediu. É o que permite resolver "de quem é este pagamento"
-- por DADO NOSSO — o CLAUDE.md manda que a organização venha de fonte confiável e
-- nunca do corpo. O provedor devolve, no evento, o id da sessão; a organização
-- sai daqui. Metadata do payload é conveniência de quem depura, nunca autoridade.
--
-- `cobranca_eventos`: o recibo de cada evento do provedor. `stripe_event_id` como
-- PK é a idempotência (o INSERT duplicado é capturado por `23505`), e
-- `organization_id` é anulável de propósito: um evento cuja organização não se
-- resolve (cliente desconhecido, webhook de teste) é REGISTRADO e marcado
-- `sem_organizacao`, em vez de ser reprocessado a cada tentativa do provedor sem
-- nunca deixar recibo. O CHECK fecha o meio-termo que nenhum leitor sabe
-- interpretar: processado com resultado, ou nem um nem outro.
--
-- Nenhuma das duas guarda dado pessoal do pagador: `resumo` traz só identificadores
-- do provedor, estados e datas — nunca e-mail, nome ou cartão.
--
-- As duas: RLS ligada, ZERO policies e `revoke all` de anon/authenticated. Nem o
-- membro da própria organização lê — é fila do servidor, não dado do cliente.

create table if not exists public.cobranca_checkouts (
  session_id         text        primary key,
  organization_id    uuid        not null references public.organizations(id) on delete cascade,
  plano_id           uuid        references public.planos(id) on delete set null,
  preco_id           uuid        references public.plano_precos(id) on delete set null,
  stripe_customer_id text,
  -- Preenchido quando o provedor confirma a sessão (`checkout.session.completed`). Junto
  -- com `stripe_customer_id`, é o que resolve a organização dos eventos seguintes ANTES
  -- de existir uma linha em `assinaturas` — que só nasce quando há período pago, porque
  -- uma linha sem `liberado_ate` sincronizaria "sem prazo" para a organização.
  stripe_subscription_id text,
  criado_por         uuid,
  created_at         timestamptz not null default now()
);

create index if not exists cobranca_checkouts_org_idx
  on public.cobranca_checkouts (organization_id, created_at desc);

alter table public.cobranca_checkouts enable row level security;
revoke all on public.cobranca_checkouts from anon, authenticated;
grant select, insert, update on public.cobranca_checkouts to service_role;

create table if not exists public.cobranca_eventos (
  stripe_event_id  text        primary key,
  tipo             text        not null,
  stripe_criado_em timestamptz not null,
  organization_id  uuid        references public.organizations(id) on delete set null,
  recebido_em      timestamptz not null default now(),
  processado_em    timestamptz,
  resultado        text,
  erro             text,
  resumo           jsonb       not null default '{}'::jsonb,
  constraint cobranca_eventos_recibo check (
    (processado_em is null and resultado is null) or
    (processado_em is not null and resultado is not null)
  )
);

create index if not exists cobranca_eventos_org_idx
  on public.cobranca_eventos (organization_id, recebido_em desc);

alter table public.cobranca_eventos enable row level security;
revoke all on public.cobranca_eventos from anon, authenticated;
grant select, insert, update on public.cobranca_eventos to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. AS DUAS COLUNAS DO GATE, EM `organizations`
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.organizations
  add column if not exists acesso_liberado_ate timestamptz,
  add column if not exists plano_id uuid references public.planos(id) on delete set null;

comment on column public.organizations.acesso_liberado_ate is
  'Até quando esta organização trabalha (migration 0393). NULL = SEM PRAZO, nunca "vencido" — organização que já existia quando a cobrança entrou não perde acesso por atualizar, e null é também como se marca "esta não vence nunca". Cópia de assinaturas.liberado_ate mantida por gatilho; o gate lê daqui porque roda em toda requisição.';

-- Nenhum backfill de data: as organizações existentes ficam com `null`, que é
-- "sem prazo". É a única leitura que não transforma um `update.sh` em perda de
-- acesso de quem já pagava. Ver o cabeçalho.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. AS CASCAS MORTAS QUE PRECISAM PARAR DE PARECER VIVAS
-- ─────────────────────────────────────────────────────────────────────────────
-- Três colunas que parecem ser disto e não são lidas por NADA:
-- `settings.plan` (standard|pro|enterprise, gravado por
-- fn_create_tenant_with_owner), `rate_limit_rps` (default 100) e
-- `ai_budget_cents`. São a armadilha nº 1 deste trabalho: uma sessão futura vai
-- "ligar" o campo que já parece existir, e o enforcement passará a ler um campo
-- que a tela nova não escreve — o defeito do `orcamento.ts` reencenado.
--
-- Não são REMOVIDAS: o `update.sh` do clone roda SEM `ON_ERROR_STOP`, e derrubar
-- coluna é dívida com quem clonou. Ficam marcadas, e uma cerca em
-- `tests/unit/planos-nao-leem-a-casca-morta.test.ts` reprova leitor novo.

comment on column public.organizations.rate_limit_rps is
  'MORTA (migration 0393): zero leitores no produto. Não é limite de plano — quem limita plano é plano_limites. Não ligue esta coluna.';

comment on column public.organizations.ai_budget_cents is
  'MORTA (migration 0393): zero leitores. Precursor abandonado de ai_budgets.monthly_limit_cents, que é quem vale. O gasto de IA é governado por ai_budgets, por organização; teto de gasto por PLANO não existe (ver docs/adr/0004).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. OS KNOBS DA INSTALAÇÃO
-- ─────────────────────────────────────────────────────────────────────────────
-- `on conflict do nothing`: a reaplicação do baseline a cada `update.sh` nunca
-- reescreve a escolha de quem já mexeu na tela.
--
-- COBRANCA_LIGADA nasce `desligado` e só o valor `ligado` liga — a régua de
-- `lib/instalacao/modulos.ts:23-29`: linha ausente, outro valor, ou banco que não
-- respondeu = desligado. Falha fechada para o MECANISMO (não vende por acidente)
-- e, por consequência, aberta para o USUÁRIO (ninguém é trancado por acidente).

insert into public.platform_config (chave, valor, eh_segredo, semeado_do_env)
values
  ('COBRANCA_LIGADA',  'desligado', false, false),
  ('DIAS_DE_TESTE',    '14',        false, false),
  ('CARENCIA_DIAS',    '5',         false, false),
  -- O que acontece quando um TETO do plano é atingido: off | avisar | bloquear.
  -- Nasce `avisar`: ninguém é bloqueado sem antes ter sido avisado (mesma escada
  -- de `ai_budgets.enforcement_mode`, que nasce `off` pelo mesmo motivo).
  ('LIMITES_MODO',     'avisar',    false, false)
on conflict (chave) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. O TESTE GRÁTIS NASCE POR GATILHO, NÃO POR CÓDIGO DE APLICAÇÃO
-- ─────────────────────────────────────────────────────────────────────────────
-- QUATRO caminhos criam organização hoje — `ensureTenantForUser`
-- (lib/auth/provision.ts:86), `provisionExternalTenant` (:224),
-- `fn_create_tenant_with_owner` (via POST /api/v1/admin/tenants) e
-- `scripts/bootstrap-owner.ts` (o que o install.sh faz) — e o quinto vai nascer
-- sem ninguém avisar. Um gatilho cobre os quatro de graça e não deixa o quinto
-- nascer errado.
--
-- `security definer` porque lê `platform_config`, revogada de `authenticated`.
-- Não é porta de adulteração: não tem seletor de linha, não recebe parâmetro
-- nenhum, não é alcançável pela REST, e o único efeito é preencher uma coluna da
-- linha que está sendo inserida.

create or replace function public.fn_definir_teste_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias   integer;
  v_ligada text;
begin
  -- Quem passou a data explicitamente manda: o /admin criando organização já
  -- liberada, e a restauração de um backup, não são casos de teste grátis.
  if new.acesso_liberado_ate is not null then
    return new;
  end if;

  -- ⚠️ O TESTE SÓ COMEÇA COM A COBRANÇA LIGADA.
  --
  -- Sem esta guarda, toda organização criada ANTES de a cobrança ser ligada
  -- nasceria com um prazo de 14 dias que ninguém pediu — e no dia em que o dono
  -- ligasse `COBRANCA_LIGADA`, todas as que já passaram de 14 dias seriam
  -- trancadas de uma vez: a sua própria, as de teste, as de cliente que ele
  -- atendia de graça. É o mesmo "parque trancando" que `null = sem prazo` evita
  -- para as organizações anteriores a esta migration, e ele não pode reaparecer
  -- pela porta dos fundos das criadas depois dela.
  --
  -- Então: cobrança desligada => a organização nasce SEM PRAZO. É o que já
  -- vale para as existentes, e é o que faz o momento de ligar a cobrança ser
  -- uma decisão do dono e não um efeito colateral de quando ele instalou.
  begin
    select valor into v_ligada from public.platform_config where chave = 'COBRANCA_LIGADA';
  exception
    when others then
      v_ligada := null;
  end;
  if v_ligada is distinct from 'ligado' then
    return new;
  end if;

  begin
    select nullif(trim(valor), '')::integer
      into v_dias
      from public.platform_config
     where chave = 'DIAS_DE_TESTE';
  exception
    -- `valor` não numérico. O padrão do produto é melhor desfecho que uma
    -- organização que não nasce.
    when others then
      v_dias := null;
  end;

  if v_dias is null or v_dias <= 0 or v_dias > 3650 then
    v_dias := 14;
  end if;

  new.acesso_liberado_ate := now() + make_interval(days => v_dias);
  return new;
end;
$$;

revoke execute on function public.fn_definir_teste_da_organizacao() from public, anon, authenticated;

drop trigger if exists trg_organizations_teste_gratis on public.organizations;
create trigger trg_organizations_teste_gratis
  before insert on public.organizations
  for each row execute function public.fn_definir_teste_da_organizacao();

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. A SINCRONIA ASSINATURA → ORGANIZAÇÃO
-- ─────────────────────────────────────────────────────────────────────────────
-- Gatilho, na mesma transação. Cron aqui seria o anti-pattern 5 do CLAUDE.md e,
-- pior, um cliente que pagou esperaria o próximo tique para voltar a trabalhar.
--
-- `is distinct from` antes de escrever: sem isso, um UPDATE em `assinaturas` que
-- não mexeu no prazo ainda escreveria `organizations`, e o `updated_at` da
-- organização passaria a mentir sobre quando ela mudou.

create or replace function public.fn_sincronizar_acesso_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.organizations o
     set acesso_liberado_ate = new.liberado_ate,
         plano_id            = new.plano_id
   where o.id = new.organization_id
     and (o.acesso_liberado_ate is distinct from new.liberado_ate
       or o.plano_id            is distinct from new.plano_id);
  return null;
end;
$$;

revoke execute on function public.fn_sincronizar_acesso_da_organizacao() from public, anon, authenticated;

drop trigger if exists trg_assinaturas_sincroniza_acesso on public.assinaturas;
create trigger trg_assinaturas_sincroniza_acesso
  after insert or update of liberado_ate, plano_id on public.assinaturas
  for each row execute function public.fn_sincronizar_acesso_da_organizacao();

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. `updated_at` das tabelas novas
-- ─────────────────────────────────────────────────────────────────────────────

drop trigger if exists trg_planos_touch on public.planos;
create trigger trg_planos_touch
  before update on public.planos
  for each row execute function public.fn_touch_updated_at();

drop trigger if exists trg_assinaturas_touch on public.assinaturas;
create trigger trg_assinaturas_touch
  before update on public.assinaturas
  for each row execute function public.fn_touch_updated_at();

notify pgrst, 'reload schema';
