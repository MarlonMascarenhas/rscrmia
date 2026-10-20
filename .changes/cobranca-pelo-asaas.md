---
impacto: exige_acao
secao: alterado
titulo: A cobrança por assinatura passa a ser feita pelo Asaas (Pix, boleto ou cartão), no lugar da Cakto
---

O pagamento online das assinaturas por organização passa a usar o **Asaas**. Na hora de assinar, o cliente informa o nome e o CPF ou CNPJ (que vão direto para o Asaas e **não** ficam guardados no sistema) e escolhe **Pix, boleto ou cartão** na fatura do Asaas. A tela de **Cobrança** mostra "Fatura em aberto — pagar" quando há uma cobrança pendente, e a tela de assinatura vencida também leva até ela.

A Cakto sai do produto: a rota `/api/v1/webhooks/cakto` deixa de existir e as credenciais `CAKTO_*` deixam de ser lidas. Nada é apagado do banco.

**Quem nunca ligou a cobrança não percebe nada**: ela continua desligada por padrão, e nenhuma organização perde acesso por atualizar.

## Requer atenção

Se você usa o pagamento online:

1. Em **Credenciais › Cobrança (Asaas)** cadastre a **chave de API** do Asaas (`$aact_prod_...` em produção, `$aact_hmlg_...` em testes), um **token do webhook** (uma senha de 32 a 255 caracteres que você inventa) e o **ambiente** (`sandbox` ou `producao`; vazio vale `sandbox`). O botão **Testar credenciais** na tela **Planos** confirma que a chave vale para o ambiente escolhido.
2. No painel do Asaas, crie um **webhook** apontando para `https://SEU-DOMINIO/api/v1/webhooks/asaas`, com o mesmo token, envio **sequencial**, e marque os eventos `PAYMENT_CREATED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `SUBSCRIPTION_DELETED` e `SUBSCRIPTION_INACTIVATED`. Se o seu servidor falhar 15 vezes seguidas, o Asaas pausa a fila e os pagamentos deixam de liberar acesso até você reativá-la lá.
3. **Assinaturas que já estavam na Cakto não migram sozinhas**: o acesso delas segue até a data já paga, mas as renovações cobradas pela Cakto não chegam mais ao sistema. Cancele-as no painel da Cakto e peça aos clientes que assinem de novo (ou continue liberando o acesso à mão, como antes).
4. Use uma conta do Asaas que não tenha outras cobranças suas, se puder: o webhook recebe os eventos da conta inteira, e o sistema ignora o que não nasceu dele.
