# ADR-0004 — Cobrança por assinatura, por organização, inerte por padrão

- **Status:** aceito em 2026-09-26 pelo dono deste fork
- **Data:** 2026-09-26
- **Migration:** `0393_planos_e_assinaturas`
- **Lei que diverge:** [`VISION.md`](../../VISION.md) ("não vendemos assinatura, não existe feature travada") e
  [`CLAUDE.md`](../../CLAUDE.md) ("monetização = self-host, não assinatura")
- **Lei que se preserva:** [`docs/doctrine/extensoes.md`](../doctrine/extensoes.md), não-negociável 12
  ("recurso já distribuído não é extraído sem equivalência e migração")

---

## Contexto

O upstream se define por não vender assinatura: software MIT completo, monetizado por
infraestrutura. Este fork opera **uma instalação atendendo vários clientes pagantes** (SaaS), e
precisa de planos com preço que o dono define por tela, limites por plano, teste grátis,
checkout automático e uma porta manual para liberar acesso. Nada disso existia: `lib/billing/`
estava vazio, `organizations.settings.plan` era lido por nada, e o único teto era o de gasto de
IA (`ai_budgets`), que é a organização se protegendo do próprio provedor de LLM, não a instalação
cobrando a organização.

A licença MIT permite o SaaS comercial. O que este ADR registra é que **isto é uma divergência
do upstream, não uma contribuição** — e por que ela foi desenhada para ser barata de carregar.

## Decisão

1. **A cobrança nasce desligada e é o primeiro degrau de toda decisão.** `platform_config.COBRANCA_LIGADA`
   vale `desligado` na migration; `lib/planos/decisao.ts` devolve `cobranca_desligada` antes de olhar
   assinatura, plano ou data. Uma instalação que só atualizou o produto não muda em nada — nenhuma
   feature fica atrás de pagamento, nenhuma tela some, nenhuma faixa aparece. É isto que mantém a
   não-negociável 12 verdadeira **em código**, e não só em prosa.
2. **Uma coluna responde o gate:** `organizations.acesso_liberado_ate`. `null` é **sem prazo**, nunca
   "vencido" — organização anterior à cobrança não perde acesso por atualizar. O vencimento é uma
   comparação de data por requisição, sem cron no caminho.
3. **`organizations.status` não ganha valor de cobrança.** Ele já é suspensão administrativa, e
   dois escritores — o dono e o provedor de pagamento — numa coluna se sobrescrevem: o pagamento
   reativaria quem foi suspenso por abuso.
4. **Três pontos de gate, uma guarda:** `requireRole` (249 rotas), `validateBearerToken` (o ramo
   Bearer, inclusive o envio de mensagem) e `exigirAcessoLiberado` (as rotas que só resolvem
   `resolveActiveOrg`). `tests/unit/planos-gate-cobre-toda-rota.test.ts` varre o AST de todo
   `app/api/v1` e reprova a rota que não chega a nenhum deles nem está numa allowlist com razão escrita.
5. **A entrada nunca é trancada, só a saída.** `/api/v1/webhooks/**` fica de fora: barrar a ingestão
   do WhatsApp de quem venceu perderia conversa para sempre, e barrar o webhook do provedor faria o
   pagamento não conseguir destrancar a conta que acabou de pagar.
6. **A assimetria é deliberada.** *Acesso* falha **aberto** (um soluço de banco não pode trancar a base
   pagante inteira) e *capacidade* falha **fechado** com 503 (o raio é uma feature, não o produto).
   Em ambos, o "não medi" é um estado próprio (`naoMedido`) que **alarma** — nunca se disfarça de
   "está em dia" nem de "não inclui".
7. **Preço é append-only.** Mudar o valor cria linha nova e arquiva a antiga: o `Price` do provedor é
   imutável, quem já assinou fica no preço que assinou (CDC), e o mandato do Pix Automático falha
   acima do valor autorizado.
8. **Stripe por `fetch` na API REST, sem SDK.** `build-and-size` é check obrigatório e a verificação
   de assinatura é HMAC simples (o repo já faz igual nos webhooks do WAHA). A organização de um
   pagamento sai de **dado nosso** (`cobranca_checkouts`), nunca de `metadata` do payload.

## O que foi recusado

- **Usar `organizations.status` para inadimplência.** Ver 3.
- **Um teto de gasto de IA por plano.** O motor tem `ai_budgets` (escada, carência, alertas) e uma
  segunda régua de gasto é exatamente o defeito que a migration 0159 consertou. O vocabulário de
  limites **não** inclui `ia_cents_por_mes`; um teste o proíbe. Se um dia entrar, entra com o
  enforcement no motor, no mesmo PR.
- **Backfill de data nas organizações existentes.** Qualquer data faria o `update.sh` trancar quem já
  usava, `N` dias depois. Elas ficam sem prazo.
- **Teste grátis contando desde o cadastro, com a cobrança desligada.** Ligar a cobrança um mês
  depois trancaria de uma vez toda organização que passou de 14 dias — a do próprio dono inclusive.
  O teste só começa com a cobrança ligada.
- **Tabela de faturas e tela de cartão próprias.** O portal do provedor cobre as duas, com PCI do lado
  dele; uma cópia nossa envelheceria.
- **Bloquear o envio quando o teto é atingido logo de saída.** O modo dos tetos nasce `avisar` e sobe
  um degrau por vez (`off` → `avisar` → `bloquear`).

## Consequências

- **Custo de carregar a divergência:** o núcleo tem uma linha em cada ponto de inserção
  (`lib/auth/require-role.ts`, `lib/mcp/auth.ts`, `app/app/layout.tsx`, navegação, `lib/api/errors.ts`,
  `AdminSidebar`, e as rotas de criação com teto). Tudo o mais nasce em arquivos novos, em
  `lib/planos/` e nas rotas de `admin/planos`, `admin/cobranca` e `cobranca/`.
- **A doutrina de packaging não muda:** as mesmas três imagens, nenhuma variável obrigatória nova
  (`STRIPE_*` são opcionais e o cofre da instalação vence o `.env`).
- **Ligar a cobrança é uma decisão com preço visível:** a tela diz, antes do clique, quantas
  organizações já estão vencidas e seriam trancadas agora.

## Como verificar sem acreditar neste texto

```bash
# o gate alcança toda rota, ou a exceção está escrita
pnpm test:unit tests/unit/planos-gate-cobre-toda-rota.test.ts

# a cobrança nasce desligada e o teste só começa com ela ligada; RLS e grants sob o default ACL do Supabase
pnpm test:db tests/invariants/planos-isolamento.test.ts

# o baseline e a migration concordam sobre o vocabulário
pnpm test:unit tests/unit/planos-vocabulario-e-navegacao.test.ts

# quais portas de saída o gate isenta, e por quê
grep -n "prefixo:" lib/planos/guarda.ts
```
