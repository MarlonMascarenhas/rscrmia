import { MENSAGENS_POR_CONVERSA } from "@/lib/retencao/politica";

/**
 * Linhas por transação. Pequeno o bastante para o lock não ser sentido por quem
 * está usando o sistema, grande o bastante para drenar um backlog de anos em
 * poucos dias de rodadas.
 */
export const TAMANHO_DO_LOTE = 1000;

/**
 * Teto de lotes POR TABELA e por invocação. Sem ele, a primeira rodada numa
 * instalação antiga tentaria apagar tudo de uma vez e seguraria a conexão do
 * cron (timeout de 120 s no crontab) até o `curl` desistir — deixando a
 * transação do último lote para o servidor abortar sozinho.
 */
export const MAX_LOTES = 20;

/** Só a superfície que a poda de mensagens usa — o teste injeta uma implementação. */
export interface PodaMensagensDb {
  rpc(
    nome: "fn_mensagens_excedentes" | "fn_apagar_mensagens_excedentes",
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface ResultadoDaPodaDeMensagens {
  apagadas: number;
  lotes: number;
  temResto: boolean;
  midiasRemovidas: number;
  avisos: string[];
}

/**
 * Apaga as mensagens além da janela de cada conversa, em lotes. A mídia sai do
 * Storage ANTES da linha (a linha é o único ponteiro para o arquivo); se o
 * Storage falhar, a linha é apagada mesmo assim e o arquivo órfão vira aviso —
 * reter a mensagem indefinidamente seria pior que um arquivo solto.
 */
export async function podarMensagensExcedentes(
  db: PodaMensagensDb,
  removerMidia: (paths: string[]) => Promise<{ error: { message: string } | null }>,
): Promise<ResultadoDaPodaDeMensagens> {
  let apagadas = 0;
  let lotes = 0;
  let midiasRemovidas = 0;
  const avisos: string[] = [];
  for (let i = 0; i < MAX_LOTES; i += 1) {
    const { data, error } = await db.rpc("fn_mensagens_excedentes", {
      p_manter: MENSAGENS_POR_CONVERSA,
      p_limite: TAMANHO_DO_LOTE,
    });
    if (error) throw new Error(`fn_mensagens_excedentes: ${error.message}`);
    const linhas = (Array.isArray(data) ? data : []) as Array<{
      id: string;
      media_storage_path: string | null;
    }>;
    if (linhas.length === 0) return { apagadas, lotes, temResto: false, midiasRemovidas, avisos };
    lotes += 1;

    const paths = linhas
      .map((l) => l.media_storage_path)
      .filter((p): p is string => typeof p === "string" && p !== "");
    if (paths.length > 0) {
      const { error: erroMidia } = await removerMidia(paths);
      if (erroMidia) {
        avisos.push(`mídia de ${paths.length} mensagem(ns) não removida: ${erroMidia.message}`);
      } else {
        midiasRemovidas += paths.length;
      }
    }

    const { data: n, error: erroApagar } = await db.rpc("fn_apagar_mensagens_excedentes", {
      p_ids: linhas.map((l) => l.id),
      p_manter: MENSAGENS_POR_CONVERSA,
    });
    if (erroApagar) throw new Error(`fn_apagar_mensagens_excedentes: ${erroApagar.message}`);
    apagadas += typeof n === "number" ? n : 0;
  }
  return { apagadas, lotes, temResto: true, midiasRemovidas, avisos };
}
