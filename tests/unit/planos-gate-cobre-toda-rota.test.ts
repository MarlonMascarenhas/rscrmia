/**
 * O GATE DE COBRANÇA ALCANÇA TODA ROTA DE `/api/v1`, OU A EXCEÇÃO ESTÁ ESCRITA.
 *
 * ═══ POR QUE ESTE GATE EXISTE ═══
 *
 * Medido antes de construir: `requireRole` cobre 249 das 356 rotas. As outras 107
 * são 22 de `/admin`, 31 de `/cron`, 9 de webhooks e 6 de sistema — todas
 * corretamente isentas — **e 40 tenant-aware que escapam**, entre elas
 * `app/api/v1/conversations/route.ts`, `pipelines/[id]/board` e, a mais grave,
 * `app/api/v1/messages/route.ts`: ENVIAR MENSAGEM, que resolve por
 * `resolveAuthDual` e nunca por `requireRole`.
 *
 * Um gate só em `requireRole` deixaria a ação mais valiosa do produto aberta para
 * quem não paga — com a TELA dizendo "vencido". É o modo de falha mais caro
 * possível, porque parece resolvido.
 *
 * Por isso há três pontos (`lib/auth/require-role.ts`, `lib/mcp/auth.ts` e a
 * guarda explícita), e por isso existe esta varredura: ela é o que impede a 41ª
 * rota de nascer sem gate. `lib/voice/guarda.ts:4-10` já escreveu a lição —
 * "repetição de gate é como se perde um: a sétima rota nasce sem ele".
 *
 * ═══ POR QUE COBRE LEITURA TAMBÉM, E NÃO SÓ MUTAÇÃO ═══
 *
 * Diferente da varredura de `requireSupportWrite`, que só olha handlers mutantes.
 * Ler É o produto: um integrador puxando contatos de uma organização vencida pelo
 * Bearer é exatamente o uso que está sendo vendido. Cobrar só escrita venderia
 * metade do produto de graça.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SEM_GATE_DE_COBRANCA } from "@/lib/planos/guarda";

import { emBarraNormal } from "./helpers/caminho";

function arquivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((item) =>
      item.isDirectory() ? arquivos(join(dir, item.name)) : [join(dir, item.name)],
    )
    .map(emBarraNormal);
}

const ROTAS = arquivos("app/api/v1").filter((p) => p.endsWith("/route.ts"));

const METODOS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Os três caminhos pelos quais uma rota CHEGA ao gate.
 *
 * `requireRole` e `validateBearerToken` gatearam por dentro (é o ponto do
 * desenho: uma função, não um `if` por rota). `resolveAuthDual` chama
 * `validateBearerToken` no ramo Bearer e `requireRole` no de cookie, então conta.
 * `exigirAcessoLiberado` é a chamada explícita, para quem resolve a organização
 * só por `resolveActiveOrg`.
 */
const CHEGA_AO_GATE = [
  "requireRole",
  "resolveAuthDual",
  "validateBearerToken",
  "exigirAcessoLiberado",
  // Platform admin nunca é gateado por cobrança de tenant, de propósito: quem
  // administra a instalação é quem LIBERA. `requireRole` já sai cedo para ele.
  "requirePlatformAdmin",
  // `lib/extensions/http.ts:43` confere `is_platform_admin`: é a mesma natureza
  // do acima — quem instala pacote na instância é quem administra a instalação,
  // não um cliente pagando assinatura.
  "requireExtensionPlatform",
];

/**
 * O texto da rota MAIS o dos helpers locais que ela importa.
 *
 * O padrão desta casa é a rota ser uma casca e o gate morar num `_shared.ts` ou
 * `_handler.ts` vizinho — `app/api/v1/team/[user_id]/role/route.ts` é literalmente
 * um alias que delega para `changeMemberRole` de `../_shared`. Lendo só o arquivo
 * da rota, a varredura acusava 4 rotas corretamente gateadas.
 *
 * Um nível de profundidade, e só para caminho RELATIVO: o objetivo é enxergar a
 * casca, não resolver o grafo de módulos. Um helper que esconda o gate a dois
 * saltos cai como descoberta — e falhar fechado aqui custa uma justificativa,
 * enquanto falhar aberto custa uma rota sem gate.
 */
function textoComHelpersLocais(path: string): string {
  const src = readFileSync(path, "utf8");
  const dir = path.slice(0, path.lastIndexOf("/"));
  let texto = src;
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const rel = m[1];
    for (const sufixo of [".ts", "/index.ts", ".tsx"]) {
      const alvo = emBarraNormal(join(dir, rel + sufixo));
      try {
        texto += "\n" + readFileSync(alvo, "utf8");
        break;
      } catch {
        // Import que não resolve para arquivo local (alias, pacote) é ignorado:
        // o que interessa aqui é a casca que delega para o vizinho.
      }
    }
  }
  return texto;
}

/**
 * Rotas que não passam por nenhum dos três e não estão sob prefixo isento.
 *
 * Toda linha tem RAZÃO ESCRITA, e é isso que faz a lista ser revisável em vez de
 * um depósito. Razão que não explica por que a cobrança não se aplica é razão
 * recusada na revisão — o gate não sabe julgar prosa, mas quem revisa sabe.
 */
const SEM_GATE_COM_RAZAO: Readonly<Record<string, string>> = {
  "app/api/v1/auth/realtime-token/route.ts":
    "Emite token de Realtime para uma sessão já autenticada. O canal que ele abre só transporta o que a RLS deixa passar, e a organização vencida não recebe evento porque as rotas que ESCREVEM estão gateadas.",
  "app/api/v1/auth/support/route.ts":
    "Superfície de acompanhamento de suporte, da instalação. Gate próprio; e trancar aqui prenderia quem administra fora do diagnóstico.",
  "app/api/v1/integrations/nuvemshop/callback/route.ts":
    "Callback de OAuth do provedor externo, autenticado pelo state assinado. Barrá-lo deixaria a conexão pela metade, sem desfazer o lado de lá.",
  "app/api/v1/plataformas-de-anuncio/google/callback/route.ts":
    "Callback de OAuth do Google, autenticado pelo state. Mesma razão do acima.",
  "app/api/v1/agenda/google/callback/route.ts":
    "Callback de OAuth do Google Agenda, autenticado pelo state. Mesma razão.",
  "app/api/v1/anuncios/google/[org]/route.ts":
    "Endereçada por token no path (não por sessão), servindo a landing de anúncio que roda FORA do produto. Trancar aqui derrubaria a captação de lead de quem está justamente tentando voltar a pagar.",
  "app/api/v1/anuncios/meta/[org]/route.ts":
    "Mesma razão da irmã do Google: endereçada por token no path, servindo landing que roda fora do produto. Trancar derrubaria a captação de lead de quem está tentando voltar a pagar.",
};

describe("controle positivo — a varredura enxerga o que diz varrer", () => {
  // Sem isto, uma varredura quebrada devolve zero rotas, e zero é
  // indistinguível de "está tudo em ordem". Foi assim que o separador de caminho
  // do Windows passou despercebido no gate de suporte (ver o cabeçalho dele).
  it("acha as rotas de /api/v1", () => {
    expect(ROTAS.length).toBeGreaterThan(300);
  });

  it("acha as rotas que o gate de fato alcança", () => {
    const comGate = ROTAS.filter((p) =>
      CHEGA_AO_GATE.some((f) => textoComHelpersLocais(p).includes(f)),
    );
    expect(comGate.length).toBeGreaterThan(200);
  });

  it("enxerga o gate que mora num helper vizinho", () => {
    // Controle do seguidor de imports: esta rota é uma casca que delega para
    // `../_shared`. Se o seguidor quebrar, ela volta a ser acusada — e alguém
    // "consertaria" acrescentando um gate que já existe, ou a poria na allowlist.
    const alias = "app/api/v1/team/[user_id]/role/route.ts";
    expect(readFileSync(alias, "utf8")).not.toContain("requireRole");
    expect(textoComHelpersLocais(alias)).toContain("requireRole");
  });

  it("as rotas nomeadas na allowlist existem de verdade", () => {
    // Allowlist que aponta para arquivo inexistente é allowlist que já cobriu
    // uma rota renomeada — e a rota nova entrou sem gate, sem ninguém notar.
    for (const rota of Object.keys(SEM_GATE_COM_RAZAO)) {
      expect(ROTAS, `${rota} está na allowlist mas não existe`).toContain(rota);
    }
  });

  it("toda razão da allowlist é uma frase, não um carimbo", () => {
    for (const [rota, razao] of Object.entries(SEM_GATE_COM_RAZAO)) {
      expect(razao.length, `${rota}: razão curta demais para ser uma razão`).toBeGreaterThan(60);
    }
  });
});

describe("as portas de saída são declaradas, não improvisadas", () => {
  it("toda porta de saída tem prefixo e razão escrita", () => {
    expect(SEM_GATE_DE_COBRANCA.length).toBeGreaterThan(5);
    for (const p of SEM_GATE_DE_COBRANCA) {
      expect(p.prefixo.startsWith("/api/v1/")).toBe(true);
      expect(p.porque.length, `${p.prefixo}: razão curta demais`).toBeGreaterThan(40);
    }
  });

  it("o webhook e o cron estão de fora — é o impasse que se fecha sobre si mesmo", () => {
    // Trancar o webhook do provedor faria o pagamento não conseguir destrancar a
    // conta que ele acabou de pagar. E barrar a ingestão do WhatsApp perderia
    // mensagem para sempre: quem volta a pagar acharia um buraco no histórico.
    const prefixos = SEM_GATE_DE_COBRANCA.map((p) => p.prefixo);
    expect(prefixos).toContain("/api/v1/webhooks/");
    expect(prefixos).toContain("/api/v1/cron/");
  });

  it("a porta de pagar e a de cancelar estão de fora", () => {
    // `lib/voice/guarda.ts:11-21`: o interruptor de desligar não pode exigir a
    // coisa ligada. Aqui, quem está trancado precisa poder pagar E cancelar.
    expect(SEM_GATE_DE_COBRANCA.map((p) => p.prefixo)).toContain("/api/v1/cobranca/");
  });

  it("a exportação de LGPD está de fora — é direito legal, não cortesia", () => {
    expect(SEM_GATE_DE_COBRANCA.map((p) => p.prefixo)).toContain("/api/v1/lgpd/");
  });

  it("nenhuma porta de saída é um prefixo largo demais", () => {
    // `/api/v1/` isento seria o gate inteiro desligado por uma linha.
    for (const p of SEM_GATE_DE_COBRANCA) {
      expect(p.prefixo.replace("/api/v1/", "").length, `${p.prefixo} é largo demais`).toBeGreaterThan(3);
    }
  });
});

it("toda rota de /api/v1 chega ao gate de cobrança, está sob prefixo isento, ou tem razão escrita", () => {
  const descobertas: string[] = [];

  for (const path of ROTAS) {
    // Prefixo isento: a lista vive no CÓDIGO (`lib/planos/guarda.ts`), não aqui.
    // Duas listas divergiriam, e a cópia do teste envelheceria em silêncio.
    const rota = "/" + path.replace(/^app\//, "").replace(/\/route\.ts$/, "");
    if (SEM_GATE_DE_COBRANCA.some((p) => rota.startsWith(p.prefixo))) continue;
    if (path in SEM_GATE_COM_RAZAO) continue;

    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );

    // As DUAS formas de exportar handler no App Router. A varredura do gate de
    // suporte só enxergava `export async function`, e `export const PATCH = …`
    // passava sem guarda nenhuma com o gate verde — o mesmo erro não se repete.
    const handlers: string[] = [];
    for (const node of source.statements) {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        (METODOS as readonly string[]).includes(node.name.text)
      ) {
        handlers.push(node.name.text);
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            (METODOS as readonly string[]).includes(decl.name.text)
          ) {
            handlers.push(decl.name.text);
          }
        }
      }
    }
    if (handlers.length === 0) continue;

    // O arquivo inteiro MAIS os helpers locais, e não só o corpo do handler: o
    // padrão do repo é chamar o gate num `_handler.ts` ou `_shared.ts` vizinho, e
    // exigir a chamada dentro do corpo acusaria rota corretamente gateada.
    const src = textoComHelpersLocais(path);
    if (CHEGA_AO_GATE.some((f) => src.includes(f))) continue;

    descobertas.push(`${path}:${handlers.join(",")}`);
  }

  expect(
    descobertas,
    [
      "Rotas de app/api/v1 que NÃO chegam ao gate de cobrança:",
      ...descobertas.map((d) => `  - ${d}`),
      "",
      "Uma organização com a assinatura vencida alcança estas rotas. O gate tem TRÊS pontos:",
      "  1. requireRole()        — lib/auth/require-role.ts (cobre a maioria)",
      "  2. validateBearerToken  — lib/mcp/auth.ts (o ramo Bearer dsk_, inclui o envio de mensagem)",
      "  3. exigirAcessoLiberado — lib/planos/guarda.ts, para quem só usa resolveActiveOrg",
      "",
      "Se a rota é PORTA DE SAÍDA (pagar, cancelar, sair, exportar LGPD), acrescente o prefixo em",
      "SEM_GATE_DE_COBRANCA, em lib/planos/guarda.ts, COM a razão escrita.",
      "Se é infraestrutura sem sessão de organização, acrescente em SEM_GATE_COM_RAZAO neste arquivo,",
      "também com a razão. Razão que não explica por que a cobrança não se aplica é recusada na revisão.",
    ].join("\n"),
  ).toEqual([]);
});
