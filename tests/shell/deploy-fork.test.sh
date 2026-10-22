#!/usr/bin/env bash
# Prova de COMPORTAMENTO do deploy-fork.sh, com `git`, `docker`, `flock` e `id`
# como dublês que registram o que receberam. Nada toca a máquina de quem roda.
#
#   bash tests/shell/deploy-fork.test.sh
#
# Casos: sem commit novo (sai 0 sem fazer nada), fast-forward recusado, backup
# falho, build falho (o CRM NÃO é parado), health falho (volta as imagens
# anteriores) e o caminho feliz.
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER PSQL_DOCKER_NETWORK REVERSE_PROXY SUPABASE_DB_ADMIN_URL \
  APP_IMAGE WORKER_IMAGE SCHEDULER_IMAGE

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }
contem() { grep -qF -- "$2" "$1" || { printf '    [%s] não está em %s\n' "$2" "$1"; return 1; }; }
nao_contem() { ! grep -qF -- "$2" "$1" || { printf '    [%s] apareceu em %s\n' "$2" "$1"; return 1; }; }
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }

BIN="$WORK/bin"; PROJ="$WORK/proj"; FLAGS="$WORK/flags"; LOG="$WORK/chamadas.log"
mkdir -p "$BIN" "$FLAGS" "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
cp "$ROOT/hostgator-setup-kit/deploy-fork.sh" "$ROOT/hostgator-setup-kit/_common.sh" "$PROJ/hostgator-setup-kit/"
: > "$PROJ/docker-compose.prod.yml"; : > "$PROJ/docker-compose.single-server.yml"; : > "$PROJ/docker-compose.build.yml"
: > "$PROJ/supabase/baseline.sql"
# backup.sh dublê: o real fala com o banco.
printf '#!/usr/bin/env bash\necho "BACKUP" >> %q\n[ -f %q ] && exit 1\nexit 0\n' "$LOG" "$FLAGS/backup-falha" \
  > "$PROJ/hostgator-setup-kit/backup.sh"

dublê() {  # dublê <nome> <corpo>
  printf '#!/usr/bin/env bash\nLOG=%q\nFLAGS=%q\n%s\n' "$LOG" "$FLAGS" "$2" > "$BIN/$1"; chmod +x "$BIN/$1"
}
dublê id 'echo 0'
dublê flock 'exit 0'
dublê git '
echo "git $*" >> "$LOG"
case "$1 $2" in
  "rev-parse HEAD") cat "$FLAGS/head" ;;
  "rev-parse origin/main") cat "$FLAGS/origin" ;;
  "rev-parse --short") cut -c1-7 "$FLAGS/head" ;;
  "merge-base --is-ancestor") [ -f "$FLAGS/nao-ff" ] && exit 1; exit 0 ;;
  "merge --ff-only") cp "$FLAGS/origin" "$FLAGS/head" ;;
esac
exit 0'
dublê docker '
echo "docker $*" >> "$LOG"
case "$1" in
  compose)
    case " $* " in
      *" build "*) [ -f "$FLAGS/build-falha" ] && exit 1 ;;
      *" exec "*) [ -f "$FLAGS/imagem-ruim" ] && exit 1; echo "healthy supabase=ok" ;;
      *" ps -q "*) echo id-worker ;;
    esac ;;
  tag) [ "$2" = "deskcomm-app:anterior" ] && rm -f "$FLAGS/imagem-ruim" ;;
  inspect) echo healthy ;;
esac
exit 0'

SHA_VELHO=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA_NOVO=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

rodar() {  # rodar <args...> → saída em $WORK/saida, código em $RC
  : > "$LOG"
  RC=0
  PATH="$BIN:$PATH" DEPLOY_ESPERA_S=0 DEPLOY_TENTATIVAS=2 \
    bash "$PROJ/hostgator-setup-kit/deploy-fork.sh" "$@" > "$WORK/saida" 2>&1 || RC=$?
  sleep 0.3  # o tee do log termina de escrever
}
reset() {
  rm -rf "$FLAGS"/* "$PROJ/.runtime"
  printf 'SINGLE_SERVER=1\nSEGREDO_DE_TESTE=nao-pode-aparecer\n' > "$PROJ/.env"
  printf '%s' "$SHA_VELHO" > "$FLAGS/head"; printf '%s' "$SHA_NOVO" > "$FLAGS/origin"
}
chamou() { grep -qE "$1" "$LOG"; }

echo "▶ sem commit novo"
reset; printf '%s' "$SHA_VELHO" > "$FLAGS/origin"; mkdir -p "$PROJ/.runtime/deploy"; printf '%s\n' "$SHA_VELHO" > "$PROJ/.runtime/deploy/ultimo-deploy"
rodar
check "sai 0" igual "$RC" 0
check "diz que não há nada a fazer" contem "$WORK/saida" "Nada a fazer"
check "não faz backup nem build" bash -c '! grep -qE "BACKUP|build" "$1"' _ "$LOG"

echo "▶ --forcar sem commit novo"
rodar --forcar
check "faz o deploy" chamou "compose .* build app worker scheduler"
check "sai 0" igual "$RC" 0

echo "▶ fast-forward recusado"
reset; touch "$FLAGS/nao-ff"
rodar
check "sai diferente de 0" bash -c '[ "$1" -ne 0 ]' _ "$RC"
check "não faz merge" bash -c '! grep -q "merge --ff-only" "$1"' _ "$LOG"
check "não faz backup nem build" bash -c '! grep -qE "BACKUP|build" "$1"' _ "$LOG"
check "explica" contem "$WORK/saida" "não é fast-forward"

echo "▶ backup falha"
reset; touch "$FLAGS/backup-falha"
rodar
check "sai diferente de 0" bash -c '[ "$1" -ne 0 ]' _ "$RC"
check "não faz merge" bash -c '! grep -q "merge --ff-only" "$1"' _ "$LOG"
check "não faz build" bash -c '! grep -q " build " "$1"' _ "$LOG"

echo "▶ build falha: o CRM não é parado"
reset; touch "$FLAGS/build-falha"
rodar
check "sai 1" igual "$RC" 1
check "não para nada" bash -c '! grep -qE "compose .* (stop|up) " "$1"' _ "$LOG"
check "diz que o CRM segue no ar" contem "$WORK/saida" "NÃO foi parado"
check "não grava marcador de deploy" bash -c '[ ! -f "$1" ]' _ "$PROJ/.runtime/deploy/ultimo-deploy"

echo "▶ health falha: volta as imagens anteriores"
reset; touch "$FLAGS/imagem-ruim"
rodar
check "sai 1" igual "$RC" 1
check "guardou a anterior" chamou "docker tag deskcomm-app:local deskcomm-app:anterior"
check "restaurou a anterior" chamou "docker tag deskcomm-app:anterior deskcomm-app:local"
check "sobe de novo (dois up -d)" igual "$(grep -cE 'compose .* up -d' "$LOG")" 2
check "avisa que o banco não volta" contem "$WORK/saida" "BANCO NÃO VOLTA"
check "não grava marcador de deploy" bash -c '[ ! -f "$1" ]' _ "$PROJ/.runtime/deploy/ultimo-deploy"

echo "▶ caminho feliz"
reset
rodar
check "sai 0" igual "$RC" 0
check "backup vem antes do build" bash -c 'b=$(grep -n BACKUP "$1" | head -1 | cut -d: -f1); k=$(grep -n " build " "$1" | head -1 | cut -d: -f1); [ -n "$b" ] && [ -n "$k" ] && [ "$b" -lt "$k" ]' _ "$LOG"
check "usa os três arquivos de compose" contem "$LOG" "-f docker-compose.prod.yml -f docker-compose.single-server.yml -f docker-compose.build.yml --env-file .env"
check "grava o marcador do deploy" igual "$(cat "$PROJ/.runtime/deploy/ultimo-deploy")" "$SHA_NOVO"
check "grava log em .runtime/deploy" bash -c 'ls "$1"/*.log >/dev/null 2>&1' _ "$PROJ/.runtime/deploy"
check "não imprime segredo do .env" nao_contem "$WORK/saida" "nao-pode-aparecer"

echo "▶ --sem-backup"
reset
rodar --sem-backup
check "não roda o backup" bash -c '! grep -q BACKUP "$1"' _ "$LOG"
check "avisa" contem "$WORK/saida" "SEM backup"

echo "▶ fora do modo single-server"
reset; printf 'SINGLE_SERVER=0\n' > "$PROJ/.env"
rodar
check "recusa sem mexer em nada" bash -c '[ "$1" -ne 0 ] && ! grep -qE "BACKUP|build|merge" "$2"' _ "$RC" "$LOG"

echo
[ "$FAILS" -eq 0 ] && echo "OK" || { echo "$FAILS falha(s)"; exit 1; }
