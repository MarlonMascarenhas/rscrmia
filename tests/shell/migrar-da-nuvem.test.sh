#!/usr/bin/env bash
# Prova de COMPORTAMENTO do migrar-da-nuvem.sh: a interseção de colunas, o que
# o roteiro faz em cada etapa (com `docker`, `curl` e o instalador como dublês) e,
# acima de tudo, a VOLTA — falhou depois de parar o CRM, o .env de antes volta,
# o Supabase local para sem perder volume e o CRM sobe como estava.
#
#   bash tests/shell/migrar-da-nuvem.test.sh
#
# Nada aqui toca a máquina de quem roda nem uma nuvem de verdade: `docker`,
# `curl`, `id` e `swapon` são dublês que registram o que receberam. Precisa de
# `jq` real (a cópia de anexos o usa); sem ele os casos que dependem dele são
# pulados, DIZENDO.
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER PSQL_DOCKER_NETWORK REVERSE_PROXY SUPABASE_DB_ADMIN_URL

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
contem() { grep -qF -- "$2" "$1" || { printf '    [%s] não está em %s\n' "$2" "$1"; return 1; }; }
nao_contem() { ! grep -qF -- "$2" "$1" || { printf '    [%s] apareceu em %s\n' "$2" "$1"; return 1; }; }
mesmo_arquivo() { cmp -s "$1" "$2" || { printf '    %s e %s diferem\n' "$1" "$2"; return 1; }; }

# O namespace das imagens vem do _common.sh (a catraca de namespace-das-imagens.test.ts proíbe repeti-lo aqui).
IMG_NS="$(bash -c '. "$1" >/dev/null 2>&1; printf %s "$IMG_NS"' _ "$ROOT/hostgator-setup-kit/_common.sh")"
[ -n "$IMG_NS" ] || { echo "não consegui ler IMG_NS do _common.sh"; exit 1; }
TEM_JQ=1
command -v jq >/dev/null 2>&1 || TEM_JQ=0

# ── Dublês ───────────────────────────────────────────────────────────────────
DLOG="$WORK/docker.log"
CLOG="$WORK/curl.log"
FLAGS="$WORK/flags"
mkdir -p "$WORK/bin" "$FLAGS"

{
  printf '#!/usr/bin/env bash\nDLOG=%q\nFLAGS=%q\nOBJ=%q\n' "$DLOG" "$FLAGS" "$WORK/objetos-locais.tsv"
  cat <<'STUB'
printf '%s\n' "$*" >> "$DLOG"
args=" $* "
lado=nuvem; case "$args" in *" --network "*) lado=local;; esac
case "$1" in
  compose)
    printf 'COMPOSE pwd=%s projeto=%s APP_IMAGE=%s APP_PULL_POLICY=%s WORKER_IMAGE=%s\n' "$PWD" \
      "${COMPOSE_PROJECT_NAME-<ausente>}" "${APP_IMAGE-<ausente>}" "${APP_PULL_POLICY-<ausente>}" "${WORKER_IMAGE-<ausente>}" >> "$DLOG"
    case "$args" in
      *" exec "*) printf 'healthy\n{"data":{"status":"healthy","checks":{"supabase":{"status":"ok"}}}}\n' ;;
      *" ps -q "*) case "$args" in *" app "*) echo id-app;; *" worker "*) echo id-worker;; *" scheduler "*) echo id-scheduler;; esac ;;
    esac
    exit 0 ;;
  inspect) case "$2" in id-app) echo deskcomm-app:local;; id-worker) echo deskcomm-worker:local;; id-scheduler) echo deskcomm-scheduler:local;; esac; exit 0 ;;
  image|tag|info|ps|network) exit 0 ;;
  run)
    case "$args" in *"-c select 1 "*) [ -f "$FLAGS/nuvem-fora" ] && { echo "connection refused" >&2; exit 2; }; echo 1; exit 0 ;; esac
    case "$args" in
      *"is_generated = 'NEVER'"*) if [ "$lado" = nuvem ]; then printf 'id\nname\nextra\n'; else printf 'id\nname\nnovo\n'; fi ;;
      *"from pg_class c join pg_namespace"*) if [ "$lado" = nuvem ]; then printf 'contacts\nmessages\n'; else printf 'contacts\nmessages\nlocal_only\n'; fi ;;
      *"information_schema.tables"*) printf 'identities\nusers\n' ;;
      *"union all"*) case "$args" in *"'auth."*) printf 'auth.identities\t2\nauth.users\t2\n';; *) printf 'public.contacts\t3\npublic.messages\t5\n';; esac ;;
      *'\copy ('*" to stdout"*) printf '1\tx\n' ;;
      *'from stdin'*) cat >/dev/null ;;
      *"from storage.buckets order by name"*) printf 'whatsapp-media\twhatsapp-media\tf\t\nfotos\tfotos\tt\t\n' ;;
      *"from storage.objects group by"*) printf 'whatsapp-media\t10\t1048576\n' ;;
      *"select bucket_id, name from storage.objects"*) [ "$lado" = local ] && cat "$OBJ" 2>/dev/null ;;
      *"distinct media_storage_path"*) echo org/conv/a.jpg ;;
      *"fn_mensagens_excedentes"*) if [ ! -f "$FLAGS/poda" ]; then : > "$FLAGS/poda"; echo u1,u2; fi ;;
      *"fn_apagar_mensagens_excedentes"*) echo 2 ;;
      *"count(*) from public.messages"*) echo 3 ;;
    esac
    exit 0 ;;
esac
exit 0
STUB
} > "$WORK/bin/docker"

{
  printf '#!/usr/bin/env bash\nCLOG=%q\nOBJ=%q\n' "$CLOG" "$WORK/objetos-locais.tsv"
  cat <<'STUB'
printf '%s\n' "$*" >> "$CLOG"
url="${@: -1}"; out=""; hdr=""; w=0; data=""; prev=""
for a in "$@"; do
  case "$prev" in -o) out="$a";; -D) hdr="$a";; --data) data="$a";; esac
  [ "$a" = "-w" ] && w=1
  prev="$a"
done
case "$url" in
  */storage/v1/object/list/*)
    case "$data" in
      *'"prefix":"pasta/"'*) echo '[{"name":"y.png","id":"2"}]' ;;
      *) echo '[{"name":"x.png","id":"1"},{"name":"pasta","id":null}]' ;;
    esac
    exit 0 ;;
esac
case "$url" in http://127.0.0.1:8000/storage/v1/object/*) rest="${url#*/storage/v1/object/}"; printf '%s\t%s\n' "${rest%%/*}" "${rest#*/}" >> "$OBJ";; esac
[ -z "$out" ] || [ "$out" = /dev/null ] || printf 'conteudo' > "$out"
[ -z "$hdr" ] || printf 'HTTP/1.1 200 OK\r\ncontent-type: image/png\r\n' > "$hdr"
if [ "$w" = 1 ]; then case "$*" in *--resolve*) printf 307;; *) printf 200;; esac; fi
exit 0
STUB
} > "$WORK/bin/curl"

printf '#!/usr/bin/env bash\n[ "${1:-}" = "-u" ] && echo 0 || command id "$@"\n' > "$WORK/bin/id"
printf '#!/usr/bin/env bash\necho "/swapfile file 4G 0B -2"\n' > "$WORK/bin/swapon"
# jq falso só para o `command -v` do pré-teste quando não há jq real: os casos
# que de fato usam jq são pulados nesse caso.
if [ "$TEM_JQ" = 0 ]; then printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/jq"; fi
chmod +x "$WORK/bin/"*
PATH="$WORK/bin:$PATH"

# ── Uma instalação "na nuvem" falsa ──────────────────────────────────────────
N_PROJ=0; PROJ=""
novo_projeto() {
  # Uma pasta nova por cenário (apagar a anterior falha em alguns sistemas de arquivos).
  N_PROJ=$((N_PROJ + 1)); PROJ="$WORK/proj$N_PROJ/DeskcommCRM"
  mkdir -p "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
  cp "$ROOT/hostgator-setup-kit/migrar-da-nuvem.sh" "$ROOT/hostgator-setup-kit/_common.sh" "$PROJ/hostgator-setup-kit/"
  touch "$PROJ/docker-compose.prod.yml" "$PROJ/docker-compose.single-server.yml" "$PROJ/supabase/baseline.sql"
  cat > "$PROJ/.env" <<'ENV'
DOMAIN=crm.exemplo.com
SUPABASE_DB_URL=postgresql://postgres.abc:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
SUPABASE_DB_ADMIN_URL=postgresql://admin:x@nuvem.exemplo.com:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-da-nuvem
SUPABASE_SERVICE_ROLE_KEY=service-da-nuvem
APP_IMAGE=@NS@/deskcommcrm:1.47.0
WORKER_IMAGE=@NS@/deskcomm-worker:1.47.0
SCHEDULER_IMAGE=@NS@/deskcomm-scheduler:1.47.0
OWNER_EMAIL=dono@exemplo.com
OWNER_PASSWORD="Senha com $ e espaco"
ENV
  sed -i "s#@NS@#$IMG_NS#g" "$PROJ/.env"
  chmod 600 "$PROJ/.env"
  cp "$PROJ/.env" "$WORK/env-original"
  # O Supabase local "já instalado" para o `stop` da volta achar o que parar.
  mkdir -p "$PROJ/.runtime/supabase"; touch "$PROJ/.runtime/supabase/.env" "$PROJ/.runtime/supabase/docker-compose.yml"
  # O instalador dublê: faz o que o install-single-server.sh + install.sh fazem
  # com o .env (inclusive o que o briefing identificou como destrutivo).
  {
    printf '#!/usr/bin/env bash\nFLAGS=%q\nWORK=%q\n' "$FLAGS" "$WORK"
    cat <<'STUB'
cd "$(dirname "$0")/.."
cp .env "$WORK/env-visto-pelo-instalador"
printf 'ADMIN_URL_NO_AMBIENTE=%s\n' "${SUPABASE_DB_ADMIN_URL-<ausente>}" > "$WORK/ambiente-do-instalador"
{ grep -vE '^(OWNER_EMAIL|OWNER_PASSWORD|WORKER_IMAGE|SCHEDULER_IMAGE|APP_PULL_POLICY|WORKER_PULL_POLICY)=' .env
  printf '%s\n' 'SINGLE_SERVER=1' 'SINGLE_SERVER_NETWORK=net' 'PSQL_DOCKER_NETWORK=net' \
    'SUPABASE_INTERNAL_URL=http://127.0.0.1:8000' 'SUPABASE_SERVICE_ROLE_KEY=service-local' \
    'SUPABASE_DB_URL=postgresql://postgres:pw@supabase-db:5432/postgres' \
    'OWNER_EMAIL=admin@crm.exemplo.com' 'OWNER_PASSWORD=bootstrap' \
    'WORKER_IMAGE=@NS@/deskcomm-worker:local' 'APP_PULL_POLICY=missing' 'WORKER_PULL_POLICY=missing'
} > .env.novo && mv .env.novo .env
echo 'OWNER_EMAIL=admin@crm.exemplo.com' > .runtime/admin-credentials
[ -f "$FLAGS/install-falha" ] && { echo "instalador dublê: falha de propósito" >&2; exit 1; }
exit 0
STUB
  } > "$PROJ/hostgator-setup-kit/install-single-server.sh"
  sed -i "s#@NS@#$IMG_NS#g" "$PROJ/hostgator-setup-kit/install-single-server.sh"
  chmod +x "$PROJ/hostgator-setup-kit/install-single-server.sh"
  : > "$DLOG"; : > "$CLOG"; : > "$WORK/objetos-locais.tsv"; rm -f "$FLAGS"/*
}
migrar() { (cd "$PROJ" && bash hostgator-setup-kit/migrar-da-nuvem.sh "$@") > "$WORK/saida" 2>&1; }

# ════════════════════════════════════════════════════════════════════════════
echo "interseção de colunas (puras):"
novo_projeto
unit() { (cd "$PROJ" && bash -c '. hostgator-setup-kit/migrar-da-nuvem.sh; eval "$1"' _ "$1"); }
check "fica só o que existe nos dois lados, na ordem da nuvem" \
  igual "$(unit 'colunas_em_comum "$(printf "id\nname\nextra\ncreated_at\n")" "$(printf "created_at\nid\nname\nnovo\n")" | tr "\n" ,')" 'id,name,created_at,'
check "lado vazio dá lista vazia" igual "$(unit 'colunas_em_comum "id" ""')" ''
check "a lista SQL vai entre aspas duplas" \
  igual "$(unit 'lista_sql_colunas "$(printf "id\nnome da coluna\n")"')" '"id","nome da coluna"'
check "as contagens saem em uma consulta só, com o schema no rótulo" \
  igual "$(printf 'a\nb\n' > "$WORK/t.txt"; unit "sql_contagens public $WORK/t.txt")" \
  "select 'public.a'::text as t, count(*)::bigint as n from public.\"a\" union all select 'public.b'::text as t, count(*)::bigint as n from public.\"b\" order by 1"
if [ "$TEM_JQ" = 1 ]; then
  check "o caminho do anexo é codificado trecho a trecho" \
    igual "$(unit 'codificar_caminho "org/a b/ção.png"')" 'org/a%20b/%C3%A7%C3%A3o.png'
else
  echo "  (pulado: sem jq real nesta máquina — codificar_caminho)"
fi

: > "$DLOG"
export PSQL_DOCKER_NETWORK=net NUVEM_DB_URL='postgresql://n' LOCAL_URL='postgresql://l'
saida_copia="$(unit 'copiar_tabela public contacts' 2>&1)"
unset PSQL_DOCKER_NETWORK NUVEM_DB_URL LOCAL_URL
check "colunas geradas ficam de fora (a consulta pede is_generated = 'NEVER')" contem "$DLOG" "is_generated = 'NEVER'"
check "lê da nuvem só as colunas em comum" contem "$DLOG" '\copy (select "id","name" from public."contacts") to stdout'
check "grava no local só as colunas em comum" contem "$DLOG" '\copy public."contacts"("id","name") from stdin'
check "coluna só da nuvem não é lida" nao_contem "$DLOG" '"extra"'
check "coluna só do local não é gravada" nao_contem "$DLOG" '"novo"'
check "a cópia roda em transação com session_replication_role = replica" contem "$DLOG" 'set session_replication_role = replica'
check "a cópia usa transação única (-1)" contem "$DLOG" ' -q -1 '
[ -z "$saida_copia" ] || printf '    saída inesperada: %s\n' "$saida_copia"

# ════════════════════════════════════════════════════════════════════════════
echo "pré-checagem — não mexe em nada quando não pode:"
novo_projeto
: > "$FLAGS/nuvem-fora"
migrar; rc=$?
check "nuvem fora do ar: o roteiro para" test "$rc" -ne 0
check "…e manda reanimar o projeto no painel do Supabase" contem "$WORK/saida" 'reanime o projeto no painel do Supabase'
check "…sem ter criado .env.nuvem" test ! -e "$PROJ/.env.nuvem"
check "…sem ter parado o CRM" nao_contem "$DLOG" ' stop '
check "…e o .env segue intacto" mesmo_arquivo "$PROJ/.env" "$WORK/env-original"

novo_projeto
printf 'SINGLE_SERVER=1\n' >> "$PROJ/.env"
migrar; rc=$?
check ".env já em SINGLE_SERVER=1: recusa" test "$rc" -ne 0
check "…e explica a saída" contem "$WORK/saida" 'já está em modo single-server'

novo_projeto
sed -i '/^SUPABASE_SERVICE_ROLE_KEY=/d' "$PROJ/.env"
migrar; rc=$?
check "variável da nuvem faltando: recusa nomeando-a" contem "$WORK/saida" 'SUPABASE_SERVICE_ROLE_KEY'

novo_projeto
printf '#!/usr/bin/env bash\n[ "${1:-}" = "-u" ] && echo 1000 || command id "$@"\n' > "$WORK/bin/id"
migrar; rc=$?
check "sem ser root: recusa" test "$rc" -ne 0
check "…dizendo para rodar como root" contem "$WORK/saida" 'Rode como root'
printf '#!/usr/bin/env bash\n[ "${1:-}" = "-u" ] && echo 0 || command id "$@"\n' > "$WORK/bin/id"

# ════════════════════════════════════════════════════════════════════════════
echo "--dry-run:"
novo_projeto
migrar --dry-run; rc=$?
check "--dry-run termina bem" test "$rc" -eq 0
[ "$rc" -eq 0 ] || sed 's/^/    | /' "$WORK/saida"
check "…não chama o instalador" test ! -e "$WORK/env-visto-pelo-instalador"
check "…não para o CRM" nao_contem "$DLOG" ' stop '
check "…não mexe no .env" mesmo_arquivo "$PROJ/.env" "$WORK/env-original"
check "…não cria .env.nuvem" test ! -e "$PROJ/.env.nuvem"
check "…exporta a lista de tabelas" contem "$PROJ/.runtime/migracao/tabelas-public.txt" 'messages'
check "…e as contagens exatas por tabela" contem "$PROJ/.runtime/migracao/contagens-nuvem.tsv" $'public.messages\t5'
check "…e os buckets" contem "$PROJ/.runtime/migracao/buckets-nuvem.txt" 'whatsapp-media'
check "…e relata o que viu" contem "$WORK/saida" 'Mensagens (messages)'

# ════════════════════════════════════════════════════════════════════════════
echo "a VOLTA automática (instalador falha no passo 6):"
novo_projeto
: > "$FLAGS/install-falha"
migrar; rc=$?
check "a migração falha com saída diferente de zero" test "$rc" -ne 0
check ".env.nuvem guarda o .env de antes" mesmo_arquivo "$PROJ/.env.nuvem" "$WORK/env-original"
check "o .env volta a ser o de antes (byte a byte)" mesmo_arquivo "$PROJ/.env" "$WORK/env-original"
check "…sem SINGLE_SERVER" nao_contem "$PROJ/.env" 'SINGLE_SERVER'
check "o CRM foi parado antes (app worker scheduler)" contem "$DLOG" 'stop app worker scheduler'
check "o Supabase local foi parado no diretório dele" grep -q "COMPOSE pwd=$PROJ/.runtime/supabase projeto=deskcommcrm-supabase" "$DLOG"
check "nada de 'down' nem de volume apagado" bash -c "! grep -E 'compose.* (down|rm)( |$)| -v ' '$DLOG' | grep -vE '^run --rm|--rm .* -v |-v [^ ]+:/b.sql' | grep -q ."
check "a volta sobe o CRM com a imagem que rodava (deskcomm-app:local)" grep -q 'APP_IMAGE=deskcomm-app:local APP_PULL_POLICY=never' "$DLOG"
check "…em modo comum (sem o override do single-server)" bash -c "grep ' up -d' '$DLOG' | tail -1 | grep -qv single-server"
check "a volta guarda o .env single-server para retomar anexos" test -f "$PROJ/.runtime/migracao/env.single-server"
check "…e o conteúdo dele é single-server" contem "$PROJ/.runtime/migracao/env.single-server" 'SINGLE_SERVER=1'
check "o estado não marca a migração como concluída" contem "$PROJ/.runtime/migracao/estado.env" 'ESTADO_CONCLUIDA=0'

echo "o que o instalador viu (passo 5 — sem perder nada):"
check "SUPABASE_DB_ADMIN_URL foi retirada do .env" nao_contem "$WORK/env-visto-pelo-instalador" 'SUPABASE_DB_ADMIN_URL'
check "…e não vazou pelo ambiente" contem "$WORK/ambiente-do-instalador" 'ADMIN_URL_NO_AMBIENTE=<ausente>'
check "APP_IMAGE aponta para a imagem local" contem "$WORK/env-visto-pelo-instalador" 'APP_IMAGE=deskcomm-app:local'
check "WORKER_IMAGE e SCHEDULER_IMAGE também" grep -q 'SCHEDULER_IMAGE=deskcomm-scheduler:local' "$WORK/env-visto-pelo-instalador"
check "pull_policy=never" contem "$WORK/env-visto-pelo-instalador" 'APP_PULL_POLICY=never'
check "REVERSE_PROXY=caddy fixado" contem "$WORK/env-visto-pelo-instalador" 'REVERSE_PROXY=caddy'
check "o worker local ganhou o nome que o install.sh vai escrever" \
  contem "$DLOG" "tag deskcomm-worker:local ${IMG_NS}/deskcomm-worker:local"
check "o scheduler também" contem "$DLOG" "tag deskcomm-scheduler:local ${IMG_NS}/deskcomm-scheduler:local"

# ════════════════════════════════════════════════════════════════════════════
echo "--voltar manual:"
novo_projeto
cp "$PROJ/.env" "$PROJ/.env.nuvem"
printf 'SINGLE_SERVER=1\nPSQL_DOCKER_NETWORK=net\n' >> "$PROJ/.env"
migrar --voltar; rc=$?
check "--voltar termina bem" test "$rc" -eq 0
check "…restaura o .env" mesmo_arquivo "$PROJ/.env" "$WORK/env-original"

novo_projeto
cp "$PROJ/.env" "$PROJ/.env.nuvem"
printf 'SINGLE_SERVER=1\n' >> "$PROJ/.env"
mkdir -p "$PROJ/.runtime/migracao"; printf 'ESTADO_CONCLUIDA=1\n' > "$PROJ/.runtime/migracao/estado.env"
cp "$PROJ/.env" "$WORK/env-single"
migrar --voltar < /dev/null; rc=$?
check "depois de concluída, --voltar sem terminal e sem --sim recusa" test "$rc" -ne 0
check "…e não mexe no .env" mesmo_arquivo "$PROJ/.env" "$WORK/env-single"
migrar --voltar --sim; rc=$?
check "com --sim ele volta" test "$rc" -eq 0
check "…restaurando o .env" mesmo_arquivo "$PROJ/.env" "$WORK/env-original"

# ════════════════════════════════════════════════════════════════════════════
echo "o caminho feliz (todos os passos, dublês no lugar da nuvem e do local):"
if [ "$TEM_JQ" = 0 ]; then
  echo "  (pulado: sem jq real nesta máquina)"
else
  novo_projeto
  migrar; rc=$?
  check "a migração termina bem" test "$rc" -eq 0
  [ "$rc" -eq 0 ] || sed 's/^/    | /' "$WORK/saida"
  check "anuncia a conclusão" contem "$WORK/saida" 'Migração concluída'
  check "o estado fica marcado como concluído" contem "$PROJ/.runtime/migracao/estado.env" 'ESTADO_CONCLUIDA=1'
  check ".env final é single-server" contem "$PROJ/.env" 'SINGLE_SERVER=1'
  check "…com a imagem do fork e pull_policy=never" grep -q 'APP_IMAGE=deskcomm-app:local' "$PROJ/.env"
  check "…sem SUPABASE_DB_ADMIN_URL" nao_contem "$PROJ/.env" 'SUPABASE_DB_ADMIN_URL'
  check "…com o dono REAL de volta (e não o admin do bootstrap)" contem "$PROJ/.env" 'OWNER_EMAIL=dono@exemplo.com'
  check "…e a senha do dono com a aspa e o cifrão intactos" contem "$PROJ/.env" 'OWNER_PASSWORD="Senha com $ e espaco"'
  check "…e o worker voltou para a imagem local" grep -q '^WORKER_IMAGE=deskcomm-worker:local$' "$PROJ/.env"
  check "o destino é esvaziado só nas tabelas em comum (local_only fica)" \
    contem "$DLOG" 'truncate table public."contacts", public."messages" cascade'
  check "o usuário do bootstrap é removido fora do modo replica" contem "$DLOG" 'delete from auth.users'
  check "auth.users é copiado" contem "$DLOG" '\copy auth."users"("id","name") from stdin'
  check "public.messages é copiada" contem "$DLOG" '\copy public."messages"("id","name") from stdin'
  check "as sequências são ajustadas" contem "$DLOG" 'setval'
  check "os buckets faltantes entram com ON CONFLICT DO NOTHING" contem "$DLOG" 'on conflict (id) do nothing'
  check "o baseline é reaplicado no local" contem "$DLOG" '-f /b.sql'
  check "a poda roda em lote até zerar" contem "$DLOG" "fn_apagar_mensagens_excedentes('{u1,u2}'::uuid[], 100)"
  check "…usando o piso de 100 e o lote de 1000" contem "$DLOG" 'fn_mensagens_excedentes(100, 1000)'
  check "whatsapp-media: só a mídia das mensagens que restaram" \
    contem "$PROJ/.runtime/migracao/arquivos-esperados.tsv" $'whatsapp-media\torg/conv/a.jpg'
  check "demais buckets: tudo, descendo nas pastas" contem "$PROJ/.runtime/migracao/arquivos-esperados.tsv" $'fotos\tpasta/y.png'
  check "o download usa o endpoint autenticado da nuvem" contem "$CLOG" 'abc.supabase.co/storage/v1/object/authenticated/fotos/x.png'
  check "o upload vai à API local com x-upsert e o content-type da origem" \
    grep -q 'x-upsert: true.*Content-Type: image/png.*http://127.0.0.1:8000/storage/v1/object/fotos/x.png' "$CLOG"
  check "a chave de serviço NUNCA aparece na linha de comando do curl" bash -c "! grep -q 'service-da-nuvem\|service-local' '$CLOG'"
  check "…nem em query string" bash -c "! grep -q 'apikey=' '$CLOG'"
  check "o relatório confere o messages à parte" contem "$PROJ/.runtime/migracao/relatorio.txt" 'messages: nuvem=5 · copiadas=5 · depois da poda=3'
  check "o CRM sobe pelo modo single-server" bash -c "grep -E 'compose.*docker-compose.single-server.yml.* up -d' '$DLOG' | grep -q ."
  check "o domínio é provado com 307" contem "$WORK/saida" 'respondeu 307'
  check "o arquivo de credenciais do bootstrap saiu do caminho" test ! -e "$PROJ/.runtime/admin-credentials"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "migrar-da-nuvem: tudo verde"; exit 0; fi
echo "migrar-da-nuvem: $FAILS falha(s)"; exit 1
