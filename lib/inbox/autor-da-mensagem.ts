/**
 * QUEM FALOU, dentro de um grupo do WhatsApp.
 *
 * A ingestão de mensagem de grupo grava `messages.metadata.autor = { chat_id,
 * telefone, nome }` (`autorDaMensagemDeGrupo`, `lib/waha/grupo.ts`) — numa
 * conversa 1:1 esse campo não existe, e não precisa existir: lá quem fala é
 * sempre o mesmo contato da conversa, e o balão já não pergunta.
 *
 * Prioridade: o NOME que o WhatsApp informou (o `pushName`/`notifyName` de
 * quem mandou); sem nome, o telefone formatado pela MESMA regra que o resto
 * do inbox usa (`phoneForDisplay` — nono dígito brasileiro); sem os dois,
 * `null` — a bolha não inventa rótulo para um autor que o metadata não
 * descreve.
 */
import { phoneForDisplay } from "@/lib/channels/phone-variants";

export function autorDaMensagem(metadata: unknown): string | null {
  if (metadata == null || typeof metadata !== "object") return null;
  const autor = (metadata as Record<string, unknown>).autor;
  if (autor == null || typeof autor !== "object") return null;
  const a = autor as Record<string, unknown>;

  const nome = typeof a.nome === "string" ? a.nome.trim() : "";
  if (nome !== "") return nome;

  const telefone = typeof a.telefone === "string" ? a.telefone.trim() : "";
  if (telefone !== "") return phoneForDisplay(telefone);

  return null;
}
