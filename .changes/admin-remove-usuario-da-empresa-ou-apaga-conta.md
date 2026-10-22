---
impacto: capacidade_nova
secao: adicionado
titulo: O super admin pode remover um usuário de uma empresa ou apagar a conta dele
---

Na área do super admin (Usuários), há agora **Remover da empresa** (por vínculo, na lista e no detalhe) e **Apagar conta** (no detalhe do usuário, exige digitar o e-mail para confirmar). Remover da empresa revoga só o acesso àquela empresa; apagar a conta tira o login e todos os vínculos, e o histórico fica sem o vínculo.

O sistema **recusa e avisa** quando o usuário é o único admin ativo de uma empresa (lista quais), quando é super admin, quando é a própria conta, ou quando tem registros obrigatórios que dependem dele (como comissões) — nesse caso, remova-o das empresas em vez de apagar.
