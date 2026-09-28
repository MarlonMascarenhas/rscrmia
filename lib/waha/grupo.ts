/**
 * lib/waha/grupo.ts — leitura pura do payload WAHA quando o chat é um GRUPO
 * (`@g.us`). Sem efeito colateral, sem I/O; só extrai o que `lib/waha/ingest.ts`
 * precisa para gravar a mensagem de grupo (quando `channel_sessions.mostrar_grupos`
 * estiver ligado — ver `lib/channels/grupos.ts`).
 *
 * ⚠️ SEM regex sobre entrada externa. Mesmo motivo do comentário em
 * `lib/waha/ingest.ts` (`telefoneAlternativoDe`, `semSufixoDeChat`): estes campos
 * vêm de um webhook sem assinatura obrigatória por padrão
 * (`WAHA_WEBHOOK_REQUIRE_SIGNATURE=false`), e uma regex que reinicia a tentativa a
 * cada `@`/`_` é O(n²) sobre string que o remetente controla.
 */
import type { WahaPayload } from "@/lib/waha/envelope";

/**
 * O chatId do GRUPO, a partir do que o WAHA manda — nunca do `chatId` já
 * resolvido pelo 1:1 (que prioriza `to`/id/`from` para achar o DESTINATÁRIO
 * de uma conversa individual; aqui a pergunta é outra: "este payload é de um
 * grupo, e qual?").
 *
 * Ordem: `to`, depois `from` — o primeiro que for string, `length <= 128` e
 * terminar em `@g.us`. Faltando os dois, tenta o `id` composto
 * (`{fromMe}_{chatId}_{msgId}[_{participant}]`): o segundo segmento é o chat
 * em qualquer engine (ver `chatIdFromWaMessageId`, mesma doutrina). `null`
 * quando nada bate — payload não é de grupo, ou é grupo mal-formado demais
 * para confiar.
 */
export function chatDeGrupoDoPayload(p: WahaPayload): string | null {
  for (const candidato of [p.to, p.from]) {
    if (typeof candidato === "string" && candidato.length <= 128 && candidato.endsWith("@g.us")) {
      return candidato;
    }
  }
  const id = p.id;
  if (typeof id === "string" && id.length <= 512) {
    for (const parte of id.split("_")) {
      if (parte.endsWith("@g.us")) return parte;
    }
  }
  return null;
}

/**
 * O id CRU da mensagem, de dentro do id composto de GRUPO
 * (`{fromMe}_{chatId}_{msgId}_{participant}` — 4 segmentos, o `_{participant}`
 * é exclusivo de grupo; no 1:1 são 3). Usado para casar ack e dedup: o envio
 * (quando formos nós a mandar) grava o id cru; o webhook de grupo devolve o
 * composto de 4 partes.
 *
 * `null` quando o id não tem a forma esperada — não inventa um id a partir de
 * uma string que não é isto.
 */
export function idCruDeMensagemDeGrupo(id: string): string | null {
  if (id.length > 512) return null;
  const partes = id.split("_");
  if (partes.length >= 4 && (partes[1] ?? "").endsWith("@g.us")) {
    return partes[2] || null;
  }
  return null;
}

export interface AutorDeGrupo {
  chat_id: string | null;
  telefone: string | null;
  nome: string | null;
}

/**
 * O TELEFONE real por trás de um JID de grupo (`participantAlt`) ou de um
 * chatId qualquer — mesmo laço de `telefoneAlternativoDe` em
 * `lib/waha/ingest.ts` (replicado, não importado: lá a entrada é sempre
 * `_data.key`; aqui também tentamos o próprio `chat_id` do autor, uma fonte
 * que aquela função não aceita). Só aceita sufixo de NÚMERO
 * (`@s.whatsapp.net`/`@c.us`) com 8 a 15 dígitos — na dúvida, `null`: contato
 * sem telefone é incômodo, contato com telefone ERRADO manda mensagem para
 * estranho.
 */
function telefoneDeJid(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  if (bruto.length > 128) return null;
  if (!bruto.endsWith("@s.whatsapp.net") && !bruto.endsWith("@c.us")) return null;
  const semSufixo = bruto.slice(0, bruto.indexOf("@"));
  let digitos = "";
  for (const ch of semSufixo) {
    if (ch >= "0" && ch <= "9") digitos += ch;
  }
  if (digitos.length < 8 || digitos.length > 15) return null;
  return `+${digitos}`;
}

function nomeDaMensagemDeGrupo(p: WahaPayload): string | null {
  const bruto = p._data?.notifyName ?? p._data?.pushName ?? null;
  if (!bruto) return null;
  const cortado = bruto.trim().slice(0, 120);
  return cortado.length > 0 ? cortado : null;
}

/**
 * Quem FALOU dentro do grupo — não confundir com o grupo em si.
 *
 * `chat_id`: o primeiro entre `p.participant`, `p.author`,
 * `p._data?.key?.participant` que for string não vazia (`length <= 128`).
 * Nenhum dos três tem tipo no contrato Zod (`lib/waha/envelope.ts` é
 * `looseObject` — só ganham tipo os campos que o código já lê sem guarda
 * própria) — por isso a leitura é via `Record<string, unknown>` com
 * `typeof === "string"` explícito.
 *
 * `telefone`: de `_data.key.participantAlt`, com o `chat_id` como reserva.
 * `nome`: `notifyName` ou `pushName`, cortado em 120.
 *
 * Os três nulos → `null` (não há autor identificável neste payload).
 */
export function autorDaMensagemDeGrupo(p: WahaPayload): AutorDeGrupo | null {
  const bruto = p as Record<string, unknown>;
  const key = p._data?.key as Record<string, unknown> | null | undefined;
  let chatId: string | null = null;
  for (const candidato of [bruto.participant, bruto.author, key?.participant]) {
    if (typeof candidato === "string" && candidato.length > 0 && candidato.length <= 128) {
      chatId = candidato;
      break;
    }
  }
  const telefone = telefoneDeJid(p._data?.key?.participantAlt) ?? telefoneDeJid(chatId);
  const nome = nomeDaMensagemDeGrupo(p);
  if (chatId === null && telefone === null && nome === null) return null;
  return { chat_id: chatId, telefone, nome };
}
