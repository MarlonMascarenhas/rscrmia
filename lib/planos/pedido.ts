/**
 * O ESTADO DE COBRANÇA, UMA VEZ POR REQUISIÇÃO — E SEM PESO NO GRAFO DE IMPORTS.
 *
 * ═══ POR QUE ISTO EXISTE, E POR QUE NÃO ESTÁ EM `estado.ts` ═══
 *
 * O gate entra em `requireRole`, que é chamado por 249 rotas, e no layout, que
 * renderiza toda tela. Sem memo, uma requisição que passa por gate + layout +
 * duas guardas pagaria a leitura quatro vezes. `cache()` do React resolve isso
 * por requisição, de graça — é o mesmo mecanismo que `resolveActiveOrg`
 * (`lib/auth/server.ts:284`) já usa.
 *
 * Mora em arquivo separado porque `cache()` só tem sentido dentro do contexto de
 * uma requisição React. `workers/` e o motor de IA importam `lerEstadoDeCobranca`
 * de `estado.ts` diretamente — lá cada tique é um contexto novo.
 *
 * ═══ O CLIENTE ADMIN É IMPORTADO PREGUIÇOSAMENTE, E ISSO NÃO É ESTILO ═══
 *
 * `lib/supabase/admin.ts` importa `lib/env.ts`, que VALIDA o ambiente no instante
 * do import e lança se faltar variável. Importar o cliente admin no topo deste
 * arquivo — que `lib/auth/require-role.ts` e `lib/mcp/auth.ts` importam — fez
 * 267 arquivos de teste falharem no carregamento: nenhum deles tinha o ambiente,
 * e nenhum deles precisava de banco, mas todos passavam por `requireRole`.
 *
 * O `import()` dentro da função adia a validação para o instante em que a guarda
 * realmente consulta. E o `try/catch` em volta garante o que o desenho já exige:
 * a guarda NUNCA lança. Sem ambiente válido o aplicativo nem sobe em produção,
 * então cair em "não medido" — que libera e ALARMA (`decisao.ts`) — só acontece
 * onde não há cobrança a proteger.
 *
 * ═══ CLIENTE ADMIN, E POR QUE NÃO O DO USUÁRIO ═══
 *
 * `platform_config` é revogada de `authenticated` (é da INSTALAÇÃO), então a
 * chave `COBRANCA_LIGADA` não é legível pelo cliente da sessão. E `assinaturas`
 * tem policy de leitura, mas o gate não pode depender de RLS para decidir se o
 * gate se aplica — seria circular.
 *
 * O uso de service role aqui é seguro pela regra do CLAUDE.md: o `organizationId`
 * vem SEMPRE de fonte confiável (o cookie já validado contra as memberships, o
 * token resolvido no servidor, ou o recurso lido pela RLS), nunca do corpo.
 */
import { cache } from "react";

import { logger } from "@/lib/logger";
import {
  estadoDeCobrancaIndeterminado,
  lerEstadoDeCobranca,
  type EstadoDeCobranca,
} from "@/lib/planos/estado";

/**
 * O estado de cobrança da organização, memoizado por requisição. Nunca lança.
 *
 * `organizationId` tem de vir de fonte confiável — `resolveActiveOrg`, o token
 * resolvido no servidor, ou o recurso já autorizado pela RLS. Nunca do body.
 */
export const estadoDeCobrancaDoPedido = cache(
  async (organizationId: string): Promise<EstadoDeCobranca> => {
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      return await lerEstadoDeCobranca(createAdminClient(), organizationId);
    } catch (erro) {
      logger.error("cobrança: não foi possível obter o cliente para medir o estado — NÃO MEDIDO", {
        organization_id: organizationId,
        detalhe: erro instanceof Error ? erro.message : String(erro),
      });
      return estadoDeCobrancaIndeterminado();
    }
  },
);

/**
 * O uso atual de um teto, medido agora. Nunca lança; `null` = não medido.
 *
 * Sem `cache()`, de propósito: o estado de cobrança quase não muda dentro de uma
 * requisição, mas uma contagem muda a cada criação — memoizar aqui faria uma rota
 * que cria dois recursos em sequência enxergar o uso de antes do primeiro.
 */
export async function usoDoPedido(
  organizationId: string,
  limite: import("@/lib/planos/limites").LimiteDePlano,
): Promise<number | null> {
  try {
    const [{ createAdminClient }, { medirUso }] = await Promise.all([
      import("@/lib/supabase/admin"),
      import("@/lib/planos/uso"),
    ]);
    return await medirUso(createAdminClient(), organizationId, limite);
  } catch (erro) {
    logger.warn("cobrança: não foi possível medir o uso — NÃO MEDIDO", {
      organization_id: organizationId,
      limite,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}
