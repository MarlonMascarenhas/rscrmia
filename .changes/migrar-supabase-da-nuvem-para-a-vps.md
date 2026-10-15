---
impacto: capacidade_nova
secao: adicionado
titulo: Um comando migra o Supabase da nuvem para a própria VPS, com conferência e volta automática
---

Quem usa o CRM com o Supabase na nuvem (por exemplo o plano grátis) agora pode passar para o modo single-server, com o Supabase instalado na mesma VPS, rodando `bash hostgator-setup-kit/migrar-da-nuvem.sh` na pasta do projeto. O comando copia usuários, dados e anexos, confere as contagens da nuvem contra as do servidor e só liga o CRM quando tudo bate. Se qualquer etapa falhar, ele volta sozinho para a nuvem e o CRM sobe como estava; o projeto na nuvem nunca é alterado nem apagado.

Antes de migrar, `--dry-run` só olha a nuvem e conta o que seria copiado, sem mudar nada. `--somente-arquivos` retoma a cópia dos anexos de uma migração que parou, e `--voltar` desfaz a migração. Durante a migração o CRM fica fora do ar (do passo 3 ao 12), então escolha um horário de pouco movimento. As mensagens além das 100 mais recentes de cada conversa são podadas no servidor antes de copiar a mídia, o que reduz o espaço usado pelos anexos. Quem constrói as imagens na própria VPS mantém essas imagens: o roteiro fixa `pull_policy=never` para o instalador não trocá-las pelas publicadas.

O passo a passo, o que conferir e o que ainda deve ser confirmado num ensaio estão em `docs/runbooks/migrar-supabase-nuvem-para-vps.md`.
