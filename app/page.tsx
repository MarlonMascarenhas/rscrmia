import type { Metadata } from "next";
import { Inter, Lexend } from "next/font/google";

import { lerOfertaDaLp } from "./_lp/oferta";
import "./_lp/rs/lp.css";
import { ANTES_DOS_PLANOS, DEPOIS_DOS_PLANOS } from "./_lp/rs/markup";
import { Planos } from "./_lp/rs/Planos";
import { aplicarPrecosAoHtml, montarJsonLd, urlBase } from "./_lp/rs/seo";

/**
 * A LP DE VENDAS — A RAIZ DO SITE, NESTE FORK.
 *
 * REESCRITA EM 2026-10-17 POR PEDIDO DO DONO: nova estrutura para conversão, copy nova,
 * logo, SEO/AEO/GEO e velocidade. Os depoimentos e os números do hero (+500, 4x, "3x mais
 * rápido") saíram por decisão dele — não eram verificáveis —, e o preço só vem do banco
 * (`/admin/planos`, via `OfertaDaLp`): nenhum valor em reais é escrito na página.
 *
 * Não é a LP genérica de `app/_lp/secoes.tsx` (que fala do produto pela marca branca):
 * "RS CRM IA" e "RS Mídias" escritos como texto fixo são decisão do dono para este fork
 * (ADR-0004), não vazamento a corrigir. O painel continua em `/app`, e `/painel` é a
 * porta de entrada dele (`app/painel/page.tsx`): quem já é cliente entra por lá, quem
 * chegou agora vê esta página.
 *
 * ═══ O MARKUP É DADO, NÃO JSX ═══
 *
 * `ANTES_DOS_PLANOS` e `DEPOIS_DOS_PLANOS` (`./_lp/rs/markup.ts`) são HTML tratado como
 * string. A seção de planos é a ÚNICA parte que É React (`Planos.tsx`): o preço, o nome e
 * a lista de cada cartão vêm de `OfertaDaLp`. A página não tem nenhum componente cliente:
 * FAQ e guia são `<details>`, e a rolagem suave é CSS.
 *
 * O token `{{PRECOS_DA_LP}}` do guia é trocado aqui, em runtime, pelo texto montado de
 * `OfertaDaLp` (`seo.ts`). O JSON-LD (offers, FAQ, organização) sai de `montarJsonLd`.
 *
 * `style={{ display: "contents" }}` nos wrappers de `dangerouslySetInnerHTML` evita que a
 * `<div>` que o React precisa para injetar HTML cru vire uma caixa extra na árvore visual.
 *
 * ═══ POR QUE `force-dynamic` ═══
 *
 * A vitrine de preços é lida em RUNTIME (`lerOfertaDaLp`, memoizada por TTL).
 * Prerenderizar no `next build` congelaria os planos do momento do build — e a
 * imagem self-host é pré-buildada, então a LP sairia sem plano nenhum, porque o
 * build não tem banco.
 *
 * ═══ INDEXÁVEL ═══
 *
 * O layout raiz declara `robots: { index: false }` (o painel não deve aparecer em
 * busca). A LP é a única página que PRECISA aparecer, então sobrescreve aqui.
 */
export const dynamic = "force-dynamic";

const lexend = Lexend({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  display: "swap",
  variable: "--lp-lexend",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--lp-inter",
});

const TITULO = "RS CRM IA: CRM com IA para vender pelo WhatsApp";
const DESCRICAO =
  "CRM com IA para WhatsApp: agente que atende e qualifica, transferência para a equipe com histórico e funil que avança com a conversa. Veja os planos.";

export async function generateMetadata(): Promise<Metadata> {
  const base = urlBase();
  return {
    ...(base ? { metadataBase: new URL(base) } : {}),
    // `absolute`: esta página não leva o sufixo de marca do layout raiz — o
    // nome já É "RS CRM IA", escrito nesta própria página.
    title: { absolute: TITULO },
    description: DESCRICAO,
    ...(base ? { alternates: { canonical: "/" } } : {}),
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      locale: "pt_BR",
      siteName: "RS CRM IA",
      title: TITULO,
      description: DESCRICAO,
      ...(base ? { url: "/" } : {}),
      images: [{ url: "/lp/rs-og.png", width: 1200, height: 630, alt: "RS CRM IA" }],
    },
    twitter: {
      card: "summary_large_image",
      title: TITULO,
      description: DESCRICAO,
      images: ["/lp/rs-og.png"],
    },
    icons: { icon: "/lp/rs-icone-192.png", apple: "/lp/rs-icone-192.png" },
  };
}

export default async function LandingPage() {
  const oferta = await lerOfertaDaLp();
  const jsonLd = montarJsonLd(oferta, urlBase());
  return (
    <div className={`lp-rs ${lexend.variable} ${inter.variable}`}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: ANTES_DOS_PLANOS }} />
      <Planos oferta={oferta} />
      <div
        style={{ display: "contents" }}
        dangerouslySetInnerHTML={{ __html: aplicarPrecosAoHtml(DEPOIS_DOS_PLANOS, oferta) }}
      />
    </div>
  );
}
