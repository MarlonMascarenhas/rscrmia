# Deploy automático do fork (single-server) por SSH

Vale só para o fork `MarlonMascarenhas/rscrmia`, instalado em modo single-server
(`SINGLE_SERVER=1`), com as imagens construídas na própria VPS. A cada push na
`main`, o workflow `.github/workflows/deploy-vps.yml` entra na VPS por SSH e roda
`hostgator-setup-kit/deploy-fork.sh`. O `update.sh` **não** serve aqui: ele puxa a
imagem do upstream e desfaz o fork.

> **Aviso de segurança.** Quem pode fazer merge na `main` passa a poder rodar código
> como root na VPS (o script roda como root e o código dele vem do repositório). Mantenha
> a branch protection e restrinja quem aprova PR.

## 1. Chave SSH dedicada (na VPS)

```bash
sudo -u administrator ssh-keygen -t ed25519 -N "" -C "deploy-github" -f /home/administrator/.ssh/deploy_github
sudo -u administrator sh -c 'cat /home/administrator/.ssh/deploy_github.pub >> /home/administrator/.ssh/authorized_keys'
chmod 600 /home/administrator/.ssh/authorized_keys
cat /home/administrator/.ssh/deploy_github      # chave PRIVADA: vai para o segredo VPS_SSH_KEY
```

Depois de copiar a privada para o GitHub, apague-a da VPS (`shred -u` no arquivo
`deploy_github`); só a `.pub` precisa ficar.

## 2. Sudo limitado ao script

```bash
echo 'administrator ALL=(root) NOPASSWD: /usr/bin/bash /home/administrator/rscrmia/hostgator-setup-kit/deploy-fork.sh, /usr/bin/bash /home/administrator/rscrmia/hostgator-setup-kit/deploy-fork.sh --forcar' \
  | sudo tee /etc/sudoers.d/deploy-fork >/dev/null
sudo chmod 440 /etc/sudoers.d/deploy-fork
sudo visudo -cf /etc/sudoers.d/deploy-fork     # tem de dizer "parsed OK"
```

Confira o caminho de `bash` com `command -v bash` e ajuste se não for `/usr/bin/bash`.

## 3. Host key fixada

De qualquer máquina que alcance a VPS:

```bash
ssh-keyscan -p <porta> <host>
```

A saída inteira vira o segredo `VPS_KNOWN_HOSTS`. Confira a impressão digital contra a
da VPS (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) antes de cadastrar.

## 4. Segredos no GitHub

Settings › Secrets and variables › Actions › New repository secret:

| Segredo | Valor |
|---|---|
| `VPS_HOST` | IP ou nome da VPS |
| `VPS_PORT` | porta do SSH |
| `VPS_USER` | `administrator` |
| `VPS_SSH_KEY` | conteúdo da chave privada do passo 1 |
| `VPS_KNOWN_HOSTS` | saída do `ssh-keyscan` do passo 3 |
| `VPS_APP_DIR` | `/home/administrator/rscrmia` |

Se faltar algum, o job falha dizendo qual cadastrar.

## 5. Testar

Actions › deploy-vps › Run workflow. Marque `forcar` para refazer o deploy mesmo sem
commit novo. Sem `forcar`, na primeira rodada o script faz o deploy (ainda não há
marcador do último deploy bem-sucedido) e nas seguintes sai com "Nada a fazer" se a
VPS já estiver no commit da `main`.

## Onde ver os logs

- GitHub: Actions › deploy-vps › a rodada (a saída do script vem inteira).
- VPS: `/home/administrator/rscrmia/.runtime/deploy/<data-hora>.log` (guarda os 20 últimos);
  o resultado do baseline fica em `.deskcomm-banco.log`.

## Como desligar

Actions › deploy-vps › menu `...` › Disable workflow. Para cortar de vez, apague o
segredo `VPS_SSH_KEY` e a linha da chave em `authorized_keys`, e remova
`/etc/sudoers.d/deploy-fork`. Dá para rodar à mão: `sudo bash hostgator-setup-kit/deploy-fork.sh [--forcar] [--sem-backup]`.

## O que o script faz quando algo falha

| Falha | O que acontece | Saída |
|---|---|---|
| Outro deploy em andamento | espera até 30 min pelo lock | — |
| `git` não é fast-forward / fetch falha | para sem mexer em nada | 1 |
| Backup falha | para sem mexer em nada (código e CRM como estavam) | 1 |
| Build falha | **o CRM não é parado**; segue na versão antiga; a próxima rodada refaz | 1 |
| Baseline do banco não fecha | sobe o CRM mesmo assim e avisa | 2 |
| App/worker não ficam saudáveis em ~3 min | volta as imagens `:anterior`, sobe de novo e verifica | 1 |

O banco **não volta** no rollback: o baseline só acrescenta, então a versão anterior
roda sobre ele. O código em disco (`git`) também não volta: fica no commit novo.
`--sem-backup` existe só para emergência.
