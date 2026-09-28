---
impacto: capacidade_nova
secao: adicionado
titulo: A raiz do site passa a ser uma página de vendas, e /painel é a porta de entrada do painel
---

O endereço raiz do seu domínio deixa de redirecionar para o painel e passa a mostrar uma **página de vendas** (LP) com apresentação do produto, recursos, como funciona, perguntas frequentes e os **planos**. O painel continua exatamente onde estava, em `/app`.

- **`/painel`** é a porta de entrada: quem já tem sessão vai direto para o produto, quem não tem cai no login. É o endereço para dar a um cliente e o que o botão "Entrar" da página usa. `/login` e `/signup` seguem funcionando como antes.
- **O nome e a cor** vêm da marca da instalação (Marca, no menu do administrador), como no resto do produto: nada do nome do produto fica escrito na página.
- **Os planos e os preços** vêm dos planos publicados em **Planos**. Mudou o preço lá, mudou na página. Sem nenhum plano publicado, a seção some sozinha.
- **O teste grátis só é anunciado quando existe**: com a cobrança desligada, o botão diz "Criar minha conta" e a página não fala em teste nem em cartão. Ligada, mostra os dias configurados e "sem cartão de crédito".
- A página é **indexável** por buscadores (o painel continua fora de busca) e está em português.

Quem já divulgava o endereço raiz como entrada do painel: passe a divulgar `/painel`, ou o botão "Entrar" da própria página.

- **O cadastro respeita o modo de cadastro da instalação**: "só por convite" tira o botão de cadastro e deixa só "Entrar"; "com aprovação" troca o botão para "Solicitar acesso".
- **Os botões "Voltar" das páginas de erro** levam ao painel (`/painel`), não mais à página de vendas.
