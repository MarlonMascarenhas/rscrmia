/**
 * SEO / AEO / GEO DA LP — funções puras, testáveis (tests/unit/lp-seo.test.ts).
 *
 * Duas regras que moram aqui:
 *
 *   1. PREÇO SÓ VEM DO BANCO. `textoDePrecos` e os `offers` do JSON-LD leem
 *      `OfertaDaLp` (planos publicados em `/admin/planos`); nenhum valor em reais é
 *      escrito neste arquivo nem em `markup.ts`. Sem plano com preço vigente, o JSON-LD
 *      não declara `offers` — melhor omitir do que afirmar o que o checkout não cobra.
 *   2. A URL BASE NÃO É ESCRITA NO CÓDIGO. Ela sai de `NEXT_PUBLIC_APP_URL` (o mesmo
 *      que o resto do produto usa para montar links absolutos). Sem ela, as URLs saem
 *      relativas — a página continua válida, só perde o canônico absoluto.
 *
 * Nunca lança: a porta de entrada de um negócio não dá 500 por causa de metadado.
 */
import { env } from "@/lib/env";

import type { OfertaDaLp, PlanoDaLp } from "../oferta";
import { FAQ_ITENS, JSON_LD } from "./markup";

export const TOKEN_DE_PRECOS = "{{PRECOS_DA_LP}}";

const SEM_PLANOS = "Os valores vigentes estão na seção de planos desta página.";

/** `NEXT_PUBLIC_APP_URL` sem barra final; string vazia quando ausente ou ilegível. */
export function urlBase(bruto?: string): string {
  try {
    const valor = bruto ?? env.NEXT_PUBLIC_APP_URL;
    if (typeof valor !== "string") return "";
    const limpo = valor.trim().replace(/\/+$/, "");
    if (!limpo) return "";
    return new URL(limpo).origin === "null" ? "" : limpo;
  } catch {
    return "";
  }
}

/** O símbolo que o `Intl` usa para a moeda ("R$" para BRL). */
function simboloDaMoeda(moeda: string): string {
  try {
    const partes = new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).formatToParts(0);
    return partes.find((p) => p.type === "currency")?.value ?? moeda;
  } catch {
    return moeda;
  }
}

/** "97" para 9700 centavos; "217,50" para 21750 — o mesmo formato de `Planos.tsx`. */
function valorSemSimbolo(cents: number): string {
  const formatado = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    cents / 100,
  );
  return formatado.endsWith(",00") ? formatado.slice(0, -3) : formatado;
}

type PrecoVigente = { valorCents: number; moeda: string };

function precoPrincipal(plano: PlanoDaLp): { preco: PrecoVigente; intervalo: "mensal" | "anual" } | null {
  if (plano.precos.mensal) return { preco: plano.precos.mensal, intervalo: "mensal" };
  if (plano.precos.anual) return { preco: plano.precos.anual, intervalo: "anual" };
  return null;
}

/** "A", "A e B", "A, B e C". */
function listar(itens: string[]): string {
  if (itens.length <= 1) return itens.join("");
  return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}

export function textoDePrecos(oferta: OfertaDaLp): string {
  const itens: string[] = [];
  for (const plano of oferta.planos) {
    const p = precoPrincipal(plano);
    if (!p) continue;
    const sufixo = p.intervalo === "mensal" ? "/mês" : "/ano";
    itens.push(`${plano.nome} (${simboloDaMoeda(p.preco.moeda)} ${valorSemSimbolo(p.preco.valorCents)}${sufixo})`);
  }
  if (itens.length === 0) return SEM_PLANOS;
  const abertura = itens.length === 1 ? "O plano vigente é:" : "Os planos vigentes são:";
  return `${abertura} ${listar(itens)}.`;
}

/** Escapa o texto para entrar em HTML (o token é trocado dentro de `markup.ts`). */
export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Troca o token de preços do HTML pelo texto do banco, já escapado. */
export function aplicarPrecosAoHtml(html: string, oferta: OfertaDaLp): string {
  return html.split(TOKEN_DE_PRECOS).join(escaparHtml(textoDePrecos(oferta)));
}

type No = Record<string, unknown>;

export function montarJsonLd(oferta: OfertaDaLp, base: string): string {
  const dado = JSON.parse(JSON_LD) as { "@context": string; "@graph": No[] };
  const precos = textoDePrecos(oferta);
  const comPrecos = (texto: string) => texto.split(TOKEN_DE_PRECOS).join(precos);

  const orgId = `${base}#org`;
  const offers = oferta.planos.flatMap((plano) => {
    const p = precoPrincipal(plano);
    if (!p) return [];
    return [
      {
        "@type": "Offer",
        name: plano.nome,
        price: (p.preco.valorCents / 100).toFixed(2),
        priceCurrency: p.preco.moeda,
        url: `${base}/#planos`,
      },
    ];
  });

  const grafo: No[] = dado["@graph"].map((no) => {
    if (no["@type"] === "SoftwareApplication") {
      return {
        ...no,
        url: base || "/",
        image: `${base}/lp/rs-og.png`,
        ...(offers.length > 0 ? { offers } : {}),
        publisher: {
          "@type": "Organization",
          "@id": orgId,
          name: "RS Mídias e Anúncios LTDA",
          brand: "RS CRM IA",
          logo: `${base}/lp/rs-icone-512.png`,
          url: base || "/",
        },
      };
    }
    if (no["@type"] === "FAQPage") {
      const existentes: No[] = (no.mainEntity as No[]).map((q) => ({
        ...q,
        acceptedAnswer: {
          ...(q.acceptedAnswer as No),
          text: comPrecos(String((q.acceptedAnswer as No).text)),
        },
      }));
      const nomes = new Set(existentes.map((q) => q.name));
      const visiveis = FAQ_ITENS.filter((i) => !nomes.has(i.pergunta)).map((i) => ({
        "@type": "Question",
        name: i.pergunta,
        acceptedAnswer: { "@type": "Answer", text: i.resposta },
      }));
      return { ...no, mainEntity: [...existentes, ...visiveis] };
    }
    return no;
  });

  grafo.push({
    "@type": "WebSite",
    name: "RS CRM IA",
    url: base || "/",
    inLanguage: "pt-BR",
  });

  return JSON.stringify({ "@context": dado["@context"], "@graph": grafo }).replace(/</g, "\\u003c");
}
