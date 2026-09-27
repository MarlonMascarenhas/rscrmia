/**
 * O CLIENTE DO STRIPE — `fetch` NA API REST, SEM SDK.
 *
 * ═══ AS CHAVES SÃO LIDAS NO INSTANTE DO USO ═══
 *
 * `valorDaInstalacao` lê o cofre (`platform_config`, cifrado) e cai no `.env` como
 * piso. Sem memo, de propósito — o cabeçalho de `lib/instalacao/config.ts` explica:
 * o `worker` é outro processo, e uma chave trocada pela tela tem de valer nos dois
 * sem reiniciar nada, com a tela dizendo "salvo" e o valor antigo em uso sendo o
 * defeito que se paga caro.
 *
 * ═══ MODO DE TESTE × PRODUÇÃO ═══
 *
 * A chave diz o modo (`sk_test_` / `sk_live_`) e o evento também (`livemode`). Um
 * evento de um modo chegando numa instalação configurada com o outro é ignorado —
 * senão o webhook de teste de uma conta liberaria acesso de verdade, ou o contrário.
 * NÃO se recusa chave de teste em produção: quem valida a integração antes de
 * vender usa chave de teste no domínio real, e proibir isso o obrigaria a vender
 * sem ter testado. O modo aparece na tela do dono.
 *
 * Nunca lança: o resultado carrega o erro do provedor, e quem chama decide o que
 * mostrar. A mensagem do Stripe é escrita para desenvolvedor e pode citar objetos
 * internos — ela vai para o LOG, e a tela mostra uma frase nossa.
 */
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { logger } from "@/lib/logger";

export const URL_BASE_DO_STRIPE = "https://api.stripe.com";

export type ModoDoStripe = "teste" | "producao";

export function modoDaChave(chave: string | null | undefined): ModoDoStripe | "invalida" {
  if (!chave) return "invalida";
  if (/^(sk|rk)_test_/.test(chave)) return "teste";
  if (/^(sk|rk)_live_/.test(chave)) return "producao";
  return "invalida";
}

export interface CredenciaisDoStripe {
  chave: string | null;
  segredoDoWebhook: string | null;
  modo: ModoDoStripe | "invalida";
}

/** As credenciais em vigor. Nunca lança; ausência é `null`, e é estado normal. */
export async function credenciaisDoStripe(): Promise<CredenciaisDoStripe> {
  const [chave, webhook] = await Promise.all([
    valorDaInstalacao("STRIPE_SECRET_KEY"),
    valorDaInstalacao("STRIPE_WEBHOOK_SECRET"),
  ]);
  const k = chave.valor?.trim() || null;
  return { chave: k, segredoDoWebhook: webhook.valor?.trim() || null, modo: modoDaChave(k) };
}

/** Há o mínimo para cobrar? A chave é o que cria sessões; o webhook é o que libera. */
export function stripePronto(c: CredenciaisDoStripe): boolean {
  return c.chave !== null && c.modo !== "invalida" && c.segredoDoWebhook !== null;
}

type Escalar = string | number | boolean | null | undefined;
type Formulario = { [k: string]: Escalar | Formulario | Array<Escalar | Formulario> };

/**
 * O corpo do Stripe é `application/x-www-form-urlencoded` com notação de colchetes:
 * `line_items[0][price]=price_1`. Objetos aninham, arrays indexam, `null` e
 * `undefined` somem — enviar chave vazia faria o Stripe LIMPAR o campo.
 */
export function codificarFormulario(obj: Formulario, prefixo = ""): URLSearchParams {
  const p = new URLSearchParams();
  const anda = (valor: unknown, caminho: string) => {
    if (valor === null || valor === undefined) return;
    if (Array.isArray(valor)) valor.forEach((v, i) => anda(v, `${caminho}[${i}]`));
    else if (typeof valor === "object") {
      for (const [k, v] of Object.entries(valor as Formulario)) anda(v, caminho ? `${caminho}[${k}]` : k);
    } else p.append(caminho, String(valor));
  };
  anda(obj, prefixo);
  return p;
}

export type RespostaDoStripe<T> =
  | { ok: true; dados: T }
  | { ok: false; status: number; codigo: string | null; mensagem: string };

export async function chamarStripe<T = Record<string, unknown>>(
  chave: string,
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: Formulario,
  opcoes: { idempotencia?: string } = {},
): Promise<RespostaDoStripe<T>> {
  try {
    const r = await fetch(`${URL_BASE_DO_STRIPE}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${chave}`,
        ...(corpo ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(opcoes.idempotencia ? { "Idempotency-Key": opcoes.idempotencia } : {}),
      },
      body: corpo ? codificarFormulario(corpo).toString() : undefined,
      // Timeout: um Stripe lento não pode segurar a requisição do cliente para sempre.
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await r.json().catch(() => null)) as
      | (T & { error?: { code?: string; message?: string } })
      | null;
    if (!r.ok) {
      const erro = (json as { error?: { code?: string; message?: string } } | null)?.error;
      logger.warn("stripe: chamada recusada", {
        caminho,
        status: r.status,
        codigo: erro?.code,
        detalhe: erro?.message,
      });
      return { ok: false, status: r.status, codigo: erro?.code ?? null, mensagem: erro?.message ?? `HTTP ${r.status}` };
    }
    return { ok: true, dados: json as T };
  } catch (erro) {
    logger.warn("stripe: chamada falhou", { caminho, detalhe: erro instanceof Error ? erro.message : String(erro) });
    return { ok: false, status: 0, codigo: "rede", mensagem: erro instanceof Error ? erro.message : "falha de rede" };
  }
}
