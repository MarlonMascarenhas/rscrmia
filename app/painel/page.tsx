import { redirect } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";

/**
 * A PORTA DE ENTRADA DO PAINEL.
 *
 * `/painel` é o endereço que a LP aponta em "Entrar" e que se pode dar a um cliente:
 * quem já tem sessão vai direto para o produto (`/app`), quem não tem cai no login
 * com o destino guardado. O produto em si NÃO se mudou de endereço — `/app` segue
 * sendo onde ele vive, com os seus 244 links fixos, o menu e os e-mails intactos.
 *
 * Fica pública no proxy (`lib/auth/public-paths.ts`) para ser ELA a decidir: se o
 * proxy barrasse antes, mandaria o visitante para `/login?next=/painel` e ainda
 * faria uma volta a mais depois do login.
 *
 * ═══ FALHA DE SESSÃO NÃO É 500 ═══
 *
 * `loadAuthUser` levanta de propósito quando não consegue resolver as permissões
 * (`lib/auth/server.ts`: "falha alto"), porque degradar permissão em silêncio é pior.
 * Aqui, porém, a pergunta é só "tem sessão?", e a resposta segura para "não sei" é
 * o login — que vai revalidar de qualquer forma. Uma porta de entrada que dá 500 é
 * um cliente que acha que o sistema caiu.
 */
export const dynamic = "force-dynamic";

export default async function PainelPage() {
  let logado = false;
  try {
    logado = (await loadAuthUser()) !== null;
  } catch {
    logado = false;
  }
  redirect(logado ? "/app" : "/login?next=/app");
}
