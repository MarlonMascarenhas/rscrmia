#!/usr/bin/env bash
# Migra uma instalação que usa o Supabase NA NUVEM para o modo single-server
# (Supabase self-hosted na MESMA VPS, o que install-single-server.sh instala),
# copiando os dados, conferindo e voltando sozinha se algo falhar.
#
#   bash hostgator-setup-kit/migrar-da-nuvem.sh --dry-run            # só olha a nuvem e conta
#   bash hostgator-setup-kit/migrar-da-nuvem.sh                      # migra
#   bash hostgator-setup-kit/migrar-da-nuvem.sh --somente-arquivos   # retoma a cópia dos anexos
#   bash hostgator-setup-kit/migrar-da-nuvem.sh --voltar             # volta para a nuvem
#
# Roda como root, na pasta do projeto. NADA é apagado na nuvem: o projeto de lá
# fica intacto e é a rede de segurança. O passo a passo, o que esperar e o que
# ainda precisa ser confirmado num ensaio estão em
# docs/runbooks/migrar-supabase-nuvem-para-vps.md.
#
# Por que este arquivo NÃO é só "rode install-single-server.sh": o install.sh que
# ele chama regrava as imagens do .env (APP_IMAGE/WORKER_IMAGE/SCHEDULER_IMAGE
# para ghcr.io/...:<tag do app> e pull_policy `missing`), faz `docker compose
# pull`, e o bootstrap cria um dono e uma organização novos. Numa instalação
# cujas imagens foram construídas aqui (`deskcomm-app:local`), isso desfaz o
# fork; e o bootstrap sujaria o banco que vai receber os dados. Cada um desses
# três pontos é tratado abaixo (passos 5, 6 e 7).

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
KIT_DIR="$ROOT_DIR/hostgator-setup-kit"
RUNTIME_DIR="$ROOT_DIR/.runtime"
ESTADO_DIR="$RUNTIME_DIR/migracao"
ESTADO_ENV="$ESTADO_DIR/estado.env"
ENV_NUVEM="$ROOT_DIR/.env.nuvem"
ENV_SINGLE="$ESTADO_DIR/env.single-server"
HDR_NUVEM="$ESTADO_DIR/nuvem.hdr"
HDR_LOCAL="$ESTADO_DIR/local.hdr"

# shellcheck source=_common.sh
source "$KIT_DIR/_common.sh"
# shellcheck disable=SC2034  # lido pelas funções do _common.sh
PROJECT_DIR="$ROOT_DIR"

PG_IMAGE="postgres:17-alpine"
BUCKET_MIDIA="whatsapp-media"
PODA_MANTER=100          # o piso mora no corpo de fn_mensagens_excedentes (migration 0396)
PODA_LOTE=1000
SWAP_ARQUIVO="${SWAP_ARQUIVO:-/swapfile}"
SWAP_GB=4

LOCAL_URL=""             # conexão do Postgres local escolhida no passo 7
VOLTA_ARMADA=0
MIGRACAO_CONCLUIDA=0

usage() {
  cat <<'EOF'
Uso: bash hostgator-setup-kit/migrar-da-nuvem.sh [opção]

Migra o banco e os anexos do Supabase na nuvem para o Supabase instalado nesta
mesma VPS (modo single-server). Sem opção, faz a migração inteira.

  --dry-run            só confere a nuvem e conta o que seria copiado; não muda nada
  --somente-arquivos   retoma a cópia dos anexos (passo 10) de uma migração que parou
  --voltar             volta para o Supabase da nuvem (restaura o .env de antes)
  --sim                dispensa a pergunta do --voltar (para uso sem terminal)
  -h, --help           mostra esta ajuda

O projeto da nuvem nunca é alterado nem apagado.
EOF
}

# ── Estado e utilidades ──────────────────────────────────────────────────────
preparar_pasta_de_estado() {
  mkdir -p "$ESTADO_DIR"
  chmod 700 "$RUNTIME_DIR" "$ESTADO_DIR" 2>/dev/null || true
  [ -f "$ESTADO_ENV" ] || ( umask 077; : > "$ESTADO_ENV" )
}

gravar_estado() { set_env_var "$ESTADO_ENV" "$1" "$2"; }

# Cabeçalhos num arquivo (curl -H @arquivo): a chave NUNCA vai na linha de
# comando nem na URL.
escrever_cabecalho() {  # escrever_cabecalho <arquivo> <chave>
  ( umask 077; printf 'apikey: %s\nAuthorization: Bearer %s\n' "$2" "$2" > "$1" )
}

remover_var_env() {  # remover_var_env <arquivo> <chave>
  local tmp="$1.tmp.$$"
  { grep -vE "^$2=" "$1" || true; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$1"
}

# Copia a linha CRUA (com as aspas e escapes do envq) de um .env para outro.
copiar_linha_env() {  # copiar_linha_env <de> <para> <chave>
  local linha
  linha="$({ grep -E "^$3=" "$1" || true; } | tail -1)"
  remover_var_env "$2" "$3"
  [ -z "$linha" ] || printf '%s\n' "$linha" >> "$2"
}

codificar_caminho() {  # codifica cada trecho do caminho do objeto para a URL
  jq -rn --arg p "$1" '$p | split("/") | map(@uri) | join("/")'
}

# ── Acesso aos dois bancos ───────────────────────────────────────────────────
# A nuvem NUNCA passa por pg_container: depois do passo 6 o .env tem
# PSQL_DOCKER_NETWORK, e o psql da nuvem precisa sair pela internet, não pela
# rede privada do Supabase local.
psql_nuvem() {
  docker run --rm -e PGCONNECT_TIMEOUT=20 "$PG_IMAGE" psql "$NUVEM_DB_URL" -X -v ON_ERROR_STOP=1 "$@"
}
psql_local_q() {
  pg_container -e PGCONNECT_TIMEOUT=20 "$PG_IMAGE" psql "$LOCAL_URL" -X -v ON_ERROR_STOP=1 "$@"
}
psql_local_stdin() {  # igual, mas lê o dado da entrada padrão
  pg_container -i -e PGCONNECT_TIMEOUT=20 "$PG_IMAGE" psql "$LOCAL_URL" -X -v ON_ERROR_STOP=1 "$@"
}

# ── Colunas: a interseção entre a nuvem e o local ────────────────────────────
# Coluna GERADA fica de fora dos dois lados (o banco calcula; inserir nela erra).
colunas_gravaveis() {  # colunas_gravaveis <nuvem|local> <schema> <tabela>
  local sql="select column_name from information_schema.columns where table_schema = '$2' and table_name = '$3' and is_generated = 'NEVER' order by ordinal_position"
  case "$1" in
    nuvem) psql_nuvem -tAq -c "$sql" ;;
    *)     psql_local_q -tAq -c "$sql" ;;
  esac
}

# Colunas de A (na ordem de A) que também existem em B. Uma por linha.
colunas_em_comum() {  # colunas_em_comum <lista A> <lista B>
  awk 'NR == FNR { if (NF) b[$0] = 1; next } NF && ($0 in b)' \
    <(printf '%s\n' "$2") <(printf '%s\n' "$1")
}

lista_sql_colunas() {  # uma coluna por linha → "a","b","c"
  awk 'NF { gsub(/"/, "\"\""); printf "%s\"%s\"", (n++ ? "," : ""), $0 } END { printf "\n" }' <<<"$1"
}

# ── Contagens exatas, uma consulta só ────────────────────────────────────────
sql_contagens() {  # sql_contagens <schema> <arquivo de tabelas>
  awk -v s="$1" 'NF { n = $0; gsub(/"/, "\"\"", n)
      q = q (q ? " union all " : "") "select \047" s "." $0 "\047::text as t, count(*)::bigint as n from " s ".\"" n "\"" }
    END { if (q) print q " order by 1" }' "$2"
}

contagens_de() {  # contagens_de <nuvem|local> <schema> <arquivo de tabelas> → tabela<TAB>n
  local sql
  sql="$(sql_contagens "$2" "$3")"
  [ -n "$sql" ] || return 0
  case "$1" in
    nuvem) psql_nuvem -tAq -F $'\t' -c "$sql" ;;
    *)     psql_local_q -tAq -F $'\t' -c "$sql" ;;
  esac
}

# ── Passo 1: pré-checagem ────────────────────────────────────────────────────
garantir_swap() {
  if [ -n "$(swapon --show --noheadings 2>/dev/null || true)" ]; then
    c_grn "✓ A VPS já tem swap"
    return 0
  fi
  c_ylw "• A VPS não tem swap. Vou criar ${SWAP_GB} GB em $SWAP_ARQUIVO (o Supabase local + a cópia pedem folga de memória)."
  if [ ! -f "$SWAP_ARQUIVO" ]; then
    fallocate -l "${SWAP_GB}G" "$SWAP_ARQUIVO" 2>/dev/null \
      || dd if=/dev/zero of="$SWAP_ARQUIVO" bs=1M count=$((SWAP_GB * 1024)) status=none
    chmod 600 "$SWAP_ARQUIVO"
    mkswap "$SWAP_ARQUIVO" >/dev/null
  fi
  swapon "$SWAP_ARQUIVO"
  grep -qsE "^${SWAP_ARQUIVO}[[:space:]]" /etc/fstab \
    || printf '%s none swap sw 0 0\n' "$SWAP_ARQUIVO" >> /etc/fstab
  c_grn "✓ Swap de ${SWAP_GB} GB criado e ligado (e registrado no /etc/fstab)"
}

imagem_em_execucao() {  # imagem_em_execucao <serviço> → a imagem do contêiner que está no ar
  local id
  id="$(dc ps -q "$1" 2>/dev/null | head -1 || true)"
  [ -n "$id" ] || return 0
  docker inspect "$id" --format '{{.Config.Image}}' 2>/dev/null || true
}

precheck() {  # precheck <dry-run: 0|1>
  local dry="$1" faltando="" v codigo err
  step "[1/12] Conferindo se dá para migrar"
  [ "$(id -u)" -eq 0 ] || die "Rode como root (sudo bash hostgator-setup-kit/migrar-da-nuvem.sh)."
  cd "$ROOT_DIR"
  [ -f "$COMPOSE" ] || die "Não achei $COMPOSE em $ROOT_DIR. Rode a partir da pasta do projeto."
  [ -f .env ] || die "Não achei o .env em $ROOT_DIR."
  for v in docker curl jq; do
    command -v "$v" >/dev/null 2>&1 || die "Preciso do '$v' instalado."
  done
  docker info >/dev/null 2>&1 || die "Não consegui falar com o Docker."

  load_env .env
  if [ "${SINGLE_SERVER:-0}" = "1" ]; then
    die "Este .env já está em modo single-server. Se uma migração parou no meio, use --voltar (volta para a nuvem) ou --somente-arquivos (retoma os anexos)."
  fi
  for v in DOMAIN SUPABASE_DB_URL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
    [ -n "${!v:-}" ] || faltando="$faltando $v"
  done
  [ -z "$faltando" ] || die "Faltam no .env as variáveis da nuvem:${faltando}."
  case "$NEXT_PUBLIC_SUPABASE_URL" in
    "https://${DOMAIN}"|"https://${DOMAIN}/") die "NEXT_PUBLIC_SUPABASE_URL já aponta para $DOMAIN: esta instalação não usa a nuvem." ;;
  esac
  if [ -f "$ENV_NUVEM" ] && ! cmp -s .env "$ENV_NUVEM"; then
    die "Já existe $ENV_NUVEM e ele é DIFERENTE do .env atual. Confira os dois (um guarda a volta de uma tentativa anterior) e renomeie o que não vale."
  fi

  # Guarda a nuvem em variáveis próprias e tira do ambiente o que não pode vazar
  # para o instalador: SUPABASE_DB_ADMIN_URL apontaria o baseline para a nuvem.
  NUVEM_DB_URL="${SUPABASE_DB_ADMIN_URL:-$SUPABASE_DB_URL}"
  NUVEM_URL="${NEXT_PUBLIC_SUPABASE_URL%/}"
  NUVEM_SERVICE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
  unset SUPABASE_DB_ADMIN_URL SUPABASE_ACCESS_TOKEN

  preparar_pasta_de_estado
  escrever_cabecalho "$HDR_NUVEM" "$NUVEM_SERVICE_KEY"

  c_dim "  Testando o banco da nuvem (até 90 s)..."
  err="$ESTADO_DIR/precheck-psql.err"
  if ! [ "$(timeout 90 docker run --rm -e PGCONNECT_TIMEOUT=20 "$PG_IMAGE" psql "$NUVEM_DB_URL" -X -tAq -c 'select 1' 2>"$err" || true)" = "1" ]; then
    c_red "  $(tail -n 3 "$err" 2>/dev/null | tr '\n' ' ')"
    die "A nuvem não respondeu. Nada foi alterado: reanime o projeto no painel do Supabase (projeto do plano grátis pausa sozinho) e rode de novo."
  fi
  c_grn "✓ Banco da nuvem respondeu"

  codigo="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -H @"$HDR_NUVEM" "$NUVEM_URL/rest/v1/" 2>/dev/null || true)"
  case "$codigo" in
    2*) c_grn "✓ API da nuvem (REST) respondeu" ;;
    *)  die "A API REST da nuvem respondeu '${codigo:-sem resposta}' (esperava 200). Nada foi alterado. Confira se o projeto está ativo no painel do Supabase." ;;
  esac

  IMG_APP_RODANDO="$(imagem_em_execucao app)"
  IMG_WORKER_RODANDO="$(imagem_em_execucao worker)"
  IMG_SCHEDULER_RODANDO="$(imagem_em_execucao scheduler)"
  c_dim "  Imagens em execução: app=${IMG_APP_RODANDO:-?} worker=${IMG_WORKER_RODANDO:-?} scheduler=${IMG_SCHEDULER_RODANDO:-?}"
  if [ -n "$IMG_APP_RODANDO" ]; then
    case "$(tag_da_imagem "$IMG_APP_RODANDO")" in
      latest|main|stable|"")
        die "A imagem do app em execução ($IMG_APP_RODANDO) tem tag móvel ou sem tag: o install.sh faria pull dela e trocaria o seu código. Dê a ela uma tag fixa (docker tag $IMG_APP_RODANDO deskcomm-app:local), recrie o app com ela e rode de novo." ;;
    esac
  fi

  if [ "$dry" = 1 ]; then
    if [ -z "$(swapon --show --noheadings 2>/dev/null || true)" ]; then
      c_ylw "• Sem swap nesta VPS: a migração criaria ${SWAP_GB} GB em $SWAP_ARQUIVO."
    else
      c_grn "✓ A VPS já tem swap"
    fi
  else
    garantir_swap
  fi
}

# ── Passo 2: salva a volta ───────────────────────────────────────────────────
salvar_a_volta() {
  step "[2/12] Guardando a volta (cópia do .env e das variáveis da nuvem)"
  if [ -f "$ENV_NUVEM" ]; then
    c_dim "  $ENV_NUVEM já existe e é igual ao .env: mantido."
  else
    cp -p .env "$ENV_NUVEM"
    chmod 600 "$ENV_NUVEM"
    c_grn "✓ .env guardado em $ENV_NUVEM"
  fi
  gravar_estado NUVEM_DB_URL "$NUVEM_DB_URL"
  gravar_estado NUVEM_URL "$NUVEM_URL"
  gravar_estado NUVEM_SERVICE_KEY "$NUVEM_SERVICE_KEY"
  gravar_estado MIGRACAO_DOMINIO "$DOMAIN"
  gravar_estado IMG_APP_RODANDO "$IMG_APP_RODANDO"
  gravar_estado IMG_WORKER_RODANDO "$IMG_WORKER_RODANDO"
  gravar_estado IMG_SCHEDULER_RODANDO "$IMG_SCHEDULER_RODANDO"
  gravar_estado ESTADO_CONCLUIDA 0
  c_grn "✓ Variáveis da nuvem guardadas em $ESTADO_ENV"
}

# ── Passo 3: para o CRM ──────────────────────────────────────────────────────
parar_crm() {
  step "[3/12] Parando o CRM (app, worker, scheduler) — o site fica fora do ar até o passo 12"
  dc stop app worker scheduler
  c_grn "✓ CRM parado"
}

# ── Passo 4: exporta da nuvem ────────────────────────────────────────────────
exportar_da_nuvem() {
  local chave_nuvem chave_env
  step "[4/12] Lendo a nuvem: tabelas, contagens exatas, usuários e buckets"
  psql_nuvem -tAq -c "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1" \
    > "$ESTADO_DIR/tabelas-public.txt"
  psql_nuvem -tAq -c "select table_name from information_schema.tables
    where table_schema = 'auth' and table_name in ('users', 'identities') order by 1" \
    > "$ESTADO_DIR/tabelas-auth.txt"
  [ -s "$ESTADO_DIR/tabelas-public.txt" ] || die "A nuvem não devolveu nenhuma tabela em public: não é um banco do DeskcommCRM?"
  grep -qx users "$ESTADO_DIR/tabelas-auth.txt" || die "A nuvem não tem auth.users."

  { contagens_de nuvem auth "$ESTADO_DIR/tabelas-auth.txt"
    contagens_de nuvem public "$ESTADO_DIR/tabelas-public.txt"; } > "$ESTADO_DIR/contagens-nuvem.tsv"

  psql_nuvem -tAq -F $'\t' -c "select id, name, public, coalesce(file_size_limit::text, '') from storage.buckets order by name" \
    > "$ESTADO_DIR/buckets-nuvem.tsv"
  cut -f1 "$ESTADO_DIR/buckets-nuvem.tsv" > "$ESTADO_DIR/buckets-nuvem.txt"
  # Só para o relatório: se a leitura de storage.objects não for permitida, a
  # migração segue (a cópia dos anexos lista pela API).
  psql_nuvem -tAq -F $'\t' -c "select bucket_id, count(*), coalesce(sum((metadata->>'size')::bigint), 0)
    from storage.objects group by 1 order by 1" > "$ESTADO_DIR/objetos-nuvem.tsv" 2>/dev/null \
    || { : > "$ESTADO_DIR/objetos-nuvem.tsv"; c_ylw "  (não consegui somar os anexos por SQL; sigo — a cópia lista pela API)"; }

  # A chave que cifra os segredos de webhook mora no banco (private.app_secrets) e
  # o .env a repete (ensure_encryption_key reaproveita a do .env). Se as duas
  # divergirem, o que está CIFRADO no banco só abre com a do banco da nuvem.
  chave_nuvem="$(psql_nuvem -tAq -c "select value from private.app_secrets where name = 'nuvemshop_oauth_key'" 2>/dev/null || true)"
  chave_env="${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:-}"
  if [ -n "$chave_nuvem" ] && [ "$chave_nuvem" != "$chave_env" ]; then
    c_ylw "• A chave de cifra dos segredos no banco da nuvem difere da do .env. Uso a do banco (é a que cifrou os dados)."
    gravar_estado CHAVE_CIFRA_NUVEM "$chave_nuvem"
  else
    gravar_estado CHAVE_CIFRA_NUVEM ""
  fi

  relatorio_da_nuvem
}

relatorio_da_nuvem() {
  local tabelas linhas usuarios buckets
  tabelas="$(grep -c . "$ESTADO_DIR/tabelas-public.txt" || true)"
  linhas="$(awk -F'\t' '$1 ~ /^public\./ { s += $2 } END { print s + 0 }' "$ESTADO_DIR/contagens-nuvem.tsv")"
  usuarios="$(awk -F'\t' '$1 == "auth.users" { print $2 }' "$ESTADO_DIR/contagens-nuvem.tsv")"
  buckets="$(grep -c . "$ESTADO_DIR/buckets-nuvem.txt" || true)"
  printf '\n  Tabelas em public ............ %s\n  Linhas em public (total) ..... %s\n  Usuários (auth.users) ........ %s\n  Buckets de arquivos .......... %s\n' \
    "$tabelas" "$linhas" "${usuarios:-0}" "$buckets"
  awk -F'\t' '{ printf "    bucket %-22s %6s objetos  %8.1f MB\n", $1, $2, $3 / 1048576 }' "$ESTADO_DIR/objetos-nuvem.tsv"
  printf '  Mensagens (messages) ......... %s\n' "$(awk -F'\t' '$1 == "public.messages" { print $2 }' "$ESTADO_DIR/contagens-nuvem.tsv")"
  c_dim "  Arquivos de apoio em $ESTADO_DIR"
}

# ── Passo 5: .env pronto para o single-server, sem perder nada ───────────────
preparar_env() {
  local v tag chave_cifra
  step "[5/12] Preparando o .env (sem perder imagens, chaves nem dono)"
  # O install.sh ficaria com a SUPABASE_DB_ADMIN_URL da nuvem e aplicaria o
  # baseline lá. Sai do .env (a cópia fica em .env.nuvem).
  remover_var_env .env SUPABASE_DB_ADMIN_URL
  set_env_var .env REVERSE_PROXY caddy

  # Imagens: as que RODAM, não as que o .env diz. O install.sh regrava
  # WORKER_IMAGE/SCHEDULER_IMAGE como ghcr.io/...:<tag do app> e `missing`;
  # sem estas etiquetas ele não acharia imagem no disco e puxaria/construiria.
  IMAGENS_LOCAIS=0
  if [ -n "$IMG_APP_RODANDO" ] && docker image inspect "$IMG_APP_RODANDO" >/dev/null 2>&1; then
    IMAGENS_LOCAIS=1
    tag="$(tag_da_imagem "$IMG_APP_RODANDO")"
    set_env_var .env APP_IMAGE "$IMG_APP_RODANDO"
    set_env_var .env APP_PULL_POLICY never
    if [ -n "$IMG_WORKER_RODANDO" ] && docker image inspect "$IMG_WORKER_RODANDO" >/dev/null 2>&1; then
      set_env_var .env WORKER_IMAGE "$IMG_WORKER_RODANDO"
      set_env_var .env WORKER_PULL_POLICY never
      docker tag "$IMG_WORKER_RODANDO" "${IMG_WORKER}:${tag}"
    fi
    if [ -n "$IMG_SCHEDULER_RODANDO" ] && docker image inspect "$IMG_SCHEDULER_RODANDO" >/dev/null 2>&1; then
      set_env_var .env SCHEDULER_IMAGE "$IMG_SCHEDULER_RODANDO"
      set_env_var .env SCHEDULER_PULL_POLICY never
      docker tag "$IMG_SCHEDULER_RODANDO" "${IMG_SCHEDULER}:${tag}"
    fi
    c_grn "✓ Imagens em execução fixadas no .env com pull_policy=never (o fork não é trocado pelo upstream)"
  else
    c_ylw "• Não achei imagem local do app em execução: o instalador usará o que o .env já diz."
  fi

  load_env "$ESTADO_ENV"
  chave_cifra="${CHAVE_CIFRA_NUVEM:-}"
  if [ -n "$chave_cifra" ]; then
    set_env_var .env NUVEMSHOP_OAUTH_ENCRYPTION_KEY "$chave_cifra"
    c_grn "✓ Chave de cifra dos segredos igualada à do banco da nuvem"
  fi
  c_grn "✓ .env preparado"
}

# Imagens e dono voltam ao que eram depois que o install.sh passou por cima.
reafirmar_env_apos_instalar() {
  local chave
  if [ "${IMAGENS_LOCAIS:-0}" = 1 ]; then
    [ -z "$IMG_APP_RODANDO" ] || { set_env_var .env APP_IMAGE "$IMG_APP_RODANDO"; set_env_var .env APP_PULL_POLICY never; }
    [ -z "$IMG_WORKER_RODANDO" ] || { set_env_var .env WORKER_IMAGE "$IMG_WORKER_RODANDO"; set_env_var .env WORKER_PULL_POLICY never; }
    [ -z "$IMG_SCHEDULER_RODANDO" ] || { set_env_var .env SCHEDULER_IMAGE "$IMG_SCHEDULER_RODANDO"; set_env_var .env SCHEDULER_PULL_POLICY never; }
  fi
  # O install-single-server grava o dono de bootstrap (admin@dominio). Ele será
  # apagado no passo 7; o .env volta a ter o dono REAL de antes.
  for chave in OWNER_EMAIL OWNER_PASSWORD; do
    copiar_linha_env "$ENV_NUVEM" .env "$chave"
  done
  chmod 600 .env
}

# ── Passo 6: instala o Supabase local ────────────────────────────────────────
instalar_supabase_local() {
  local -a limpo
  step "[6/12] Instalando o Supabase nesta VPS (install-single-server.sh) — leva alguns minutos"
  # Ambiente LIMPO: nada da nuvem herdado (SUPABASE_DB_ADMIN_URL, token). O
  # instalador relê o .env sozinho.
  limpo=(env -i PATH="$PATH" HOME="${HOME:-/root}" TERM="${TERM:-dumb}" LANG="${LANG:-C.UTF-8}")
  [ -z "${DOCKER_HOST:-}" ] || limpo+=("DOCKER_HOST=$DOCKER_HOST")
  [ -z "${DOCKER_CONTEXT:-}" ] || limpo+=("DOCKER_CONTEXT=$DOCKER_CONTEXT")
  [ -z "${DOCKER_CONFIG:-}" ] || limpo+=("DOCKER_CONFIG=$DOCKER_CONFIG")
  "${limpo[@]}" bash "$KIT_DIR/install-single-server.sh" --domain "$DOMAIN"

  load_env .env
  [ "${SINGLE_SERVER:-0}" = "1" ] || die "O instalador terminou mas o .env não ficou em SINGLE_SERVER=1."
  reafirmar_env_apos_instalar
  load_env .env
  cp -p .env "$ENV_SINGLE"
  chmod 600 "$ENV_SINGLE"
  escrever_cabecalho "$HDR_LOCAL" "$SUPABASE_SERVICE_ROLE_KEY"
  # O install.sh deixou o CRM subindo sobre o banco vazio: para antes de copiar.
  dc stop app worker scheduler
  c_grn "✓ Supabase local no ar; CRM parado de novo até os dados chegarem"
}

# ── Passo 7: copia os dados ──────────────────────────────────────────────────
# O role `postgres` do Supabase self-hosted pode não ter permissão para
# session_replication_role nem para escrever em auth.*: o repositório não diz
# (o setup.sh oficial está fora dele). Em vez de supor, sonda os dois candidatos.
SONDA_PERMISSOES="begin; set session_replication_role = replica;
  delete from auth.users where false; delete from auth.identities where false;
  insert into auth.users (id) select id from auth.users where false;
  insert into auth.identities (id) select id from auth.identities where false; rollback;"

escolher_conexao_local() {
  local url_pg url_adm cand
  url_pg="$SUPABASE_DB_URL"
  url_adm="$(printf '%s' "$url_pg" | sed -E 's#^(postgres(ql)?://)[^:@/]+:#\1supabase_admin:#')"
  for cand in "$url_pg" "$url_adm"; do
    LOCAL_URL="$cand"
    if psql_local_q -q -c "$SONDA_PERMISSOES" >/dev/null 2>&1; then
      if [ "$cand" = "$url_pg" ]; then
        c_grn "✓ O usuário 'postgres' do Supabase local pode copiar (session_replication_role e auth.*)"
      else
        c_grn "✓ O usuário 'postgres' não pode copiar; usando 'supabase_admin' com a mesma senha do banco"
      fi
      return 0
    fi
  done
  die "Nem 'postgres' nem 'supabase_admin' (com a senha do banco local) têm permissão para copiar os dados. Veja 'a confirmar no ensaio' em docs/runbooks/migrar-supabase-nuvem-para-vps.md."
}

limpar_destino() {
  local lista
  psql_local_q -tAq -c "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1" \
    > "$ESTADO_DIR/tabelas-public-local.txt"
  comm -12 <(sort "$ESTADO_DIR/tabelas-public.txt") <(sort "$ESTADO_DIR/tabelas-public-local.txt") \
    > "$ESTADO_DIR/tabelas-public-comuns.txt"
  comm -23 <(sort "$ESTADO_DIR/tabelas-public.txt") <(sort "$ESTADO_DIR/tabelas-public-local.txt") \
    > "$ESTADO_DIR/tabelas-so-na-nuvem.txt"
  if [ -s "$ESTADO_DIR/tabelas-so-na-nuvem.txt" ]; then
    c_ylw "• Tabelas que existem na nuvem e NÃO existem no local (não serão copiadas): $(tr '\n' ' ' < "$ESTADO_DIR/tabelas-so-na-nuvem.txt")"
  fi
  lista="$(awk 'NF { n = $0; gsub(/"/, "\"\"", n); printf "%spublic.\"%s\"", (c++ ? ", " : ""), n }' "$ESTADO_DIR/tabelas-public-comuns.txt")"
  [ -n "$lista" ] || die "Nenhuma tabela de public em comum entre a nuvem e o local."
  psql_local_q -q -c "truncate table ${lista} cascade"
  # Fora do modo replica de propósito: os FKs do GoTrue precisam cascatear
  # (identities, sessions do usuário do bootstrap).
  psql_local_q -q -c "delete from auth.users"
  c_grn "✓ Destino limpo (o que o bootstrap criou foi removido)"
}

copiar_tabela() {  # copiar_tabela <schema> <tabela>
  local s="$1" t="$2" cn cl comuns lista
  [[ "$t" =~ ^[A-Za-z0-9_]+$ ]] || die "Nome de tabela fora do padrão: '$t'."
  cn="$(colunas_gravaveis nuvem "$s" "$t")"
  cl="$(colunas_gravaveis local "$s" "$t")"
  [ -n "$cl" ] || { c_ylw "  • $s.$t não existe no local: pulada"; return 0; }
  comuns="$(colunas_em_comum "$cn" "$cl")"
  [ -n "$comuns" ] || { c_ylw "  • $s.$t sem coluna em comum: pulada"; return 0; }
  lista="$(lista_sql_colunas "$comuns")"
  psql_nuvem -q -c "\\copy (select ${lista} from ${s}.\"${t}\") to stdout" \
    | psql_local_stdin -q -1 \
        -c "set session_replication_role = replica" \
        -c "\\copy ${s}.\"${t}\"(${lista}) from stdin"
}

SQL_SEQUENCIAS=$(cat <<'SQL'
do $$
declare r record;
begin
  for r in
    select format('%I.%I', ns.nspname, s.relname) as seq,
           format('%I.%I', ns.nspname, t.relname) as tbl,
           a.attname as col
    from pg_class s
    join pg_namespace ns on ns.oid = s.relnamespace
    join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass
                    and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
    join pg_class t on t.oid = d.refobjid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where s.relkind = 'S' and ns.nspname = 'public'
  loop
    execute format('select setval(%L, greatest(coalesce((select max(%I) from %s), 0), 1), exists (select 1 from %s))',
                   r.seq, r.col, r.tbl, r.tbl);
  end loop;
end $$;
SQL
)

copiar_buckets() {
  local cn cl comuns lista
  cn="$(colunas_gravaveis nuvem storage buckets)"
  cl="$(colunas_gravaveis local storage buckets)"
  comuns="$(colunas_em_comum "$cn" "$cl")"
  [ -n "$comuns" ] || { c_ylw "• storage.buckets sem coluna em comum: buckets não copiados"; return 0; }
  lista="$(lista_sql_colunas "$comuns")"
  psql_nuvem -q -c "\\copy (select ${lista} from storage.buckets) to stdout" \
    | psql_local_stdin -q -1 \
        -c "create temp table _buckets_nuvem (like storage.buckets)" \
        -c "\\copy _buckets_nuvem(${lista}) from stdin" \
        -c "insert into storage.buckets(${lista}) select ${lista} from _buckets_nuvem on conflict (id) do nothing"
}

copiar_dados() {
  local t n
  declare -A contagem=()
  step "[7/12] Copiando os dados da nuvem para o Supabase local"
  load_env .env
  escolher_conexao_local
  limpar_destino

  while IFS=$'\t' read -r t n; do contagem["$t"]="$n"; done < "$ESTADO_DIR/contagens-nuvem.tsv"

  for t in $(cat "$ESTADO_DIR/tabelas-auth.txt"); do
    if [ "${contagem[auth.$t]:-0}" = "0" ]; then continue; fi
    c_dim "  auth.$t (${contagem[auth.$t]} linhas)"
    copiar_tabela auth "$t"
  done
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    if [ "${contagem[public.$t]:-0}" = "0" ]; then continue; fi
    c_dim "  public.$t (${contagem[public.$t]} linhas)"
    copiar_tabela public "$t"
  done < "$ESTADO_DIR/tabelas-public-comuns.txt"
  c_grn "✓ Tabelas copiadas"

  psql_local_q -q -c "$SQL_SEQUENCIAS"
  c_grn "✓ Sequências ajustadas"
  copiar_buckets
  c_grn "✓ Buckets que faltavam foram criados (os que já existiam ficaram como estavam)"

  { contagens_de local auth "$ESTADO_DIR/tabelas-auth.txt"
    contagens_de local public "$ESTADO_DIR/tabelas-public-comuns.txt"; } > "$ESTADO_DIR/contagens-local-copiado.tsv"
  # O dono de bootstrap não existe mais; o arquivo de credenciais dele enganaria.
  if [ -f "$RUNTIME_DIR/admin-credentials" ]; then
    mv "$RUNTIME_DIR/admin-credentials" "$ESTADO_DIR/admin-credentials.bootstrap"
  fi
}

# ── Passo 8: baseline local ──────────────────────────────────────────────────
reaplicar_baseline_local() {
  step "[8/12] Reaplicando o baseline no banco local (sementes e migration 0396)"
  load_env .env
  if reaplicar_baseline "$ROOT_DIR/supabase/baseline.sql" "$ESTADO_DIR/baseline.log"; then
    c_grn "✓ Baseline aplicado"
  else
    c_red "$BASELINE_INESPERADO"
    die "O baseline não fechou no banco local. Log: $ESTADO_DIR/baseline.log"
  fi
}

# ── Passo 9: poda local antes da mídia ───────────────────────────────────────
podar_mensagens() {
  local ids apagadas total=0
  step "[9/12] Podando as mensagens além das ${PODA_MANTER} mais recentes por conversa (antes de copiar a mídia)"
  while :; do
    ids="$(psql_local_q -tAq -c "select coalesce(string_agg(id::text, ','), '') from public.fn_mensagens_excedentes(${PODA_MANTER}, ${PODA_LOTE})")"
    [ -n "$ids" ] || break
    apagadas="$(psql_local_q -tAq -c "select public.fn_apagar_mensagens_excedentes('{${ids}}'::uuid[], ${PODA_MANTER})")"
    if [ "${apagadas:-0}" -le 0 ]; then
      c_ylw "• A poda devolveu candidatas mas não apagou nenhuma; paro por aqui para não repetir sem fim."
      break
    fi
    total=$((total + apagadas))
    c_dim "  ${total} mensagens podadas até agora"
  done
  gravar_estado MENSAGENS_PODADAS "$total"
  c_grn "✓ Poda concluída: ${total} mensagens removidas do local (a nuvem não foi tocada)"
}

# ── Passo 10: arquivos do Storage ────────────────────────────────────────────
listar_objetos_da_nuvem() {  # listar_objetos_da_nuvem <bucket> [prefixo] [profundidade]  → um caminho por linha
  local bucket="$1" prefixo="${2:-}" fundo="${3:-0}" offset=0 limite=1000 body resp n pasta
  # Teto de pastas aninhadas: resposta estranha da API não pode virar recursão sem fim.
  [ "$fundo" -le 30 ] || { c_red "Pastas aninhadas demais em $bucket/$prefixo"; return 1; }
  while :; do
    body="$(jq -nc --arg p "$prefixo" --argjson l "$limite" --argjson o "$offset" \
      '{prefix: $p, limit: $l, offset: $o, sortBy: {column: "name", order: "asc"}}')"
    resp="$(curl -sS -f -m 60 -X POST -H @"$HDR_NUVEM" -H 'Content-Type: application/json' \
      --data "$body" "$NUVEM_URL/storage/v1/object/list/$bucket")" || return 1
    n="$(jq 'length' <<<"$resp")"
    jq -r --arg p "$prefixo" '.[] | select(.id != null) | ($p + .name)' <<<"$resp"
    while IFS= read -r pasta; do
      [ -z "$pasta" ] || listar_objetos_da_nuvem "$bucket" "${prefixo}${pasta}/" $((fundo + 1)) || return 1
    done < <(jq -r '.[] | select(.id == null) | .name' <<<"$resp")
    [ "$n" -ge "$limite" ] || break
    offset=$((offset + limite))
  done
}

# 0 copiou · 44 não existe na origem · 1 falhou
copiar_um_arquivo() {  # copiar_um_arquivo <bucket> <caminho>
  local bucket="$1" caminho="$2" enc tmp hdr resp codigo ct
  enc="$(codificar_caminho "$caminho")"
  tmp="$ESTADO_DIR/tmp.objeto"; hdr="$ESTADO_DIR/tmp.objeto.hdr"; resp="$ESTADO_DIR/tmp.resposta"
  codigo="$(curl -sS -m 900 -H @"$HDR_NUVEM" -D "$hdr" -o "$tmp" -w '%{http_code}' \
    "$NUVEM_URL/storage/v1/object/authenticated/$bucket/$enc" 2>>"$ESTADO_DIR/falhas-arquivos.log")" || { rm -f "$tmp" "$hdr"; return 1; }
  case "$codigo" in
    200) ;;
    404) rm -f "$tmp" "$hdr"; return 44 ;;
    400) if grep -qiE 'not_found|not found' "$tmp" 2>/dev/null; then rm -f "$tmp" "$hdr"; return 44; fi
         rm -f "$tmp" "$hdr"; return 1 ;;
    *)   rm -f "$tmp" "$hdr"; return 1 ;;
  esac
  ct="$(awk -F': *' 'tolower($1) == "content-type" { v = $2 } END { sub(/\r$/, "", v); print v }' "$hdr")"
  codigo="$(curl -sS -m 900 -X POST -H @"$HDR_LOCAL" -H 'x-upsert: true' -H "Content-Type: ${ct:-application/octet-stream}" \
    --data-binary @"$tmp" -o "$resp" -w '%{http_code}' \
    "${SUPABASE_INTERNAL_URL%/}/storage/v1/object/$bucket/$enc" 2>>"$ESTADO_DIR/falhas-arquivos.log")" || { rm -f "$tmp" "$hdr" "$resp"; return 1; }
  rm -f "$tmp" "$hdr"
  case "$codigo" in
    2*) rm -f "$resp"; return 0 ;;
    *)  { printf '[%s] %s/%s -> HTTP %s: ' "$(date -u +%FT%TZ)" "$bucket" "$caminho" "$codigo"; head -c 300 "$resp"; printf '\n'; } >> "$ESTADO_DIR/falhas-arquivos.log"
        rm -f "$resp"; return 1 ;;
  esac
}

copiar_arquivos() {
  local bucket caminho rc ok=0 falhas=0 ausentes=0 total faltam existentes
  step "[10/12] Copiando os arquivos do Storage (anexos)"
  load_env .env
  load_env "$ESTADO_ENV"
  LOCAL_URL="${LOCAL_URL:-$SUPABASE_DB_URL}"
  : > "$ESTADO_DIR/arquivos-esperados.tsv"
  : > "$ESTADO_DIR/falhas-arquivos.log"
  : > "$ESTADO_DIR/arquivos-ausentes.tsv"

  while IFS= read -r bucket; do
    [ -n "$bucket" ] || continue
    if [ "$bucket" = "$BUCKET_MIDIA" ]; then
      # Só a mídia das mensagens que SOBRARAM na poda — o resto não tem para quem servir.
      psql_local_q -tAq -c "select distinct media_storage_path from public.messages
        where media_storage_path is not null and media_storage_path <> ''" \
        | awk -v b="$bucket" 'NF { print b "\t" $0 }' >> "$ESTADO_DIR/arquivos-esperados.tsv"
    else
      listar_objetos_da_nuvem "$bucket" \
        | awk -v b="$bucket" 'NF { print b "\t" $0 }' >> "$ESTADO_DIR/arquivos-esperados.tsv" \
        || die "Não consegui listar o bucket '$bucket' pela API da nuvem."
    fi
  done < "$ESTADO_DIR/buckets-nuvem.txt"
  total="$(grep -c . "$ESTADO_DIR/arquivos-esperados.tsv" || true)"
  c_dim "  ${total} arquivos esperados no total"

  existentes="$ESTADO_DIR/arquivos-existentes.tsv"
  psql_local_q -tAq -F $'\t' -c "select bucket_id, name from storage.objects" > "$existentes"
  faltam="$ESTADO_DIR/arquivos-faltam.tsv"
  comm -23 <(sort "$ESTADO_DIR/arquivos-esperados.tsv") <(sort "$existentes") > "$faltam"
  c_dim "  $(grep -c . "$faltam" || true) ainda não estão no local (os que já estão são pulados)"

  while IFS=$'\t' read -r bucket caminho; do
    [ -n "$caminho" ] || continue
    rc=0
    copiar_um_arquivo "$bucket" "$caminho" || rc=$?
    case "$rc" in
      0)  ok=$((ok + 1)) ;;
      44) ausentes=$((ausentes + 1)); printf '%s\t%s\n' "$bucket" "$caminho" >> "$ESTADO_DIR/arquivos-ausentes.tsv" ;;
      *)  falhas=$((falhas + 1)); printf '[%s] FALHOU %s/%s\n' "$(date -u +%FT%TZ)" "$bucket" "$caminho" >> "$ESTADO_DIR/falhas-arquivos.log" ;;
    esac
    if [ $(((ok + ausentes + falhas) % 50)) -eq 0 ]; then
      c_dim "  ${ok} copiados · ${ausentes} ausentes na origem · ${falhas} falhas"
    fi
  done < "$faltam"

  gravar_estado ARQUIVOS_COPIADOS "$ok"
  gravar_estado ARQUIVOS_AUSENTES_NA_ORIGEM "$ausentes"
  gravar_estado ARQUIVOS_FALHAS "$falhas"
  c_grn "✓ Anexos: ${ok} copiados · ${ausentes} ausentes na origem · ${falhas} falhas (log: $ESTADO_DIR/falhas-arquivos.log)"
  [ "$falhas" -eq 0 ] || return 1
}

# ── Passo 11: conferência ────────────────────────────────────────────────────
conferir() {
  local t n l faltam_linhas=0 faltam_arq msgs_agora
  local -A cn=() cl=()
  step "[11/12] Conferindo: nuvem × local"
  load_env "$ESTADO_ENV"
  [ -s "$ESTADO_DIR/contagens-local-copiado.tsv" ] || die "Não achei $ESTADO_DIR/contagens-local-copiado.tsv: a cópia dos dados (passo 7) não terminou."
  while IFS=$'\t' read -r t n; do cn["$t"]="$n"; done < "$ESTADO_DIR/contagens-nuvem.tsv"
  while IFS=$'\t' read -r t n; do cl["$t"]="$n"; done < "$ESTADO_DIR/contagens-local-copiado.tsv"
  : > "$ESTADO_DIR/relatorio.txt"
  for t in "${!cl[@]}"; do
    n="${cn[$t]:-0}"; l="${cl[$t]}"
    if [ "$l" -lt "$n" ]; then
      printf 'FALTOU  %-45s nuvem=%s local=%s\n' "$t" "$n" "$l" | tee -a "$ESTADO_DIR/relatorio.txt"
      faltam_linhas=$((faltam_linhas + 1))
    elif [ "$l" -gt "$n" ]; then
      printf 'SOBROU  %-45s nuvem=%s local=%s\n' "$t" "$n" "$l" | tee -a "$ESTADO_DIR/relatorio.txt"
    fi
  done
  # O que existe na nuvem com linhas e não tem tabela no local: avisa, não reprova.
  for t in "${!cn[@]}"; do
    [ -z "${cl[$t]+x}" ] || continue
    [ "${cn[$t]}" -gt 0 ] || continue
    printf 'AVISO   %-45s %s linhas na nuvem; a tabela não existe no local\n' "$t" "${cn[$t]}" | tee -a "$ESTADO_DIR/relatorio.txt"
  done
  msgs_agora="$(psql_local_q -tAq -c 'select count(*) from public.messages')"
  printf 'messages: nuvem=%s · copiadas=%s · depois da poda=%s (a diferença é a poda de %s mensagens, esperada)\n' \
    "${cn[public.messages]:-0}" "${cl[public.messages]:-0}" "$msgs_agora" "${MENSAGENS_PODADAS:-0}" | tee -a "$ESTADO_DIR/relatorio.txt"

  psql_local_q -tAq -F $'\t' -c "select bucket_id, name from storage.objects" > "$ESTADO_DIR/arquivos-existentes.tsv"
  faltam_arq="$(comm -23 <(sort "$ESTADO_DIR/arquivos-esperados.tsv") <(sort "$ESTADO_DIR/arquivos-existentes.tsv") \
    | comm -23 - <(sort "$ESTADO_DIR/arquivos-ausentes.tsv") | grep -c . || true)"
  printf 'arquivos: esperados=%s · ausentes na origem=%s · faltando no local=%s\n' \
    "$(grep -c . "$ESTADO_DIR/arquivos-esperados.tsv" || true)" "$(grep -c . "$ESTADO_DIR/arquivos-ausentes.tsv" || true)" "$faltam_arq" \
    | tee -a "$ESTADO_DIR/relatorio.txt"

  if [ "$faltam_linhas" -gt 0 ] || [ "$faltam_arq" -gt 0 ] || [ "${ARQUIVOS_FALHAS:-0}" -gt 0 ]; then
    c_red "✖ A conferência NÃO liberou: ${faltam_linhas} tabela(s) com linhas faltando, ${faltam_arq} arquivo(s) faltando, ${ARQUIVOS_FALHAS:-0} falha(s) de cópia."
    c_red "  Relatório: $ESTADO_DIR/relatorio.txt"
    return 1
  fi
  c_grn "✓ Tudo confere (relatório: $ESTADO_DIR/relatorio.txt)"
}

# ── Passo 12: sobe o CRM e prova ─────────────────────────────────────────────
subir_e_provar() {
  local corpo i codigo
  step "[12/12] Subindo o CRM e conferindo que responde"
  load_env .env
  dc up -d
  corpo="$(wait_app_healthy 40 3)" || { c_red "${corpo:-}"; die "O app não ficou saudável depois de subir."; }
  jq -e '.data.checks.supabase.status == "ok"' >/dev/null <<<"$corpo" \
    || { c_red "$corpo"; die "O app subiu, mas o check 'supabase' não está ok."; }
  c_grn "✓ /api/v1/health: supabase ok"
  codigo=""
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    codigo="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/" 2>/dev/null || true)"
    [ "$codigo" = "307" ] && break
    sleep 5
  done
  [ "$codigo" = "307" ] || die "O domínio https://${DOMAIN}/ respondeu '${codigo:-sem resposta}' (esperava 307 para o login)."
  c_grn "✓ https://${DOMAIN}/ respondeu 307 (redireciona para o login)"
}

# ── Volta ────────────────────────────────────────────────────────────────────
voltar_para_nuvem() {
  local app worker sched
  set +e
  [ -f "$ENV_NUVEM" ] || { c_red "✖ Não achei $ENV_NUVEM: não tenho para onde voltar."; return 1; }
  step "Voltando para o Supabase da nuvem"
  cd "$ROOT_DIR" || return 1
  # Guarda o .env single-server (se já existir) para --somente-arquivos retomar.
  if [ "$(valor_do_env .env SINGLE_SERVER)" = "1" ]; then
    mkdir -p "$ESTADO_DIR"
    cp -p .env "$ENV_SINGLE"
  fi
  cp -p "$ENV_NUVEM" .env
  chmod 600 .env
  unset SINGLE_SERVER SINGLE_SERVER_NETWORK PSQL_DOCKER_NETWORK SUPABASE_INTERNAL_URL
  load_env .env
  c_grn "✓ .env restaurado de $ENV_NUVEM"

  if [ -f "$(dir_do_supabase)/.env" ]; then
    # `stop`, nunca `down -v`: o volume do Supabase local (e os dados já copiados) fica.
    dc_supabase stop || c_ylw "• Não consegui parar o Supabase local; pare à mão: docker compose --project-directory $(dir_do_supabase) stop"
  fi

  # Sobe com as imagens que rodavam antes (se o .env nuvem aponta para outra
  # coisa, como o ghcr 1.47.0, o `up` trocaria o fork pelo upstream).
  [ -f "$ESTADO_ENV" ] && load_env "$ESTADO_ENV"
  app="${IMG_APP_RODANDO:-}"; worker="${IMG_WORKER_RODANDO:-}"; sched="${IMG_SCHEDULER_RODANDO:-}"
  if [ -n "$app" ] && docker image inspect "$app" >/dev/null 2>&1; then
    (
      export APP_IMAGE="$app" APP_PULL_POLICY=never
      if [ -n "$worker" ] && docker image inspect "$worker" >/dev/null 2>&1; then
        export WORKER_IMAGE="$worker" WORKER_PULL_POLICY=never
      fi
      if [ -n "$sched" ] && docker image inspect "$sched" >/dev/null 2>&1; then
        export SCHEDULER_IMAGE="$sched" SCHEDULER_PULL_POLICY=never
      fi
      dc up -d
    )
  else
    c_ylw "• Não sei qual imagem rodava antes: subo com o que o .env diz."
    dc up -d
  fi
  if [ $? -eq 0 ]; then
    c_grn "✓ CRM de volta no ar, usando o Supabase da nuvem (nada foi apagado lá nem aqui)."
  else
    c_red "✖ Não consegui subir o CRM. Suba à mão: docker compose $(dc_files) up -d"
    return 1
  fi
}

ao_sair() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "$VOLTA_ARMADA" = 1 ] && [ "$MIGRACAO_CONCLUIDA" != 1 ]; then
    c_red "✖ A migração falhou (código $rc). Voltando sozinho para a nuvem."
    voltar_para_nuvem || c_red "✖ A volta automática também falhou. Rode: bash hostgator-setup-kit/migrar-da-nuvem.sh --voltar"
  fi
  exit "$rc"
}

cmd_voltar() {  # cmd_voltar <sim: 0|1>
  local sim="$1" resposta
  [ "$(id -u)" -eq 0 ] || die "Rode como root."
  cd "$ROOT_DIR"
  if [ -f "$ESTADO_ENV" ] && [ "$(valor_do_env "$ESTADO_ENV" ESTADO_CONCLUIDA)" = "1" ] && [ "$sim" != 1 ]; then
    c_ylw "ATENÇÃO: a migração já foi concluída. Tudo o que foi criado DEPOIS dela (mensagens, leads, usuários)"
    c_ylw "existe só no Supabase local e NÃO volta para a nuvem. Voltar mostra a nuvem como ela estava."
    [ -t 0 ] || die "Sem terminal para confirmar. Use --voltar --sim se tem certeza."
    read -r -p "Digite VOLTAR para continuar: " resposta
    [ "$resposta" = "VOLTAR" ] || die "Cancelado. Nada foi alterado."
  fi
  voltar_para_nuvem
}

cmd_somente_arquivos() {
  [ "$(id -u)" -eq 0 ] || die "Rode como root."
  cd "$ROOT_DIR"
  step "Retomando só a cópia dos anexos"
  [ -f "$ESTADO_ENV" ] && [ -f "$ENV_SINGLE" ] \
    || die "Não achei o estado de uma migração anterior em $ESTADO_DIR. --somente-arquivos só retoma uma migração que já passou do passo 6."
  [ "$(valor_do_env .env SINGLE_SERVER)" = "1" ] || { cp -p "$ENV_SINGLE" .env; chmod 600 .env; }
  load_env .env
  load_env "$ESTADO_ENV"
  VOLTA_ARMADA=1
  dc_supabase up -d --wait
  dc stop app worker scheduler
  escrever_cabecalho "$HDR_NUVEM" "$NUVEM_SERVICE_KEY"
  escrever_cabecalho "$HDR_LOCAL" "$SUPABASE_SERVICE_ROLE_KEY"
  LOCAL_URL="$SUPABASE_DB_URL"
  copiar_arquivos
  conferir
  subir_e_provar
  gravar_estado ESTADO_CONCLUIDA 1
  MIGRACAO_CONCLUIDA=1
  c_grn "✓ Anexos copiados e CRM no ar no Supabase local."
}

cmd_migrar() {  # cmd_migrar <dry-run: 0|1>
  local dry="$1"
  precheck "$dry"
  if [ "$dry" = 1 ]; then
    exportar_da_nuvem
    c_grn "✓ --dry-run terminou: nada foi alterado além de $ESTADO_DIR. A migração faria os passos 2 a 12 acima."
    return 0
  fi
  salvar_a_volta
  VOLTA_ARMADA=1
  parar_crm
  exportar_da_nuvem
  preparar_env
  instalar_supabase_local
  copiar_dados
  reaplicar_baseline_local
  podar_mensagens
  copiar_arquivos
  conferir
  subir_e_provar
  gravar_estado ESTADO_CONCLUIDA 1
  MIGRACAO_CONCLUIDA=1
  cat <<EOF

$(c_grn "✓ Migração concluída: o CRM agora usa o Supabase desta VPS.")
  - O projeto da nuvem continua intacto (é a sua cópia de segurança). Pause-o no painel só depois de alguns dias.
  - O .env anterior está em $ENV_NUVEM. Voltar: bash hostgator-setup-kit/migrar-da-nuvem.sh --voltar
  - Relatório: $ESTADO_DIR/relatorio.txt
  - $ESTADO_DIR guarda as chaves da nuvem; apague quando não precisar mais.
  - Todos precisam entrar de novo (as sessões não são copiadas).
EOF
}

main() {
  local modo=migrar sim=0
  while (($#)); do
    case "$1" in
      --dry-run) modo=dry ;;
      --somente-arquivos) modo=arquivos ;;
      --voltar) modo=voltar ;;
      --sim) sim=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  trap ao_sair EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  case "$modo" in
    voltar)   cmd_voltar "$sim" ;;
    arquivos) cmd_somente_arquivos ;;
    dry)      cmd_migrar 1 ;;
    *)        cmd_migrar 0 ;;
  esac
}

# Carregado por `source` (os testes), só define as funções.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
