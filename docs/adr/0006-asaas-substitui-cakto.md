# ADR-0006 — O Asaas substitui a Cakto como provedor de cobrança

- **Status:** aceito em 2026-10-18 pelo dono deste fork
- **Data:** 2026-10-18
- **Migration:** `0397_cobranca_pelo_asaas`
- **ADR que estende:** [`0005-cakto-substitui-stripe.md`](0005-cakto-substitui-stripe.md) e
  [`0004-cobranca-por-assinatura-neste-fork.md`](0004-cobranca-por-assinatura-neste-fork.md) — troca
  o provedor de pagamento pela segunda vez; o desenho do gate (item nasce desligado,
  `acesso_liberado_ate`, três pontos de gate, preço append-only, máquina de estados neutra de provedor)
  não muda
- **Lei que diverge:** as decisões 1, 2, 3, 7 e 8 da ADR-0005, que descrevem a Cakto (produto/oferta,
  `?callback=`, HMAC, sem portal, redirecionamento manual)

---

## Contexto

O dono deste fork decidiu cobrar as assinaturas por organização pelo **Asaas**, para que o cliente
escolha **Pix, boleto ou cartão** na fatura. Como o Stripe na 0395, a **Cakto sai do CÓDIGO, não do
banco**: as colunas `cakto_*` e a tabela `cobranca_eventos_cakto` ficam MORTAS, comentadas como tal pela
migration `0397`, sem nenhum `DROP` — a doutrina de migrations deste repositório proíbe derrubar coluna
que um clone possa ter em uso.

`lib/planos/decisao.ts`, `estado.ts`, `config.ts`, `guarda.ts` e a máquina `cobranca/maquina.ts`
(efeitos `pago`, `falhou`, `nao_renova`, `estornado`, `proximaAssinatura`) **não mudaram de semântica**:
a máquina já era neutra de provedor, e esta é a segunda troca que ela atravessa sem edição de lógica.

## Decisão

1. **Sem produto nem oferta.** O Asaas só precisa de um **cliente** (o pagador) e de uma **assinatura**.
   `POST /subscriptions` com `billingType: UNDEFINED` (quem escolhe a forma de pagar é o cliente, na
   fatura), `value` em reais (a conversão de `_cents` acontece só na chamada), `nextDueDate` de hoje em
   `America/Sao_Paulo`, `cycle` `MONTHLY` ou `YEARLY` e `externalReference` = o token opaco do registro
   nosso. A resposta não traz link: o link é o `invoiceUrl` da primeira cobrança, buscada em
   `GET /subscriptions/{id}/payments` com algumas tentativas. Sem link, o checkout responde erro claro
   (`fatura_indisponivel`) e a assinatura já está registrada.
2. **CPF/CNPJ vai ao Asaas e a mais lugar nenhum.** É pedido uma vez, num diálogo (nome + documento,
   validado pelo dígito verificador nos dois lados), só quando a organização ainda não tem cliente no
   Asaas. Guardamos o **id do cliente** (`assinaturas.asaas_cliente_id` e `cobranca_checkouts.asaas_cliente_id`),
   nunca o documento: nem no banco, nem no log, nem no audit — e `chamarAsaas` não loga corpo de
   requisição por esse motivo. Antes de criar o cliente, busca `GET /customers?externalReference=<organização>`
   (o filtro existe na documentação): a API aceita cadastro duplicado, e uma tentativa que falhou depois de
   criar não recria às cegas.
3. **O vínculo pagamento → organização é por dado nosso.** O registro de `cobranca_checkouts` nasce
   **antes** da assinatura, com um token `dc_...` que vai como `externalReference` dela; o id da assinatura
   é gravado nele assim que o Asaas responde. A ordem de resolução de um evento é: (a) organização forçada
   (ligação manual); (b) o `externalReference` do evento = `cobranca_checkouts.session_id`; (c) o id da
   assinatura em `assinaturas.asaas_assinatura_id`; (d) o id da assinatura em `cobranca_checkouts`; (e) uma
   consulta `GET /subscriptions/{id}` para ler o `externalReference` — que cobre a janela em que o webhook
   chega antes de o checkout guardar o id. Nada do payload sobre o pagador resolve organização. Sem
   resolução: recibo com organização nula, para ligação manual em `/admin`. Assinatura da conta cujo
   `externalReference` não é um token nosso é **ignorada** (a conta do Asaas pode ter outras cobranças).
4. **O webhook autentica por token.** O Asaas envia o token configurado no header `asaas-access-token`;
   comparado por hash com `timingSafeEqual`. Sem `ASAAS_WEBHOOK_TOKEN` a rota responde 404. Não há
   assinatura de corpo nem timestamp — a defesa contra replay é a idempotência: o recibo
   (`cobranca_eventos_asaas`, PK = `id` do **evento**) é gravado antes do efeito.
5. **200 é a resposta padrão.** O Asaas só conta HTTP 200 como entrega e **pausa a fila após 15 falhas
   seguidas**. Duplicata, evento ignorado e payload ilegível (já autenticado) respondem 200; só a falha
   real e recuperável (banco fora, erro ao aplicar) responde 500 — e a reentrega **reprocessa** (uma linha
   com `erro` ou reservada há mais de 60s sem `processado_em` não vira "já processado").
6. **O mapa evento → efeito.** `PAYMENT_RECEIVED` e `PAYMENT_CONFIRMED` → `pago` (o cartão libera no
   CONFIRMED; o mesmo pagamento pode chegar nos dois); `PAYMENT_OVERDUE` → `falhou`; `PAYMENT_REFUNDED` e
   `PAYMENT_CHARGEBACK_REQUESTED` → `estornado`; `SUBSCRIPTION_DELETED` e `SUBSCRIPTION_INACTIVATED` →
   `nao_renova`; `PAYMENT_CREATED` → só registra o link e o vencimento da fatura em aberto
   (`assinaturas.asaas_fatura_url` / `asaas_fatura_vencimento`); o resto é ignorado e gravado no recibo.
7. **O prazo liberado sai do vencimento da cobrança paga, não de "hoje".** `proximoVencimento` soma um
   ciclo (mês ou ano, com o dia limitado ao último do mês) ao `dueDate` do pagamento, no **fim do dia em
   São Paulo**, e `fimDoAcessoPago` acrescenta a margem de 1 dia da ADR-0005 (item 5). Assim o mesmo
   pagamento entregue em `CONFIRMED` e depois em `RECEIVED` dá o mesmo prazo — o efeito é idempotente sem
   precisar de uma tabela de pagamentos vistos. Pagamento muito atrasado cai no intervalo a partir de agora.
8. **Cancelar pela tela remove a assinatura no Asaas** (`DELETE /subscriptions/{id}`, que apaga as
   cobranças pendentes e gera `SUBSCRIPTION_DELETED`), e o **acesso** segue até o fim do período já pago
   (`nao_renova`). Troca de plano remove a assinatura antiga quando a nova é paga, como na ADR-0005.
9. **Credenciais no cofre da instalação**, com o `.env` como piso: `ASAAS_API_KEY` (segredo),
   `ASAAS_WEBHOOK_TOKEN` (segredo, 32–255 caracteres) e `ASAAS_AMBIENTE` (`sandbox` | `producao`; vazio
   vale `sandbox`, o padrão seguro). A tela avisa quando o prefixo da chave (`$aact_prod_` / `$aact_hmlg_`)
   não combina com o ambiente. O botão **Testar** (`POST /api/v1/admin/cobranca/asaas/testar`) faz
   `GET /customers?limit=1` e devolve o ambiente testado.
10. **A regra de publicação do preço muda.** `plano_precos_publicado_tem_provedor` exigia
    `cakto_oferta_id`; o Asaas não tem oferta. Passa a exigir só `valor_cents > 0` (preço publicado tem de
    ser cobrável). A migration despublica antes o que tinha valor ≤ 0. O checkout também recusa preço que
    não seja em `BRL`: o Asaas cobra em reais e a API não tem campo de moeda.

## O que ainda não foi medido (a confirmar no sandbox)

Nenhum destes pontos foi confirmado contra uma resposta real do Asaas. Tudo acima vem da documentação
(docs.asaas.com), lida em 2026-10-18; a lista existe para não se transformar, por omissão, em fato:

- **Fuso de `dateCreated`** do evento (`"2026-06-12 16:45:03"`, sem fuso declarado). Por isso a ordem dos
  eventos é a do **recebimento**, e não a desse campo. Com envio sequencial isso basta; sem ele, um evento
  atrasado pode parecer mais novo do que é.
- **Se `payment.externalReference` herda o `externalReference` da assinatura** nas cobranças geradas. O
  código funciona sem isso (resolve pelo id da assinatura), mas o degrau (b) só vale se herdar.
- **Se a primeira cobrança aparece em `GET /subscriptions/{id}/payments` imediatamente.** O código tenta 4
  vezes com 1s de intervalo; se o sandbox demorar mais, o cliente vê "estamos preparando a sua fatura".
- **Se `PAYMENT_CONFIRMED` é emitido para Pix e boleto**, ou só para cartão. Os dois mapeiam para `pago`,
  então o resultado é o mesmo, mas a documentação não diz quando cada um chega.
- **O ciclo `YEARLY` e o `nextDueDate` de hoje**: se o Asaas gera a primeira cobrança com vencimento
  imediato (hoje) ou no dia seguinte, e como um boleto vence no mesmo dia.
- **O limite de tamanho de `description` e `externalReference`** (o código usa 500 e ~35 caracteres).
- **Se o retorno após o pagamento pode ser configurado** (`callback.successUrl` na criação da assinatura
  existe no schema da API). Não é usado: hoje o cliente paga na fatura e volta à mão, e a tela de
  Cobrança mostra o acesso quando o webhook chega.
- **Se `DELETE /subscriptions/{id}` numa assinatura já paga preserva a cobrança paga** (a documentação diz
  que as pagas "permanecem registradas").
- **Chargeback em disputa e reversão** (`PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`):
  não tratados; o acesso já foi cortado em `PAYMENT_CHARGEBACK_REQUESTED`.
- **Nenhuma prova de ponta a ponta foi feita**: nem a API nem o webhook reais foram chamados nesta
  entrega. A primeira prova é no ambiente `sandbox`, forçando o pagamento pelo endpoint "(Apenas sandbox)
  Confirmar o pagamento", e depois uma cobrança real de valor baixo em produção.

## Limitações conhecidas desta versão

- **Checkout abandonado deixa assinatura no Asaas.** Quem clica em Assinar, vê a fatura e fecha a página
  deixa uma assinatura pendente; clicar de novo cria outra. Não se remove a anterior de propósito: um
  pagamento já feito cuja confirmação ainda não chegou (`pago_em` nulo) teria a recorrência destruída.
  O custo é uma cobrança vencida sem efeito (o acesso nunca depende dela) e, no webhook, eventos de
  assinatura "antiga" registrados como `ignorado_assinatura_antiga`.
- **Assinaturas que estavam na Cakto não migram.** O acesso segue até a data já paga; as renovações da
  Cakto não chegam mais. Cabe ao operador cancelá-las lá e pedir nova assinatura (ver o fragmento
  `.changes/cobranca-pelo-asaas.md`).
- **Sem troca de cartão pela tela.** Como na ADR-0005; a fatura hospedada do Asaas cobre o pagamento.
- **Conta do Asaas compartilhada.** O webhook recebe os eventos da conta inteira. Cobrança avulsa e
  assinatura de terceiros são ignoradas, mas uma conta dedicada é mais limpa.

## O que foi recusado

- **Manter a Cakto como segundo provedor.** A ADR-0004 prevê um único provedor por vez.
- **`DROP` das colunas e da tabela da Cakto.** Ver Consequências.
- **Guardar o CPF/CNPJ** para "não pedir de novo". Basta o id do cliente do Asaas; o documento é dado
  pessoal que o CRM não precisa ter.
- **Criar uma tabela de pagamentos vistos** para a idempotência do `pago`. O prazo sai do vencimento da
  cobrança paga, o que torna o efeito idempotente sem estado novo.
- **Resolver a organização pelo e-mail ou pelo id do cliente do payload** (os degraus (b) e (c) da
  ADR-0005). Nada do que o pagador informa resolve organização; a função
  `fn_cobranca_orgs_do_admin_por_email` fica no banco, sem uso novo.

## Consequências

- **Colunas mortas, sem `DROP`.** `planos.cakto_produto_id`, `plano_precos.cakto_oferta_id`,
  `assinaturas.cakto_assinatura_id`, `assinaturas.cakto_cliente_id`, as colunas `cakto_*` de
  `cobranca_checkouts` e a tabela `cobranca_eventos_cakto` ficam no schema, comentadas como mortas pela
  `0397`. `cobranca_checkouts.provedor` continua admitindo `'stripe'` e `'cakto'` (linhas antigas), e o
  padrão passa a `'asaas'`.
- **As credenciais `CAKTO_*` saem de `lib/env.ts`, do catálogo e do `.env.example`.** Uma instalação que
  as tenha no `.env` não quebra (variável não declarada é ignorada), e o cofre guarda linhas antigas
  `CAKTO_*` sem ninguém que as leia.
- **Doutrina de packaging intacta:** as mesmas três imagens, nenhuma variável obrigatória nova (`ASAAS_*` são
  opcionais). O fragmento é `exige_acao`: quem usa o pagamento online precisa cadastrar a chave e o webhook.

## Como verificar sem acreditar neste texto

```bash
# a migration que faz a troca, e o que ela declara morto
sed -n '1,10p' supabase/migrations/20261018120000_0397_cobranca_pelo_asaas.sql

# o cliente, o webhook, o aplicador e as rotas, com os casos que os cobrem
pnpm vitest run tests/unit/asaas-cliente.test.ts tests/unit/asaas-webhook-e-maquina.test.ts \
  tests/unit/asaas-aplicar.test.ts tests/unit/asaas-sessoes.test.ts tests/unit/asaas-webhook-rota.test.ts

# o mapa evento -> efeito
grep -n "case \"" lib/planos/asaas/webhook.ts

# a máquina de estados: só comentários mudaram nesta troca
git diff --stat origin/main -- lib/planos/cobranca/maquina.ts
```
