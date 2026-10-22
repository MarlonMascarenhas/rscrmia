/**
 * Remove os objetos de storage de uma empresa que acabou de ser excluída.
 *
 * Todo bucket abaixo guarda os objetos sob o prefixo `{organization_id}/` — confirmado no código
 * que os grava (`storagePathFor` em `lib/messaging/media/types.ts`; `prefixoDaOrganizacao` em
 * `lib/branding/logo.ts`; e as rotas/workers que montam `${orgId}/...` para `ai-policy`,
 * `skill-assets`, `catalog-photos` e `lgpd-exports`). Um bucket novo com prefixo por organização
 * entra nesta lista; um sem prefixo por organização NÃO pode entrar (apagaria dado alheio).
 *
 * O storage do Supabase não lista recursivamente: cada pasta é uma chamada. Percorre pasta a pasta,
 * remove os arquivos de cada uma em lotes e empilha as subpastas. Nunca lança: cada falha vira uma
 * frase em `falhas`, e o chamador a devolve ao operador (o banco já foi excluído, e sobra de
 * arquivo órfão tem de ser dita, não engolida).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const BUCKETS_COM_PREFIXO_DE_ORGANIZACAO = [
  "whatsapp-media",
  "ai-policy",
  "lgpd-exports",
  "skill-assets",
  "brand-logos",
  "catalog-photos",
] as const;

const TAMANHO_DA_PAGINA = 1000;
const TAMANHO_DO_LOTE = 100;
/** Teto de pastas visitadas por bucket: protege contra laço, não contra volume. */
const TETO_DE_PASTAS = 10_000;

export interface ResultadoDaLimpezaDeArmazenamento {
  removidos: number;
  falhas: string[];
}

interface Entrada {
  name: string;
  /** `null` marca pasta no storage do Supabase. */
  id: string | null;
}

export async function removerObjetosDaEmpresa(
  db: SupabaseClient,
  organizationId: string,
): Promise<ResultadoDaLimpezaDeArmazenamento> {
  const resultado: ResultadoDaLimpezaDeArmazenamento = { removidos: 0, falhas: [] };

  for (const bucket of BUCKETS_COM_PREFIXO_DE_ORGANIZACAO) {
    try {
      const pilha: string[] = [organizationId];
      let visitadas = 0;
      while (pilha.length > 0) {
        const pasta = pilha.pop() as string;
        visitadas += 1;
        if (visitadas > TETO_DE_PASTAS) {
          resultado.falhas.push(`${bucket}: pastas demais; a limpeza parou no teto de ${TETO_DE_PASTAS}.`);
          break;
        }

        const arquivos: string[] = [];
        for (let offset = 0; ; offset += TAMANHO_DA_PAGINA) {
          const { data, error } = await db.storage
            .from(bucket)
            .list(pasta, { limit: TAMANHO_DA_PAGINA, offset });
          if (error) {
            resultado.falhas.push(`${bucket}: não foi possível listar uma pasta (${error.message}).`);
            break;
          }
          const entradas = (data ?? []) as Entrada[];
          for (const e of entradas) {
            if (e.id === null) pilha.push(`${pasta}/${e.name}`);
            else arquivos.push(`${pasta}/${e.name}`);
          }
          if (entradas.length < TAMANHO_DA_PAGINA) break;
        }

        for (let i = 0; i < arquivos.length; i += TAMANHO_DO_LOTE) {
          const lote = arquivos.slice(i, i + TAMANHO_DO_LOTE);
          const { error } = await db.storage.from(bucket).remove(lote);
          if (error) {
            resultado.falhas.push(`${bucket}: não foi possível remover ${lote.length} arquivo(s) (${error.message}).`);
          } else {
            resultado.removidos += lote.length;
          }
        }
      }
    } catch (erro) {
      resultado.falhas.push(`${bucket}: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  }

  return resultado;
}
