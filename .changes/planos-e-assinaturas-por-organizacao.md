---
impacto: capacidade_nova
secao: adicionado
titulo: A instalação pode cobrar assinatura por organização, com planos, limites e pagamento online (Stripe)
---

Quem administra a instalação passa a poder vender acesso: um catálogo de **planos** com preço, capacidades e limites definido em **Planos** (menu do administrador), teste grátis para quem se cadastra, bloqueio por vencimento e pagamento online pelo Stripe — ou liberação à mão, para Pix por fora e cortesias.

**Nada muda em quem só atualizou.** A cobrança nasce **desligada** e é o primeiro degrau de toda decisão de acesso: enquanto ela não for ligada, nenhuma organização é bloqueada, nenhuma tela desaparece e nenhum aviso aparece. Organizações que já existiam ficam **sem prazo de vencimento** para sempre — atualizar o produto nunca tira acesso de quem já usava. O teste grátis **só começa a contar depois que você ligar a cobrança**: do contrário, ligar um mês depois de instalar trancaria de uma vez todas as organizações que passaram de 14 dias, a sua inclusive.

Para começar a cobrar:

1. Em **Planos**, crie os planos com preço, o que cada um inclui e os tetos (usuários, conexões, contatos, mensagens por mês, campanhas por mês, tokens de API, agentes). Um plano pode marcar "libera tudo", e aí ele inclui também as capacidades que forem criadas depois. Mudar o preço de um plano cria um preço novo: quem já assinou continua no valor que assinou.
2. Para o cliente assinar sozinho, cadastre a chave e o segredo do webhook do Stripe em **Credenciais › Cobrança (Stripe)** — comece por chaves de teste. No painel do Stripe, o webhook aponta para `https://SEU-DOMINIO/api/v1/webhooks/stripe`. Sem isso o cliente vê os planos e fala com você; você segue liberando à mão.
3. Ainda em **Planos**, no cartão **Cobrança**, ajuste os dias de teste e de carência e ligue a cobrança. A tela diz, antes do clique, quantas organizações já estão vencidas e seriam bloqueadas na hora.

Os tetos nascem em modo **só avisar** e sobem um degrau por vez até **bloquear**: ninguém é recusado sem antes ter sido avisado.

Quem vence continua **recebendo** mensagem — a ingestão do WhatsApp nunca é bloqueada, para nenhuma conversa ser perdida. O que para é enviar, responder, campanha, IA e acesso por API. A tela de bloqueio é autossuficiente: mostra os planos, deixa trocar para outra organização sua e sair; e **Cobrança** (em Configurações) mostra plano, uso e abre o portal do Stripe para cartão, faturas e cancelamento.

Você libera acesso à mão em **Organizações › (a organização) › Assinatura** — Pix por fora, cortesia ou acordo. Toda liberação grava quem liberou e por quê, e "sem prazo" é uma escolha explícita, nunca um campo em branco.

O que **não** existe nesta versão: teto de gasto de IA por plano (o gasto de IA segue governado pelo orçamento de cada organização, em IA › Uso).
