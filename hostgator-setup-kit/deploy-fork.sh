#!/usr/bin/env bash
# Deploy do FORK em modo single-server: puxa a main, constrói as imagens AQUI,
# reaplica o baseline e sobe — com backup antes e volta das imagens se o app
# não ficar saudável. Chamado pelo workflow .github/workflows/deploy-vps.yml
# por SSH, mas roda igual à mão:
#
#   sudo bash hostgator-setup-kit/deploy-fork.sh [--forcar] [--sem-backup]
#
# Por que NÃO é o update.sh: ele puxa a imagem publicada do upstream e desfaz o
# fork. Aqui as imagens (deskcomm-*:local) são construídas na própria VPS.
#
# Runbook: docs/runbooks/deploy-automatico-fork.md
source "$(dirname "$0")/_common.sh"

FORCAR=0
SEM_BACKUP=0
for a in "$@"; do
  case "$a" in
    --forcar) FORCAR=1 ;;
    --sem-backup) SEM_BACKUP=1 ;;
    -h|--help) sed -n 2,12p "$0"; exit 0 ;;
    *) die "Opção desconhecida: $a (use --forcar e/ou --sem-backup)." ;;
  esac
done

# Os três arquivos de compose, SEMPRE. O dc() do kit usa só dois (sem o build).
C() {
  docker compose -f docker-compose.prod.yml -f docker-compose.single-server.yml \
    -f docker-compose.build.yml --env-file .env "$@"
}

IMAGENS_ANTERIORES=()  # "<ref atual>|<ref anterior>"

guardar_imagens_atuais() {
  local ref base
  for ref in "${APP_IMAGE:-deskcomm-app:local}" "${WORKER_IMAGE:-deskcomm-worker:local}" "${SCHEDULER_IMAGE:-deskcomm-scheduler:local}"; do
    base="${ref%:*}"
    if docker image inspect "$ref" >/dev/null 2>&1; then
      docker tag "$ref" "$base:anterior"
      IMAGENS_ANTERIORES+=("$ref|$base:anterior")
    fi
  done
}

voltar_imagens() {
  local par
  for par in ${IMAGENS_ANTERIORES[@]+"${IMAGENS_ANTERIORES[@]}"}; do
    docker tag "${par#*|}" "${par%%|*}" || true
  done
}

# 0 quando o app responde saudável COM o Supabase ok E o worker está healthy.
verificar_no_ar() {
  local tentativas="${DEPLOY_TENTATIVAS:-36}" espera="${DEPLOY_ESPERA_S:-5}" i=0 saida wid wst
  while [ "$i" -lt "$tentativas" ]; do
    saida="$(C exec -T app node -e \
      "fetch('http://localhost:3000/api/v1/health').then(r=>r.json()).then(j=>{const d=(j&&j.data)||{};const s=d.checks&&d.checks.supabase&&d.checks.supabase.status;console.log((d.status||'sem_status')+' supabase='+(s||'?'))}).catch(()=>process.exit(1))" \
      2>/dev/null | tr -d '\r' | tail -1 || true)"
    case "$saida" in
      "healthy supabase=ok"|"degraded supabase=ok")
        wid="$(C ps -q worker 2>/dev/null | head -1 || true)"
        wst=''
        [ -z "$wid" ] || wst="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem{{end}}' "$wid" 2>/dev/null || true)"
        [ "$wst" = "healthy" ] && return 0
        ;;
    esac
    i=$((i + 1))
    [ "$i" -lt "$tentativas" ] && sleep "$espera"
  done
  return 1
}

main() {
  local PROJECT_ROOT DEPLOY_DIR LOG antes alvo ultimo baseline_rc=0
  PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$PROJECT_ROOT"

  [ "$(id -u)" = "0" ] || die "Rode como root (sudo bash hostgator-setup-kit/deploy-fork.sh)."

  DEPLOY_DIR="$PROJECT_ROOT/.runtime/deploy"
  mkdir -p "$DEPLOY_DIR"
  LOG="$DEPLOY_DIR/$(date +%Y%m%d-%H%M%S).log"
  # Tudo vai para a tela (o GitHub lê) e para o arquivo.
  exec > >(tee -a "$LOG") 2>&1
  c_dim "Log desta rodada: $LOG"

  exec 9>"$DEPLOY_DIR/deploy.lock"
  if ! flock -n 9; then
    c_ylw "• Já existe um deploy em andamento — esperando ele terminar (até 30 min)."
    flock -w 1800 9 || die "O deploy em andamento não terminou em 30 minutos. Nada foi feito."
  fi

  enter_project   # carrega o .env (sem imprimi-lo)
  [ "${SINGLE_SERVER:-0}" = "1" ] || die "Este script é só para o modo single-server (SINGLE_SERVER=1 no .env). Nada foi feito."
  [ -f docker-compose.single-server.yml ] || die "Falta docker-compose.single-server.yml. Nada foi feito."
  [ -f "$COMPOSE_BUILD" ] || die "Falta $COMPOSE_BUILD. Nada foi feito."

  step "Buscando a main"
  git fetch origin main || die "git fetch falhou. Nada foi alterado."
  antes="$(git rev-parse HEAD)"
  alvo="$(git rev-parse origin/main)"
  ultimo="$(cat "$DEPLOY_DIR/ultimo-deploy" 2>/dev/null || true)"
  if [ "$antes" = "$alvo" ] && [ "$ultimo" = "$alvo" ] && [ "$FORCAR" = 0 ]; then
    c_grn "✓ Nada a fazer: a VPS já está em ${alvo:0:9}. (use --forcar para refazer o deploy)"
    exit 0
  fi
  if [ "$antes" != "$alvo" ] && ! git merge-base --is-ancestor "$antes" "$alvo"; then
    die "A pasta não está atrás da origin/main em linha reta (não é fast-forward). Não mexi em nada — resolva à mão."
  fi

  if [ "$SEM_BACKUP" = 1 ]; then
    c_ylw "⚠ --sem-backup: seguindo SEM backup. Só para emergência."
  else
    step "Backup antes de mexer"
    bash hostgator-setup-kit/backup.sh || die "O backup falhou. Não mexi em nada: o CRM segue na versão de antes."
  fi

  if [ "$antes" != "$alvo" ]; then
    step "Trazendo o código (fast-forward ${antes:0:9} → ${alvo:0:9})"
    git merge --ff-only origin/main || die "O merge fast-forward falhou. Nada foi alterado."
  fi

  step "Guardando as imagens atuais (para voltar se der errado)"
  guardar_imagens_atuais

  step "Construindo app, worker e scheduler (o CRM segue no ar durante o build)"
  if ! C build app worker scheduler; then
    c_red "✖ O build falhou. O CRM NÃO foi parado e segue na versão de antes."
    c_red "  O código no disco já é o novo; a próxima rodada refaz o build."
    exit 1
  fi

  step "Parando app, worker e scheduler"
  C stop app worker scheduler || c_ylw "⚠ o stop devolveu erro — seguindo."

  step "Reaplicando o baseline do banco"
  reaplicar_baseline "$PWD/supabase/baseline.sql" "$PROJECT_ROOT/.deskcomm-banco.log" || baseline_rc=$?
  if [ "$baseline_rc" -ne 0 ]; then
    c_red "✖ O baseline não fechou (detalhes em .deskcomm-banco.log). Vou subir o CRM mesmo assim."
  fi

  step "Subindo app, worker, scheduler e caddy"
  C up -d app worker scheduler caddy || c_red "✖ O 'up -d' devolveu erro."

  step "Verificando se o CRM ficou saudável"
  if ! verificar_no_ar; then
    c_red "✖ O CRM não ficou saudável. Voltando as imagens anteriores."
    if [ "${#IMAGENS_ANTERIORES[@]}" -gt 0 ]; then
      voltar_imagens
      C up -d app worker scheduler caddy || true
      if verificar_no_ar; then
        c_ylw "↩ Voltei para a versão anterior e ela está saudável."
      else
        c_red "✖ Mesmo a versão anterior não ficou saudável. Intervenção manual necessária."
      fi
    else
      c_red "✖ Não havia imagem anterior guardada para voltar."
    fi
    c_ylw "  O BANCO NÃO VOLTA: o baseline é aditivo (só acrescenta), então a versão anterior roda sobre ele."
    exit 1
  fi

  if [ "$baseline_rc" -ne 0 ]; then
    c_red "✖ CRM no ar, mas o banco NÃO foi atualizado por completo. Veja .deskcomm-banco.log."
    exit 2
  fi

  printf '%s\n' "$(git rev-parse HEAD)" > "$DEPLOY_DIR/ultimo-deploy"
  # Mantém os 20 logs mais recentes.
  (ls -1t "$DEPLOY_DIR"/*.log 2>/dev/null || true) | tail -n +21 | xargs -r rm -f
  c_grn "✓ Deploy concluído em $(git rev-parse --short HEAD)."
}

main "$@"
exit $?
