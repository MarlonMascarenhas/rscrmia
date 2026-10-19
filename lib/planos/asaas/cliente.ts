/**
 * O CLIENTE DO ASAAS — `fetch` NA API REST v3, SEM SDK.
 *
 * Documentação oficial (docs.asaas.com): bases `https://api-sandbox.asaas.com/v3` e
 * `https://api.asaas.com/v3`. A autenticação é UM header, `access_token: <chave>`
 * (sem OAuth, sem cache de token), e o header `User-Agent` é obrigatório. A chave
 * de produção começa por `$aact_prod_` e a de sandbox por `$aact_hmlg_`; chave do
 * ambiente errado volta 401 `invalid_environment`.
 *
 * ═══ AS CREDENCIAIS SÃO LIDAS NO INSTANTE DO USO ═══
 *
 * `valorDaInstalacao` lê o cofre (`platform_config`, cifrado) e cai no `.env` como
 * piso, sem memo — o `worker` é outro processo, e uma chave trocada pela tela tem
 * de valer nos dois sem reiniciar nada.
 *
 * ═══ NUNCA LANÇA, NUNCA LOGA A CHAVE NEM O DOCUMENTO DO CLIENTE ═══
 *
 * O resultado carrega o erro do provedor, e quem chama decide o que mostrar. O log
 * leva método, caminho e status — nunca o `access_token`, e NUNCA o corpo da
 * requisição (que, em `POST /customers`, carrega o CPF/CNPJ). O recorte do corpo
 * de ERRO que volta também não é logado: a descrição do erro pode ecoar o campo
 * que o Asaas recusou.
 */
import { DEFAULT_APP_NAME } from "@/lib/branding";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { logger } from "@/lib/logger";

export type AmbienteDoAsaas = "sandbox" | "producao";

export const URL_BASE_DO_ASAAS: Record<AmbienteDoAsaas, string> = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  producao: "https://api.asaas.com/v3",
};

const TIMEOUT_PADRAO_MS = 10_000;

const PREFIXO_DA_CHAVE_DE_PRODUCAO = "$aact_prod_";
const PREFIXO_DA_CHAVE_DE_SANDBOX = "$aact_hmlg_";

export interface CredenciaisDoAsaas {
  apiKey: string | null;
  webhookToken: string | null;
  ambiente: AmbienteDoAsaas;
}

/** `producao` só quando escrito exatamente assim; qualquer outra coisa é o padrão seguro, `sandbox`. */
export function ambienteDeTexto(bruto: string | null | undefined): AmbienteDoAsaas {
  return bruto?.trim().toLowerCase() === "producao" ? "producao" : "sandbox";
}

/** As credenciais em vigor. Nunca lança; ausência é `null`, e é estado normal. */
export async function credenciaisDoAsaas(): Promise<CredenciaisDoAsaas> {
  const [apiKey, webhookToken, ambiente] = await Promise.all([
    valorDaInstalacao("ASAAS_API_KEY"),
    valorDaInstalacao("ASAAS_WEBHOOK_TOKEN"),
    valorDaInstalacao("ASAAS_AMBIENTE"),
  ]);
  return {
    apiKey: apiKey.valor?.trim() || null,
    webhookToken: webhookToken.valor?.trim() || null,
    ambiente: ambienteDeTexto(ambiente.valor),
  };
}

/** Há o mínimo para cobrar? A chave cria/cancela; o token libera o webhook. */
export function asaasPronto(c: CredenciaisDoAsaas): boolean {
  return c.apiKey !== null && c.webhookToken !== null;
}

/** O ambiente que o PREFIXO da chave declara; `null` quando o prefixo não é um dos dois conhecidos. */
export function ambienteDaChave(chave: string | null): AmbienteDoAsaas | null {
  if (!chave) return null;
  if (chave.startsWith(PREFIXO_DA_CHAVE_DE_PRODUCAO)) return "producao";
  if (chave.startsWith(PREFIXO_DA_CHAVE_DE_SANDBOX)) return "sandbox";
  return null;
}

export type AvisoDeConfiguracaoDoAsaas = "chave_de_outro_ambiente" | "token_fora_do_tamanho";

/**
 * O que está torto na configuração e a tela precisa dizer. Não impede nada: é
 * diagnóstico (a chave de outro ambiente falharia de qualquer jeito, com 401, só
 * que sem explicar por quê).
 */
export function avisosDeConfiguracao(c: CredenciaisDoAsaas): AvisoDeConfiguracaoDoAsaas[] {
  const avisos: AvisoDeConfiguracaoDoAsaas[] = [];
  const doPrefixo = ambienteDaChave(c.apiKey);
  if (doPrefixo !== null && doPrefixo !== c.ambiente) avisos.push("chave_de_outro_ambiente");
  // 32 a 255 caracteres é o que o Asaas aceita como token do webhook.
  if (c.webhookToken !== null && (c.webhookToken.length < 32 || c.webhookToken.length > 255)) {
    avisos.push("token_fora_do_tamanho");
  }
  return avisos;
}

function parseJsonSeguro(texto: string): unknown {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/** `{ errors: [{ code, description }] }` — o formato de erro documentado. */
function erroDoCorpo(dados: unknown, status: number): { mensagem: string; codigo: string | null } {
  if (dados && typeof dados === "object") {
    const lista = (dados as Record<string, unknown>).errors;
    if (Array.isArray(lista) && lista.length > 0 && lista[0] && typeof lista[0] === "object") {
      const primeiro = lista[0] as Record<string, unknown>;
      const codigo = typeof primeiro.code === "string" ? primeiro.code : null;
      const descricao = typeof primeiro.description === "string" ? primeiro.description : null;
      return { mensagem: descricao ?? codigo ?? `HTTP ${status}`, codigo };
    }
  }
  return { mensagem: `HTTP ${status}`, codigo: null };
}

export type RespostaDoAsaas<T> =
  | { ok: true; status: number; dados: T }
  | { ok: false; status: number | null; mensagem: string; codigo: string | null };

/**
 * Chama a API autenticada do Asaas. Nunca lança.
 *
 * `corpo` é serializado como JSON e NUNCA entra em log (pode levar CPF/CNPJ).
 */
export async function chamarAsaas<T = Record<string, unknown>>(
  c: CredenciaisDoAsaas,
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<RespostaDoAsaas<T>> {
  if (!c.apiKey) return { ok: false, status: null, mensagem: "chave do Asaas ausente", codigo: null };

  try {
    const res = await fetch(`${URL_BASE_DO_ASAAS[c.ambiente]}${caminho}`, {
      method: metodo,
      headers: {
        access_token: c.apiKey,
        "User-Agent": DEFAULT_APP_NAME,
        ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_PADRAO_MS),
    });
    const dados = parseJsonSeguro(await res.text());
    if (!res.ok) {
      const erro = erroDoCorpo(dados, res.status);
      logger.warn("asaas: chamada recusada", { metodo, caminho, status: res.status, codigo: erro.codigo });
      return { ok: false, status: res.status, mensagem: erro.mensagem, codigo: erro.codigo };
    }
    return { ok: true, status: res.status, dados: (dados ?? {}) as T };
  } catch (erro) {
    logger.warn("asaas: chamada falhou", { metodo, caminho, detalhe: erro instanceof Error ? erro.message : String(erro) });
    return { ok: false, status: null, mensagem: erro instanceof Error ? erro.message : "falha de rede", codigo: null };
  }
}

/** Uma chamada GET barata e autenticada: prova que a chave vale para o ambiente escolhido. */
export async function testarCredenciaisDoAsaas(c: CredenciaisDoAsaas): Promise<RespostaDoAsaas<Record<string, unknown>>> {
  return chamarAsaas(c, "GET", "/customers?limit=1");
}

/** Remove a assinatura NO ASAAS (apaga as cobranças pendentes). Quem decide o efeito local é quem chama. */
export async function removerAssinaturaNoAsaas(
  c: CredenciaisDoAsaas,
  assinaturaId: string,
  opts: { timeoutMs?: number } = {},
): Promise<RespostaDoAsaas<Record<string, unknown>>> {
  return chamarAsaas(c, "DELETE", `/subscriptions/${encodeURIComponent(assinaturaId)}`, undefined, opts);
}
