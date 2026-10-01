# ADR-0005 — A Cakto substitui o Stripe como provedor de cobrança

- **Status:** aceito em 2026-09-29 pelo dono deste fork
- **Data:** 2026-09-29
- **Migration:** `0395_cobranca_pela_cakto`
- **ADR que estende:** [`0004-cobranca-por-assinatura-neste-fork.md`](0004-cobranca-por-assinatura-neste-fork.md) —
  troca o provedor de pagamento; o desenho do gate (item nasce desligado, `acesso_liberado_ate`,
  três pontos de gate, preço append-only) não muda
- **Lei que diverge:** a decisão 8 e o item "Tabela de faturas e tela de cartão próprias" (portal
  do provedor) da ADR-0004 — ver a nota deixada lá

---

## Contexto

O dono deste fork decidiu usar a **Cakto** (plataforma brasileira de pagamentos) em vez do
Stripe para cobrar as assinaturas por organização desenhadas na ADR-0004. **O Stripe sai do
CÓDIGO, não do banco**: as colunas `stripe_*` e a tabela `cobranca_eventos` ficam MORTAS,
comentadas como tal pela migration `0395_cobranca_pela_cakto`, sem nenhum `DROP` — a doutrina de
migrations deste repositório proíbe derrubar coluna que um clone possa ter em uso.

## Decisão

1. **O sistema cria produto e oferta na Cakto pela API, na primeira venda** — não pelo painel.
   `POST /public_api/products/` e `POST /public_api/offers/`, cada chamada com
   `X-Idempotency-Key` própria: `produto:<planos.id>` e `oferta:<plano_precos.id>`. A oferta
   mensal cobra a cada 30 dias, a anual a cada 365 (a Cakto cobra por intervalo de DIAS, não por
   "mensal"/"anual" como rótulo); `trial_days` vai **0** — o teste grátis é o nosso
   (`DIAS_DE_TESTE` da ADR-0004), não o da Cakto. As formas de pagamento aceitas na oferta ficam
   no padrão da Cakto, sem seleção nossa.
2. **O vínculo pagamento → organização é por um token opaco nosso**, não por dado do pagador. O
   link de checkout leva `?callback=<token>` (`https://pay.cakto.com.br/<oferta>?callback=<token>`);
   a Cakto devolve esse token em `data.callback`, e ele é guardado em
   `cobranca_checkouts.session_id`. Para renovações, a ordem de resolução é: (a) o id da
   assinatura da Cakto, gravado na primeira compra; (b) o id do cliente da Cakto; (c) por
   último, o e-mail do ADMIN da organização — só quando ele casa com **exatamente uma**
   organização. Sem nenhum dos três, o evento fica registrado como "sem organização" para
   ligação manual no `/admin`. **O e-mail do pagador nunca é guardado.**
3. **O webhook (`/api/v1/webhooks/cakto`) verifica por HMAC-SHA256**: os cabeçalhos
   `X-Cakto-Timestamp` e `X-Cakto-Signature: v1=<hex>`, o hex sobre `{timestamp}.{corpo cru}`,
   tolerância de 5 minutos contra replay. Alternativa documentada pela Cakto: um `secret` simples
   embutido no corpo. Cada evento gera um recibo idempotente em `cobranca_eventos_cakto`, com
   chave `<event>:<data.id>`. A Cakto só reenvia em falha de rede/timeout — uma resposta
   não-2xx nossa não volta —, por isso o erro fica gravado na linha, para o admin reprocessar.
4. **Cancelar pela tela cancela na Cakto imediatamente** (a API da Cakto não tem um modo "no fim
   do período"), mas o **acesso** segue até o fim do período já pago: o efeito é `nao_renova`,
   distinto de `cancelada`. Estorno e chargeback cortam o acesso na hora (efeito `estornado`),
   sem essa carência.
5. **O prazo liberado após pagamento é a próxima cobrança (ou "agora + intervalo do plano" quando
   a Cakto não manda a data) mais uma margem fixa de 1 dia** — para diferença de relógio entre o
   gateway e este servidor não fazer a renovação seguinte achar a conta vencida por segundos. Essa
   margem **não soma a carência** de inadimplência: se somasse, o aviso de pagamento pendente
   nunca apareceria a tempo.
6. **Troca de plano cancela a assinatura antiga na Cakto** no momento em que a nova é paga — sem
   pró-rata.
7. **Sem portal do cliente nem troca de cartão pela tela.** A Cakto não documenta um portal como o
   do Stripe; isto substitui a leitura da ADR-0004 de que essa parte ficaria a cargo do "portal do
   provedor" (ver a nota deixada lá).
8. **O redirecionamento pós-pagamento é configurado à mão no painel da Cakto** (Produto ›
   Configurações › Checkout, campo "Redirecionar após o pagamento"), apontando para
   `<APP_URL>/app/settings/billing?checkout=ok`. Não há chamada de API para isso — é passo manual
   do dono da instalação, uma vez por produto criado.

## O que ainda não foi medido

Nenhum destes pontos foi confirmado contra uma resposta real da Cakto — a lista existe para não
se transformar, por omissão, em fato:

- O formato exato de `data.subscription` nos eventos do webhook (quais campos além de `id`,
  `status` e `next_payment_date` a Cakto realmente manda, e se `status` tem vocabulário fixo) —
  visto só na documentação, nunca num payload real.
- Se `data.callback` volta também nos eventos de **renovação**, ou só no evento da primeira
  compra.
- Se cancelar a assinatura pela API da Cakto dispara, do lado dela, um evento
  `subscription_canceled` de volta para o nosso webhook.
- Se `intervalType` (o que definimos ao criar a oferta) ou `recurrence_period` (o que o evento
  devolve) prevalece quando os dois aparecem — qual a Cakto trata como fonte da verdade.
- Se a oferta **padrão** que a Cakto cria junto do produto fica ativa e vendável por fora do link
  que o nosso checkout gera.
- Não há ambiente de teste público documentado; a Cakto oferece staging só por pedido ao suporte
  (`infoprodutores@cakto.com.br`). Sem staging, a primeira prova de ponta a ponta é uma compra real
  de baixo valor, com estorno em seguida.

## O que foi recusado

- **Manter o Stripe como segundo provedor.** A ADR-0004 já previa um único provedor por vez
  (`cobranca_checkouts.provedor` como CHECK de valores, não como múltiplas cobranças simultâneas);
  a migração é troca, não adição.
- **`DROP` das colunas e da tabela do Stripe.** Ver Consequências.

## Consequências

- **Colunas mortas, sem `DROP`.** `plano_precos.stripe_price_id`, `assinaturas.stripe_customer_id`,
  `assinaturas.stripe_subscription_id`, `cobranca_checkouts.stripe_customer_id`,
  `cobranca_checkouts.stripe_subscription_id` e a tabela `cobranca_eventos` ficam no schema,
  comentadas como mortas pela migration `0395_cobranca_pela_cakto`. Um clone que já tinha dados do
  Stripe não perde histórico; um clone novo simplesmente nunca as popula.
- **O apêndice do baseline não recria a constraint de publicação do bloco da migration 0393.** A
  regra antiga (preço publicado exige provedor) mudou de forma na 0395 — publicado agora exige
  `cakto_oferta_id`, não mais "algum provedor" — e reaplicar a versão antiga no `update.sh` de um
  clone quebraria a atualização.
- **`STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET` seguem opcionais em `lib/env.ts`**, sem uso novo:
  não há remoção de env var, só a parada de leitura pelo código de cobrança.

## Como verificar sem acreditar neste texto

```bash
# a migration que faz a troca, e o que ela declara morto
sed -n '1,10p' supabase/migrations/20260929120000_0395_cobranca_pela_cakto.sql

# o cliente e o webhook da Cakto, e os casos que os cobrem
pnpm vitest run tests/unit/cakto-cliente.test.ts tests/unit/cakto-webhook-e-maquina.test.ts

# a margem de 1 dia sem somar carência
grep -n "MARGEM_DE_RENOVACAO_MS" lib/planos/cobranca/maquina.ts
```
