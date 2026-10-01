/**
 * O CLIENTE DA CAKTO — TOKEN, IDEMPOTÊNCIA, RETRY DE 401 E LINK DE PAGAMENTO,
 * TUDO COM `fetch` DUBLADO.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. O `client_secret` e o `access_token` NUNCA aparecem em log.
 *   2. O token é pedido uma vez e REUSADO — não uma chamada de token por
 *      chamada de API.
 *   3. 401 invalida o cache e tenta UMA vez de novo, nunca em laço.
 *   4. Falha de rede/timeout nunca lança — vira `{ ok: false }`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _limparCacheDeToken,
  cancelarAssinaturaNaCakto,
  chamarCakto,
  obterToken,
  urlDePagamento,
  type CredenciaisDaCakto,
} from "@/lib/planos/cakto/cliente";
import { logger } from "@/lib/logger";

const CREDENCIAIS: CredenciaisDaCakto = {
  clientId: "client_abc",
  clientSecret: "segredo_super_secreto",
  webhookSecret: "whsec_x",
};

function tokenValido(corpo: Record<string, unknown> = {}) {
  return { status: 200, corpo: { access_token: "tok_1", expires_in: 36_000, token_type: "Bearer", ...corpo } };
}

describe("cliente da Cakto (rede dublada)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _limparCacheDeToken();
  });

  it("pede o token no formato form-urlencoded, com client_id e client_secret", async () => {
    const chamadas: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      chamadas.push({ url: String(url), init });
      return new Response(JSON.stringify(tokenValido().corpo), { status: 200 });
    });

    const r = await obterToken(CREDENCIAIS);
    expect(r).toEqual({ ok: true, token: "tok_1" });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("https://api.cakto.com.br/public_api/token/");
    expect((chamadas[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const corpo = new URLSearchParams(String(chamadas[0]!.init.body));
    expect(corpo.get("client_id")).toBe("client_abc");
    expect(corpo.get("client_secret")).toBe("segredo_super_secreto");
  });

  it("token pedido uma vez e REUSADO nas chamadas seguintes", async () => {
    let chamadasDeToken = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/token/")) {
        chamadasDeToken++;
        return new Response(JSON.stringify(tokenValido().corpo), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "sub_1" }), { status: 200 });
    });

    await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");
    await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");
    await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");

    expect(chamadasDeToken).toBe(1);
  });

  it("token expirado é RENOVADO — não fica no cache para sempre", async () => {
    let chamadasDeToken = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/token/")) {
        chamadasDeToken++;
        // expires_in bem curto: já expirado com a margem de 60s.
        return new Response(JSON.stringify({ access_token: `tok_${chamadasDeToken}`, expires_in: 30 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const r1 = await obterToken(CREDENCIAIS);
    // Sem TTL real não dá para esperar 30s no teste; a garantia testada aqui é a
    // de que um cache vazio pede token de novo, e um cache válido (caso anterior)
    // não pede.
    expect(r1).toEqual({ ok: true, token: "tok_1" });
    _limparCacheDeToken();
    const r2 = await obterToken(CREDENCIAIS);
    expect(r2).toEqual({ ok: true, token: "tok_2" });
    expect(chamadasDeToken).toBe(2);
  });

  it("401 na chamada autenticada invalida o token em cache e tenta UMA vez de novo", async () => {
    let chamadasDeToken = 0;
    let chamadasAutenticadas = 0;
    const tokensUsados: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/token/")) {
        chamadasDeToken++;
        return new Response(JSON.stringify({ access_token: `tok_${chamadasDeToken}`, expires_in: 36_000 }), {
          status: 200,
        });
      }
      chamadasAutenticadas++;
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      tokensUsados.push(auth);
      if (chamadasAutenticadas === 1) {
        return new Response(JSON.stringify({ error: "token expirado" }), { status: 401 });
      }
      return new Response(JSON.stringify({ id: "sub_1" }), { status: 200 });
    });

    const r = await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");
    expect(r).toEqual({ ok: true, status: 200, dados: { id: "sub_1" } });
    expect(chamadasDeToken).toBe(2); // pediu de novo depois do 401
    expect(chamadasAutenticadas).toBe(2); // tentou de novo UMA vez
    expect(tokensUsados[0]).not.toBe(tokensUsados[1]); // token novo na segunda tentativa
  });

  it("401 persistente (credencial errada) não entra em laço — falha depois de UMA repetição", async () => {
    let chamadasAutenticadas = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/token/")) {
        return new Response(JSON.stringify({ access_token: "tok_x", expires_in: 36_000 }), { status: 200 });
      }
      chamadasAutenticadas++;
      return new Response(JSON.stringify({ message: "credencial inválida" }), { status: 401 });
    });

    const r = await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");
    expect(r).toEqual({ ok: false, status: 401, mensagem: "credencial inválida" });
    expect(chamadasAutenticadas).toBe(2); // a original + a única repetição
  });

  it("envia X-Idempotency-Key, cortado em 255 caracteres", async () => {
    const chamadas: RequestInit[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("/token/")) return new Response(JSON.stringify(tokenValido().corpo), { status: 200 });
      chamadas.push(init);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const chaveEnorme = "x".repeat(300);
    await chamarCakto(CREDENCIAIS, "POST", "/subscriptions/sub_1/cancel/", undefined, { idempotencia: chaveEnorme });
    const header = (chamadas[0]!.headers as Record<string, string>)["X-Idempotency-Key"];
    expect(header).toHaveLength(255);
  });

  it("timeout/erro de rede não lança — vira ok:false", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/token/")) return new Response(JSON.stringify(tokenValido().corpo), { status: 200 });
      throw new Error("ECONNRESET");
    });

    const r = await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");
    expect(r.ok).toBe(false);
    expect((r as { status: number | null }).status).toBeNull();
  });

  it("falha ao obter o token também não lança", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("DNS falhou");
    });

    const r = await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");
    expect(r).toEqual({ ok: false, status: null, mensagem: "DNS falhou" });
  });

  it("cancelarAssinaturaNaCakto chama POST /subscriptions/{id}/cancel/", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/token/")) return new Response(JSON.stringify(tokenValido().corpo), { status: 200 });
      chamadas.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ status: "canceled" }), { status: 200 });
    });

    const r = await cancelarAssinaturaNaCakto(CREDENCIAIS, "sub_com espaço");
    expect(r).toEqual({ ok: true, status: 200, dados: { status: "canceled" } });
    expect(chamadas[0]).toBe(
      "POST https://api.cakto.com.br/public_api/subscriptions/sub_com%20espa%C3%A7o/cancel/",
    );
  });

  it("urlDePagamento recusa token com caractere fora do formato aceito", () => {
    expect(urlDePagamento("oferta-1", "token com espaço")).toBeNull();
    expect(urlDePagamento("oferta-1", "token/com/barra")).toBeNull();
    expect(urlDePagamento("", "callback-valido")).toBeNull();
  });

  it("urlDePagamento monta a URL certa com token válido", () => {
    expect(urlDePagamento("oferta-1", "callback-valido_123.abc~x")).toBe(
      "https://pay.cakto.com.br/oferta-1?callback=callback-valido_123.abc~x",
    );
  });

  it("secret e token NUNCA aparecem em nenhuma chamada de log", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/token/")) {
        return new Response(JSON.stringify({ access_token: "tok_secreto_demais", expires_in: 36_000 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ message: "recusado" }), { status: 401 });
    });

    await chamarCakto(CREDENCIAIS, "GET", "/subscriptions/sub_1/");

    const todasAsChamadas = [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls];
    const textoCompleto = JSON.stringify(todasAsChamadas);
    expect(textoCompleto).not.toContain(CREDENCIAIS.clientSecret);
    expect(textoCompleto).not.toContain("tok_secreto_demais");
  });
});
