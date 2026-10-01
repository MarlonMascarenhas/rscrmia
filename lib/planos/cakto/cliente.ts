/**
 * O CLIENTE DA CAKTO — `fetch` NA API REST, SEM SDK.
 *
 * Documentação oficial: base `https://api.cakto.com.br/public_api`. O token é
 * OAuth client-credentials (`POST /token/`, `application/x-www-form-urlencoded`,
 * corpo `client_id`/`client_secret`) e vale por `expires_in` segundos (a Cakto
 * default para 36000) — por isso é CACHEADO em memória de processo até 60s antes
 * de expirar, e reusado entre chamadas em vez de pedido a cada request.
 *
 * ═══ AS CREDENCIAIS SÃO LIDAS NO INSTANTE DO USO ═══
 *
 * Mesmo contrato do `lib/planos/stripe/cliente.ts`: `valorDaInstalacao` lê o
 * cofre (`platform_config`, cifrado) e cai no `.env` como piso, sem memo — o
 * `worker` é outro processo, e uma chave trocada pela tela tem de valer nos dois
 * sem reiniciar nada.
 *
 * ═══ 401 INVALIDA O CACHE E TENTA UMA VEZ DE NOVO ═══
 *
 * Um token revogado ou expirado fora da nossa conta (rotação manual no painel da
 * Cakto, por exemplo) chega como 401. Nesse caso o cache é jogado fora e a
 * chamada é refeita com um token novo — uma única vez, para não entrar em laço
 * quando o 401 é da credencial em si (client_id/secret errados).
 *
 * ═══ NUNCA LANÇA, NUNCA LOGA SEGREDO NEM TOKEN ═══
 *
 * O resultado carrega o erro do provedor, e quem chama decide o que mostrar. O
 * log leva caminho, status e um recorte do corpo de erro — nunca o `client_secret`
 * nem o `access_token`.
 */
import { createHash } from "node:crypto";

import { valorDaInstalacao } from "@/lib/instalacao/config";
import { logger } from "@/lib/logger";

export const URL_BASE_DA_CAKTO = "https://api.cakto.com.br/public_api";
export const URL_DE_PAGAMENTO_DA_CAKTO = "https://pay.cakto.com.br";

const TIMEOUT_PADRAO_MS = 10_000;
/** Padrão documentado pela Cakto quando o provedor não devolve `expires_in`. */
const EXPIRES_IN_PADRAO_S = 36_000;
/** Margem de segurança: renova antes do provedor considerar o token vencido. */
const MARGEM_DE_EXPIRACAO_S = 60;

export interface CredenciaisDaCakto {
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
}

/** As credenciais em vigor. Nunca lança; ausência é `null`, e é estado normal. */
export async function credenciaisDaCakto(): Promise<CredenciaisDaCakto> {
  const [clientId, clientSecret, webhookSecret] = await Promise.all([
    valorDaInstalacao("CAKTO_CLIENT_ID"),
    valorDaInstalacao("CAKTO_CLIENT_SECRET"),
    valorDaInstalacao("CAKTO_WEBHOOK_SECRET"),
  ]);
  return {
    clientId: clientId.valor?.trim() || null,
    clientSecret: clientSecret.valor?.trim() || null,
    webhookSecret: webhookSecret.valor?.trim() || null,
  };
}

/** Há o mínimo para cobrar? As duas primeiras criam/cancelam; a terceira libera o webhook. */
export function caktoPronto(c: CredenciaisDaCakto): boolean {
  return c.clientId !== null && c.clientSecret !== null && c.webhookSecret !== null;
}

// ── Cache de token em memória de processo ────────────────────────────────────
//
// Em `globalThis`, pelo mesmo motivo medido em `lib/branding/instalacao.ts` e
// `lib/auth/politica-de-cadastro.ts`: um `let`/`Map` de arquivo é por INSTÂNCIA
// DE MÓDULO, e o Next instancia o mesmo módulo mais de uma vez no mesmo
// processo — um `Map` de módulo faria cada runtime pedir o próprio token.

interface TokenEmCache {
  readonly token: string;
  readonly expiraEm: number;
}

declare global {
  var __cacheDeTokenDaCakto: Map<string, TokenEmCache> | undefined;
}

function cacheDeToken(): Map<string, TokenEmCache> {
  if (!globalThis.__cacheDeTokenDaCakto) globalThis.__cacheDeTokenDaCakto = new Map();
  return globalThis.__cacheDeTokenDaCakto;
}

function chaveDoCache(c: CredenciaisDaCakto): string {
  return createHash("sha256").update(`${c.clientId ?? ""}:${c.clientSecret ?? ""}`).digest("hex");
}

/** Só para os testes: devolve o processo ao estado de quem nunca pediu token. */
export function _limparCacheDeToken(): void {
  cacheDeToken().clear();
}

export type ResultadoDoToken = { ok: true; token: string } | { ok: false; mensagem: string };

/**
 * O token vigente — do cache, ou pedido de novo. Nunca lança.
 */
export async function obterToken(c: CredenciaisDaCakto): Promise<ResultadoDoToken> {
  if (!c.clientId || !c.clientSecret) {
    return { ok: false, mensagem: "credenciais da Cakto ausentes (client_id/client_secret)" };
  }

  const chave = chaveDoCache(c);
  const emCache = cacheDeToken().get(chave);
  if (emCache && emCache.expiraEm > Date.now()) return { ok: true, token: emCache.token };

  try {
    const corpo = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret });
    const res = await fetch(`${URL_BASE_DA_CAKTO}/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo.toString(),
      signal: AbortSignal.timeout(TIMEOUT_PADRAO_MS),
    });
    const texto = await res.text();
    const json = parseJsonSeguro(texto);
    const accessToken =
      json && typeof json === "object" && typeof (json as Record<string, unknown>).access_token === "string"
        ? ((json as Record<string, unknown>).access_token as string)
        : null;

    if (!res.ok || !accessToken) {
      logger.warn("cakto: token recusado", { status: res.status });
      return { ok: false, mensagem: `HTTP ${res.status}` };
    }

    const expiresInBruto = (json as Record<string, unknown>).expires_in;
    const expiresIn = typeof expiresInBruto === "number" && expiresInBruto > 0 ? expiresInBruto : EXPIRES_IN_PADRAO_S;
    const validoPorMs = Math.max(expiresIn - MARGEM_DE_EXPIRACAO_S, 0) * 1000;
    cacheDeToken().set(chave, { token: accessToken, expiraEm: Date.now() + validoPorMs });
    return { ok: true, token: accessToken };
  } catch (erro) {
    logger.warn("cakto: obtenção de token falhou", { detalhe: erro instanceof Error ? erro.message : String(erro) });
    return { ok: false, mensagem: erro instanceof Error ? erro.message : "falha de rede" };
  }
}

function parseJsonSeguro(texto: string): unknown {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

function mensagemDeErro(dados: unknown, status: number): string {
  if (dados && typeof dados === "object") {
    const d = dados as Record<string, unknown>;
    for (const campo of ["message", "detail", "error"]) {
      if (typeof d[campo] === "string") return d[campo] as string;
    }
  }
  return `HTTP ${status}`;
}

export type RespostaDaCakto<T> =
  | { ok: true; status: number; dados: T }
  | { ok: false; status: number | null; mensagem: string };

/**
 * Chama a API autenticada da Cakto. Em 401, invalida o token em cache e tenta
 * UMA vez de novo — um client_id/secret errado ainda falha (o token novo também
 * viria recusado), então não há laço.
 */
export async function chamarCakto<T = Record<string, unknown>>(
  c: CredenciaisDaCakto,
  metodo: "GET" | "POST" | "PATCH" | "DELETE",
  caminho: string,
  corpo?: unknown,
  opts: { idempotencia?: string; timeoutMs?: number } = {},
): Promise<RespostaDaCakto<T>> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_PADRAO_MS;

  const tentar = async (token: string): Promise<RespostaDaCakto<T>> => {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.idempotencia ? { "X-Idempotency-Key": opts.idempotencia.slice(0, 255) } : {}),
      };
      const res = await fetch(`${URL_BASE_DA_CAKTO}${caminho}`, {
        method: metodo,
        headers,
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const texto = await res.text();
      const dados = parseJsonSeguro(texto);
      if (!res.ok) {
        logger.warn("cakto: chamada recusada", { caminho, status: res.status, corpo: texto.slice(0, 500) });
        return { ok: false, status: res.status, mensagem: mensagemDeErro(dados, res.status) };
      }
      return { ok: true, status: res.status, dados: (dados ?? {}) as T };
    } catch (erro) {
      logger.warn("cakto: chamada falhou", { caminho, detalhe: erro instanceof Error ? erro.message : String(erro) });
      return { ok: false, status: null, mensagem: erro instanceof Error ? erro.message : "falha de rede" };
    }
  };

  const primeiroToken = await obterToken(c);
  if (!primeiroToken.ok) return { ok: false, status: null, mensagem: primeiroToken.mensagem };

  let resposta = await tentar(primeiroToken.token);
  if (!resposta.ok && resposta.status === 401) {
    cacheDeToken().delete(chaveDoCache(c));
    const novoToken = await obterToken(c);
    if (novoToken.ok) resposta = await tentar(novoToken.token);
  }
  return resposta;
}

/** Só o formato aceito pela Cakto para o `callback` do link de pagamento. */
const TOKEN_DE_CALLBACK_VALIDO = /^[A-Za-z0-9._~-]{1,255}$/;

/**
 * A URL para onde o cliente é mandado pagar. `null` quando a oferta ou o token
 * não têm forma válida — nunca monta um link quebrado.
 */
export function urlDePagamento(ofertaId: string, token: string): string | null {
  if (!ofertaId || !ofertaId.trim()) return null;
  if (!TOKEN_DE_CALLBACK_VALIDO.test(token)) return null;
  return `${URL_DE_PAGAMENTO_DA_CAKTO}/${encodeURIComponent(ofertaId)}?callback=${token}`;
}

/** Cancela a assinatura NA CAKTO. Quem decide o efeito local é quem chama. */
export async function cancelarAssinaturaNaCakto(
  c: CredenciaisDaCakto,
  assinaturaId: string,
  opts: { timeoutMs?: number } = {},
): Promise<RespostaDaCakto<Record<string, unknown>>> {
  return chamarCakto(c, "POST", `/subscriptions/${encodeURIComponent(assinaturaId)}/cancel/`, undefined, opts);
}
