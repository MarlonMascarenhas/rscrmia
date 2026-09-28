import type { Metadata } from "next";
import { Inter, Lexend } from "next/font/google";

import { lerOfertaDaLp } from "./_lp/oferta";
import { Interacoes } from "./_lp/rs/Interacoes";
import "./_lp/rs/lp.css";
import { ANTES_DOS_PLANOS, DEPOIS_DOS_PLANOS, JSON_LD } from "./_lp/rs/markup";
import { Planos } from "./_lp/rs/Planos";

/**
 * A LP DE VENDAS — A RAIZ DO SITE, NESTE FORK.
 *
 * Esta não é a LP genérica de `app/_lp/secoes.tsx` (que fala do produto pela marca
 * branca, sem nome próprio): é a página que o dono da RS CRM IA editou, byte a byte,
 * com "RS CRM IA" e "RS Mídias" escritos como texto fixo — decisão do dono para este
 * fork (ADR-0004), não vazamento a corrigir. O painel continua em `/app`, e `/painel`
 * é a porta de entrada dele (`app/painel/page.tsx`): quem já é cliente entra por lá,
 * quem chegou agora vê esta página.
 *
 * ═══ O MARKUP É DADO, NÃO JSX ═══
 *
 * `ANTES_DOS_PLANOS` e `DEPOIS_DOS_PLANOS` (`./_lp/rs/markup.ts`) são o HTML original
 * tratado como string — copiado verbatim, sem reescrever texto nenhum — porque
 * converter uma página de marketing inteira em JSX seria reescrevê-la, e reescrever é
 * exatamente o que este fork não pode fazer aqui. A seção de planos é a ÚNICA parte
 * que É React (`Planos.tsx`): o preço, o nome e a lista de cada cartão vêm de
 * `OfertaDaLp` (banco, via `/admin/planos`), nunca de texto fixo.
 *
 * `style={{ display: "contents" }}` nos wrappers de `dangerouslySetInnerHTML` evita
 * que a `<div>` que o React precisa para injetar HTML cru vire uma caixa extra na
 * árvore visual — o CSS original (`lp.css`) não tem nenhum seletor de filho direto
 * (`>`), então a caixa não mudaria a aparência, mas o `display:contents` remove
 * qualquer dúvida sobre isso de uma vez.
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
  weight: ["400", "500", "600", "700", "800", "900"],
  display: "swap",
  variable: "--lp-lexend",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--lp-inter",
});

/** A `description` sai do próprio JSON-LD — uma fonte, não duas cópias divergentes. */
function descricaoDoJsonLd(): string {
  const dado = JSON.parse(JSON_LD) as { "@graph": Array<Record<string, unknown>> };
  const app = dado["@graph"].find((n) => n["@type"] === "SoftwareApplication");
  return typeof app?.description === "string" ? app.description : "";
}

export async function generateMetadata(): Promise<Metadata> {
  const description = descricaoDoJsonLd();
  return {
    // `absolute`: esta página não leva o sufixo de marca do layout raiz — o
    // nome já É "RS CRM IA", escrito nesta própria página.
    title: { absolute: "RS CRM IA" },
    description,
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      siteName: "RS CRM IA",
      title: "RS CRM IA",
      description,
    },
  };
}

export default async function LandingPage() {
  const oferta = await lerOfertaDaLp();
  return (
    <div className={`lp-rs ${lexend.variable} ${inter.variable}`}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
      <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: ANTES_DOS_PLANOS }} />
      <Planos oferta={oferta} />
      <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: DEPOIS_DOS_PLANOS }} />
      <Interacoes />
    </div>
  );
}
