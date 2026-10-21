---
impacto: exige_acao
secao: corrigido
titulo: No modo single-server, o e-mail de confirmação e o de recuperação usam o modelo do app
---

Na instalação single-server, o Supabase (GoTrue) mandava o e-mail de confirmação de conta e de redefinição de senha com o modelo padrão do Supabase, cujo link o app recusava. Agora o GoTrue busca os modelos em `/email-templates/confirmation` e `/email-templates/recovery` do próprio CRM, com a marca da instalação.

## Requer atenção

Se você já instalou em modo single-server: atualize pelo `update.sh` (ele regrava o `docker-compose.deskcomm.yml` do Supabase) e confirme que o contêiner `auth` do Supabase foi recriado. Instalações novas já nascem certas.
