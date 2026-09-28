---
impacto: capacidade_nova
secao: adicionado
titulo: A raiz do site passa a ser uma página de vendas, e /painel é a porta de entrada do painel
---

O endereço raiz do seu domínio passa a mostrar a página de vendas da **RS CRM IA**: apresentação do produto, recursos, como funciona, depoimentos, perguntas frequentes, um guia de escolha e os **planos**. O painel continua exatamente onde estava, em `/app`.

- **`/painel`** é a porta de entrada: quem já tem sessão vai direto para o produto, quem não tem cai no login. É o endereço para dar a um cliente, e é para lá que o **"Entrar"** do topo da página leva.
- **Os preços dos cartões de plano vêm de Admin › Planos.** Mudou o preço lá, muda na página. Os itens de cada cartão dos planos Essencial, Profissional e Completo são fixos na página — quem publica um plano com outro nome recebe a lista de recursos e limites que cadastrou. Sem nenhum plano publicado, a seção mostra um aviso e o convite para criar conta, no lugar da vitrine.
- **Política de Privacidade e Termos de Uso** apontam para `/legal/privacy` e `/legal/terms` — as páginas legais que o produto já tem, em vez de um modal embutido na LP.
- Numa instalação **"só por convite"**, os botões de cadastro da página viram "Entrar" e levam a `/painel`, sem oferecer `/signup`.
- **Os botões "Voltar" das páginas de erro** (403, 500, 503) levam ao painel (`/painel`).
