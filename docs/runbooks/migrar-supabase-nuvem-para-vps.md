# Migrar o Supabase da nuvem para a própria VPS

Para quem roda o CRM com o Supabase **na nuvem** (por exemplo o plano grátis) e quer passar para o
modo single-server: Supabase self-hosted na mesma VPS, o que `hostgator-setup-kit/install-single-server.sh`
já instala. O roteiro único é `hostgator-setup-kit/migrar-da-nuvem.sh`. Ele copia os dados, confere e,
se algo falhar, volta sozinho para a nuvem.

> **Status:** escrito a partir da leitura do código e provado só com dublês
> (`tests/shell/migrar-da-nuvem.test.sh`). **Nunca foi executado contra um Supabase real.** Faça o
> ensaio descrito no fim antes de usá-lo numa instalação com clientes. Tudo o que o repositório não
> permite confirmar está na seção "A confirmar no ensaio".

## Antes de começar

- Rode **na VPS**, como root, na pasta do projeto (a que tem o `.env`).
- A janela é de **indisponibilidade**: o CRM fica parado do passo 3 ao 12. Mensagens que o WhatsApp
  tentar entregar nesse intervalo chegam a um app desligado — escolha um horário de pouco movimento.
- A nuvem precisa estar **ativa**. Projeto do plano grátis pausa sozinho; reanime no painel do Supabase.
- RAM: o roteiro cria 4 GB de swap (`/swapfile`, registrado no `/etc/fstab`) se a VPS não tiver nenhum.
- Espaço em disco: o banco e os anexos da nuvem passam a morar no disco da VPS. Confira com `df -h`.
- O `DOMAIN` e o DNS **não mudam**: o site continua no mesmo endereço.

## Comandos

```bash
cd /caminho/do/projeto
bash hostgator-setup-kit/migrar-da-nuvem.sh --dry-run           # só olha a nuvem e conta; não muda nada
bash hostgator-setup-kit/migrar-da-nuvem.sh                     # migra
bash hostgator-setup-kit/migrar-da-nuvem.sh --somente-arquivos  # retoma a cópia dos anexos (passo 10)
bash hostgator-setup-kit/migrar-da-nuvem.sh --voltar            # volta para a nuvem
```

Comece **sempre** pelo `--dry-run`: ele testa o banco e a API da nuvem e imprime tabelas, linhas,
usuários, buckets e tamanho dos anexos. Os arquivos de apoio ficam em `.runtime/migracao/` (que guarda
as chaves da nuvem: apague a pasta quando não precisar mais).

## O que cada passo faz

| # | Passo | Observação |
|---|---|---|
| 1 | Pré-checagem | root, `.env` existe e **não** está em `SINGLE_SERVER=1`, variáveis da nuvem presentes, `select 1` no banco da nuvem (90 s) e REST respondendo. Nuvem muda: **para sem tocar em nada**. Cria o swap se faltar |
| 2 | Guarda a volta | `.env` → `.env.nuvem` (se ainda não existe); variáveis da nuvem e as imagens que **estão rodando** vão para `.runtime/migracao/estado.env` |
| 3 | Para o CRM | `stop` de app, worker, scheduler |
| 4 | Lê a nuvem | tabelas de `public`, `auth.users`/`auth.identities`, contagens exatas, `storage.buckets` |
| 5 | Prepara o `.env` | tira `SUPABASE_DB_ADMIN_URL`; fixa as imagens em execução com `pull_policy=never`; fixa `REVERSE_PROXY=caddy` |
| 6 | Instala o Supabase local | `install-single-server.sh --domain …` em ambiente limpo; depois reafirma imagens e dono e para o CRM de novo |
| 7 | Copia os dados | esvazia o que o bootstrap criou; copia `auth.users`, `auth.identities`, depois `public`, só nas **colunas em comum** (sem colunas geradas); ajusta sequências; cria buckets que faltam |
| 8 | Baseline local | `reaplicar_baseline` (sementes e migration 0396) |
| 9 | Poda local | `fn_mensagens_excedentes(100, 1000)` + `fn_apagar_mensagens_excedentes(ids, 100)` até zerar — **antes** de copiar a mídia |
| 10 | Anexos | `whatsapp-media`: só o que as mensagens restantes citam. Demais buckets: tudo, listado pela API da nuvem. Retomável |
| 11 | Confere | contagens por tabela e arquivos esperados × presentes. Faltou algo: **não libera** |
| 12 | Sobe o CRM | `/api/v1/health` com `supabase: ok` e o domínio respondendo **307** |

## Se falhar

Qualquer falha entre os passos 3 e 12 aciona a volta automática: restaura `.env.nuvem` → `.env`, **para**
(`stop`, nunca `down -v`) o Supabase local — o volume e os dados já copiados ficam — e sobe o CRM com as
imagens que rodavam antes. A volta guarda o `.env` single-server em `.runtime/migracao/env.single-server`,
e é por ele que `--somente-arquivos` retoma sem refazer a cópia dos dados.

`--voltar` faz o mesmo à mão. Depois de uma migração **concluída**, ele pede para digitar `VOLTAR` (ou
`--sim`): tudo o que for criado depois da migração existe só no Supabase local e não volta para a nuvem.

## O que a migração NÃO leva

- **Sessões e fatores de MFA** (`auth.sessions`, `auth.mfa_factors` e demais tabelas de `auth` além de
  `users` e `identities`). Todos precisam entrar de novo; quem usa autenticador no Supabase **não perde a
  conta**, mas precisa recadastrar o fator (`hostgator-setup-kit/reset-mfa.sh` existe para isso).
- Tabelas que existem na nuvem e **não** existem no local: o roteiro avisa (e as lista em
  `.runtime/migracao/tabelas-so-na-nuvem.txt`); não é falha.
- Objetos de `whatsapp-media` que nenhuma mensagem restante cita.
- Mensagens além das 100 mais recentes por conversa (poda do passo 9). A nuvem não é tocada.
- Objetos que a nuvem lista mas não consegue baixar (`404`): ficam em `arquivos-ausentes.tsv` e **não**
  bloqueiam; qualquer outra falha bloqueia.

## Pontos do `install.sh` que o roteiro neutraliza

Lidos em `hostgator-setup-kit/install.sh` (é ele que o `install-single-server.sh` chama):

- Reescreve `WORKER_IMAGE`/`SCHEDULER_IMAGE` como `<IMG_NS do _common.sh>/…:<tag do APP_IMAGE>` e
  `*_PULL_POLICY=missing` (ou `always` se a tag for `latest`/`main`/`stable`), depois roda `docker compose pull`
  e `up -d`. Numa instalação com imagens `:local` isso desfaria o fork. O roteiro **recusa** tag móvel,
  dá às imagens locais os nomes que o instalador vai escrever (`docker tag`) e regrava as imagens reais
  com `pull_policy=never` assim que o instalador termina.
- O `install-single-server.sh` sobrescreve `OWNER_EMAIL`/`OWNER_PASSWORD` do `.env` com um dono novo
  (`admin@dominio`). O roteiro devolve as linhas originais e move `.runtime/admin-credentials` para
  `.runtime/migracao/`, porque esse usuário é apagado no passo 7.
- `SUPABASE_DB_ADMIN_URL` ficaria apontando para a nuvem e o baseline seria aplicado lá: sai do `.env` e
  o instalador roda com `env -i`.
- O `install.sh` **não** faz `git checkout`/`fetch` de tag (só clona se a pasta não for um repositório).
- Segredos (`WAHA_API_KEY`, `AI_CRED_AES_KEY`…) só são gerados se faltarem; o roteiro não os troca. Se a
  chave de cifra guardada no banco da nuvem (`private.app_secrets`) divergir da do `.env`, vale a do banco,
  que é a que cifrou os dados.

## WhatsApp (WAHA) no single-server

O WAHA chama o app por rede interna: `WAHA_WEBHOOK_BASE_URL=http://app:3000` (o `install.sh` grava esse
valor sempre) e o `Caddyfile.single-server` responde **403** em `/api/v1/webhooks/waha` para quem vem de
fora. Portanto a recepção **não** depende do domínio e não quebra pela migração. As sessões do WAHA
ficam no volume do próprio projeto, que o roteiro não toca.

## Depois de migrar

- O projeto da nuvem continua intacto: é a sua cópia de segurança. Só pause depois de alguns dias.
- `bash hostgator-setup-kit/backup.sh` já cobre banco **e** anexos no single-server; agende no cron.
- **Cuidado com `update.sh`:** ele regrava `APP_IMAGE` para as imagens publicadas (ver `docs/runbooks/deploy.md`
  e a doutrina em `docs/doctrine/packaging.md`). Quem constrói as imagens na VPS (`docker-compose.build.yml`)
  deve conferir o `.env` depois de qualquer atualização. Em single-server o build leva o override junto:
  `docker compose -f docker-compose.prod.yml -f docker-compose.single-server.yml -f docker-compose.build.yml build`.

## A confirmar no ensaio

O setup oficial do Supabase fica fora deste repositório, então estes pontos **não foram lidos em código** e
precisam de um ensaio (numa VPS descartável, com uma cópia da nuvem) antes de produção:

1. O usuário `postgres` do Supabase local pode usar `session_replication_role = replica` e escrever em
   `auth.users`/`auth.identities`? O roteiro **sonda** e, se não puder, tenta `supabase_admin` com a **mesma
   senha** do banco — a igualdade das senhas não foi confirmada. Se nenhum dos dois servir, o passo 7 para
   e a volta automática acontece.
2. A `postgres` da nuvem, via pooler, lê `storage.objects` e `private.app_secrets`? Só o relatório e a
   comparação da chave de cifra dependem disso (falha é tolerada).
3. `\copy ... from stdin` em tabelas com RLS ligada, rodando como dono: esperado funcionar (dono ignora RLS
   sem `FORCE`), não medido.
4. Insert em `storage.buckets` pelo mesmo usuário (passo 7) e o limite de tamanho de arquivo do Storage
   local: anexos grandes podem falhar no upload (aparecem em `falhas-arquivos.log` e bloqueiam o passo 11).
5. O endpoint `GET /storage/v1/object/authenticated/<bucket>/<caminho>` e a listagem
   `POST /storage/v1/object/list/<bucket>` (pastas com `id` nulo) na versão atual do Storage da nuvem.
6. `curl` com `-H @arquivo` (curl 7.55 ou mais novo) na VPS.
7. Tempo total e pico de memória com 2,4 GB de anexos e o banco real; e se o WAHA reentrega o que chegou
   durante a janela.

Roteiro do ensaio: `--dry-run` → migração completa numa cópia → `--voltar --sim` → migração de novo →
conferir `.runtime/migracao/relatorio.txt` → login pela tela com um usuário real → enviar e receber uma
mensagem de teste.
