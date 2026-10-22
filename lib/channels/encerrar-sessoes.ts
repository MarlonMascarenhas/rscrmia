/**
 * Encerra, NO PROVEDOR, as conexões de canal de uma empresa que acabou de ser excluída.
 *
 * Vive aqui porque a catraca (`scripts/lint-channels.ts`) proíbe nomear provider fora de
 * `lib/channels/`: a rota de exclusão de empresa pede "encerre estas conexões" e não sabe quem é
 * quem. Quem sabe é este módulo.
 *
 * ─── Ordem e honestidade ────────────────────────────────────────────────────
 * A exclusão no banco já foi confirmada quando isto roda (as linhas de `channel_sessions` não
 * existem mais), então NADA aqui desfaz a exclusão. Cada falha vira uma frase em `falhas` e segue
 * para a próxima conexão — o chamador a devolve ao operador e a grava na auditoria. Calar a falha
 * deixaria uma sessão órfã recebendo webhook de uma empresa que não existe, sem ninguém saber.
 *
 * ─── Por tipo de conexão ────────────────────────────────────────────────────
 * - pareada por QR: logout + delete da sessão no transporte (as mesmas duas chamadas da rota
 *   DELETE de `channel-sessions`). Sem transporte configurado, é falha dita, não silêncio.
 * - oficial: a credencial é lida da cópia cifrada coletada ANTES do delete e o override do
 *   webhook DO NÚMERO é desfeito (`desfazerWebhookDoNumero`); a inscrição na WABA não é tocada
 *   porque é compartilhada com os outros números da instalação.
 * - conexão já arquivada: o transporte já foi encerrado no arquivamento; é contada em `ignoradas`.
 * - qualquer outro tipo: não há o que encerrar do nosso lado; contada em `ignoradas`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { desfazerWebhookDoNumero } from "@/lib/channels/meta/webhook-override";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

const sessaoColetadaSchema = z.object({
  id: z.string(),
  provider: z.string(),
  waha_session_name: z.string().nullable().optional(),
  meta_phone_number_id: z.string().nullable().optional(),
  meta_token_encrypted: z.string().nullable().optional(),
  arquivada: z.boolean().optional(),
});

export interface ResultadoDoEncerramento {
  /** Conexões efetivamente encerradas no provedor. */
  encerradas: number;
  /** Conexões em que não havia nada a encerrar (arquivadas, ou tipo sem sessão remota). */
  ignoradas: number;
  /** Uma frase por falha, sem credencial nem nome de sessão. */
  falhas: string[];
}

export function contarSessoesColetadas(brutas: unknown): number {
  return Array.isArray(brutas) ? brutas.length : 0;
}

export async function encerrarSessoesDaEmpresaExcluida(
  db: SupabaseClient,
  brutas: unknown,
): Promise<ResultadoDoEncerramento> {
  const resultado: ResultadoDoEncerramento = { encerradas: 0, ignoradas: 0, falhas: [] };
  const lista = Array.isArray(brutas) ? brutas : [];

  for (const bruta of lista) {
    const lida = sessaoColetadaSchema.safeParse(bruta);
    if (!lida.success) {
      resultado.falhas.push("Uma conexão de canal veio num formato que não foi reconhecido.");
      continue;
    }
    const sessao = lida.data;
    if (sessao.arquivada) {
      resultado.ignoradas += 1;
      continue;
    }

    if (sessao.provider === CHANNEL_PROVIDER_WAHA) {
      const nome = sessao.waha_session_name;
      if (!nome) {
        resultado.falhas.push("Uma conexão pareada por QR não tinha nome de sessão para encerrar.");
        continue;
      }
      const cliente = getWahaClient();
      if (!cliente) {
        resultado.falhas.push(
          "O transporte do WhatsApp não está configurado neste ambiente; a sessão de uma conexão pareada por QR não foi encerrada.",
        );
        continue;
      }
      try {
        await cliente.logoutSession(nome);
        await cliente.deleteSession(nome);
        resultado.encerradas += 1;
      } catch (erro) {
        resultado.falhas.push(`Não foi possível encerrar uma sessão pareada por QR: ${wahaFriendlyError(erro)}`);
      }
      continue;
    }

    if (sessao.provider === "meta_cloud") {
      if (!sessao.meta_phone_number_id || !sessao.meta_token_encrypted) {
        resultado.ignoradas += 1;
        continue;
      }
      try {
        const token = await decryptWebhookSecret(db, sessao.meta_token_encrypted);
        if (!token) {
          resultado.falhas.push(
            "A credencial de uma conexão oficial não pôde ser lida; o webhook do número continua apontando para esta instalação.",
          );
          continue;
        }
        const desfecho = await desfazerWebhookDoNumero({ phoneNumberId: sessao.meta_phone_number_id, token });
        if (desfecho.ok) {
          resultado.encerradas += 1;
        } else {
          resultado.falhas.push(
            `A plataforma recusou devolver o webhook de um número oficial (${desfecho.etapa}: ${desfecho.motivo}).`,
          );
        }
      } catch (erro) {
        resultado.falhas.push(
          `Falha ao devolver o webhook de um número oficial: ${erro instanceof Error ? erro.message : String(erro)}`,
        );
      }
      continue;
    }

    resultado.ignoradas += 1;
  }

  return resultado;
}
