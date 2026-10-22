---
impacto: capacidade_nova
secao: adicionado
titulo: Deploy automático do fork na VPS por SSH a cada merge na main
---

Quem opera o fork em modo single-server ganha o script `hostgator-setup-kit/deploy-fork.sh` e o workflow `deploy-vps.yml`: a cada merge na `main` a VPS faz backup, constrói as imagens, reaplica o banco e sobe o CRM, voltando as imagens anteriores se o app não ficar saudável. Só roda no repositório do fork e só depois de cadastrados os segredos descritos em `docs/runbooks/deploy-automatico-fork.md`; nenhuma instalação existente muda sozinha.
