/**
 * O CLIENTE DO ASAAS — HEADERS, AMBIENTE, ERROS E O QUE NUNCA VAI PARA O LOG,
 * TUDO COM `fetch` DUBLADO.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. A chave e o CPF/CNPJ (corpo de `POST /customers`) NUNCA aparecem em log.
 *   2. O ambiente escolhido decide a base: sandbox NUNCA fala com a produção.
 *   3. Falha de rede/timeout nunca lança — vira `{ ok: false }`.
 *   4. Chave do ambiente errado é reconhecida (`invalid_environment`) e avisada
 *      pela tela antes de o Asaas recusar.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ambienteDaChave,
  ambienteDeTexto,
  asaasPronto,
  avisosDeConfiguracao,
  chamarAsaas,
  removerAssinaturaNoAsaas,
  testarCredenciaisDoAsaas,
  URL_BASE_DO_ASAAS,
  type CredenciaisDoAsaas,
} from "@/lib/planos/asaas/cliente";
import { logger } from "@/lib/logger";

const CHAVE = "$aact_hmlg_chave_de_teste_secreta";
const SANDBOX: CredenciaisDoAsaas = { apiKey: CHAVE, webhookToken: "t".repeat(40), ambiente: "sandbox" };
const PRODUCAO: CredenciaisDoAsaas = { apiKey: "$aact_prod_x", webhookToken: "t".repeat(40), ambiente: "producao" };

interface Chamada {
  url: string;
  init: RequestInit;
}

function asaasFalso(status: number, corpo: unknown): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    chamadas.push({ url: String(url), init });
    return new Response(JSON.stringify(corpo), { status });
  });
  return chamadas;
}

describe("cliente do Asaas (rede dublada)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("autentica pelo header access_token, com User-Agent, e fala com a base do sandbox", async () => {
    const chamadas = asaasFalso(200, { data: [] });
    const r = await chamarAsaas(SANDBOX, "GET", "/customers?limit=1");
    expect(r).toEqual({ ok: true, status: 200, dados: { data: [] } });
    expect(chamadas[0]!.url).toBe("https://api-sandbox.asaas.com/v3/customers?limit=1");
    const headers = chamadas[0]!.init.headers as Record<string, string>;
    expect(headers.access_token).toBe(CHAVE);
    expect(headers["User-Agent"]).toBeTruthy();
    expect(headers.Authorization).toBeUndefined();
  });

  it("o ambiente producao usa a base de produção", async () => {
    const chamadas = asaasFalso(200, {});
    await chamarAsaas(PRODUCAO, "GET", "/customers?limit=1");
    expect(chamadas[0]!.url).toBe("https://api.asaas.com/v3/customers?limit=1");
    expect(URL_BASE_DO_ASAAS.sandbox).toBe("https://api-sandbox.asaas.com/v3");
  });

  it("POST leva JSON e Content-Type; GET não leva corpo", async () => {
    const chamadas = asaasFalso(200, { id: "cus_1" });
    await chamarAsaas(SANDBOX, "POST", "/customers", { name: "Ana" });
    expect((chamadas[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(chamadas[0]!.init.body).toBe(JSON.stringify({ name: "Ana" }));
    await chamarAsaas(SANDBOX, "GET", "/customers");
    expect(chamadas[1]!.init.body).toBeUndefined();
  });

  it("sem chave não chama a rede", async () => {
    const chamadas = asaasFalso(200, {});
    const r = await chamarAsaas({ ...SANDBOX, apiKey: null }, "GET", "/customers");
    expect(r).toMatchObject({ ok: false, status: null });
    expect(chamadas).toEqual([]);
  });

  it("erro do Asaas: lê { errors: [{ code, description }] } e devolve o código", async () => {
    asaasFalso(401, { errors: [{ code: "invalid_environment", description: "A chave de API informada não pertence a este ambiente" }] });
    const r = await chamarAsaas(SANDBOX, "GET", "/customers");
    expect(r).toEqual({
      ok: false,
      status: 401,
      mensagem: "A chave de API informada não pertence a este ambiente",
      codigo: "invalid_environment",
    });
  });

  it("corpo de erro ilegível degrada para HTTP <status>", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 502 }));
    const r = await chamarAsaas(SANDBOX, "GET", "/customers");
    expect(r).toEqual({ ok: false, status: 502, mensagem: "HTTP 502", codigo: null });
  });

  it("falha de rede NUNCA lança", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const r = await chamarAsaas(SANDBOX, "GET", "/customers");
    expect(r).toEqual({ ok: false, status: null, mensagem: "ECONNRESET", codigo: null });
  });

  it("a chave e o CPF/CNPJ do corpo NUNCA aparecem em log, nem na recusa nem na falha", async () => {
    const avisos = vi.spyOn(logger, "warn");
    asaasFalso(400, { errors: [{ code: "invalid_cpfCnpj", description: "CPF/CNPJ inválido" }] });
    await chamarAsaas(SANDBOX, "POST", "/customers", { name: "Ana", cpfCnpj: "52998224725" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });
    await chamarAsaas(SANDBOX, "POST", "/customers", { name: "Ana", cpfCnpj: "52998224725" });

    const texto = JSON.stringify(avisos.mock.calls);
    expect(texto).not.toContain("52998224725");
    expect(texto).not.toContain(CHAVE);
    expect(avisos).toHaveBeenCalledTimes(2);
  });

  it("testarCredenciaisDoAsaas faz um GET barato e autenticado", async () => {
    const chamadas = asaasFalso(200, { data: [] });
    const r = await testarCredenciaisDoAsaas(SANDBOX);
    expect(r.ok).toBe(true);
    expect(chamadas[0]!.init.method).toBe("GET");
    expect(chamadas[0]!.url).toContain("/customers?limit=1");
  });

  it("removerAssinaturaNoAsaas faz DELETE /subscriptions/{id} com o id escapado", async () => {
    const chamadas = asaasFalso(200, { deleted: true, id: "sub_1" });
    const r = await removerAssinaturaNoAsaas(SANDBOX, "sub_1/../x");
    expect(r.ok).toBe(true);
    expect(chamadas[0]!.init.method).toBe("DELETE");
    expect(chamadas[0]!.url).toBe("https://api-sandbox.asaas.com/v3/subscriptions/sub_1%2F..%2Fx");
  });
});

describe("ambiente e diagnóstico de configuração", () => {
  it("só 'producao' escrito exatamente assim liga a produção; o resto é sandbox", () => {
    expect(ambienteDeTexto("producao")).toBe("producao");
    expect(ambienteDeTexto(" Producao ")).toBe("producao");
    expect(ambienteDeTexto("sandbox")).toBe("sandbox");
    expect(ambienteDeTexto("prod")).toBe("sandbox");
    expect(ambienteDeTexto("")).toBe("sandbox");
    expect(ambienteDeTexto(null)).toBe("sandbox");
  });

  it("o prefixo da chave declara o ambiente", () => {
    expect(ambienteDaChave("$aact_prod_abc")).toBe("producao");
    expect(ambienteDaChave("$aact_hmlg_abc")).toBe("sandbox");
    expect(ambienteDaChave("qualquer")).toBeNull();
    expect(ambienteDaChave(null)).toBeNull();
  });

  it("chave de produção com ambiente sandbox (e o inverso) avisa; prefixo desconhecido não", () => {
    expect(avisosDeConfiguracao({ ...PRODUCAO, ambiente: "sandbox" })).toContain("chave_de_outro_ambiente");
    expect(avisosDeConfiguracao({ ...SANDBOX, ambiente: "producao" })).toContain("chave_de_outro_ambiente");
    expect(avisosDeConfiguracao(SANDBOX)).toEqual([]);
    expect(avisosDeConfiguracao({ ...SANDBOX, apiKey: "sem-prefixo" })).toEqual([]);
  });

  it("token do webhook fora de 32–255 caracteres avisa", () => {
    expect(avisosDeConfiguracao({ ...SANDBOX, webhookToken: "curto" })).toContain("token_fora_do_tamanho");
    expect(avisosDeConfiguracao({ ...SANDBOX, webhookToken: "x".repeat(256) })).toContain("token_fora_do_tamanho");
    expect(avisosDeConfiguracao({ ...SANDBOX, webhookToken: "x".repeat(32) })).toEqual([]);
  });

  it("asaasPronto exige a chave E o token do webhook", () => {
    expect(asaasPronto(SANDBOX)).toBe(true);
    expect(asaasPronto({ ...SANDBOX, apiKey: null })).toBe(false);
    expect(asaasPronto({ ...SANDBOX, webhookToken: null })).toBe(false);
  });
});
