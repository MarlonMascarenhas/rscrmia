import type { Metadata } from "next";

import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { camadaDaInstalacao, camadaDoAmbiente, resolverMarca } from "@/lib/branding/resolve";
import { env } from "@/lib/env";

import { lerOfertaDaLp } from "./_lp/oferta";
import { Cabecalho, ChamadaFinal, ComoFunciona, Hero, Nichos, Perguntas, Planos, Recursos, Rodape } from "./_lp/secoes";

/**
 * A LP DE VENDAS — A RAIZ DO SITE.
 *
 * Antes daqui a raiz só redirecionava para `/app`. O painel continua em `/app`, e
 * `/painel` é a porta de entrada dele (`app/painel/page.tsx`): quem já é cliente
 * entra por lá, quem chegou agora vê esta página.
 *
 * ═══ DINÂMICA DE PROPÓSITO ═══
 *
 * O nome do produto e a vitrine de planos são lidos em RUNTIME (marca da instalação e
 * `planos`). Prerenderizar no `next build` congelaria a marca do build — e a imagem
 * self-host é pré-buildada, então carregaria a nossa marca para sempre — e sairia sem
 * plano nenhum, porque o build não tem banco. Ver `lib/branding.ts`.
 *
 * ═══ INDEXÁVEL ═══
 *
 * O layout raiz declara `robots: { index: false }` (o painel não deve aparecer em
 * busca). A LP é a única página que PRECISA aparecer, então o sobrescreve aqui.
 * Sem isso, a página de venda seria invisível para quem procura.
 */
export const dynamic = "force-dynamic";

async function nomeDoProduto(): Promise<string> {
  // A MESMA pilha de camadas do layout raiz (banco acima, `.env` embaixo): duas
  // resoluções divergiriam, e a divergência apareceria como a aba com uma marca e a
  // página com outra.
  const linha = await marcaDaInstalacao();
  return resolverMarca([camadaDaInstalacao(linha), camadaDoAmbiente(env)], REGUA_DO_PRODUTO).name;
}

export async function generateMetadata(): Promise<Metadata> {
  const nome = await nomeDoProduto();
  return {
    // `absolute`: a raiz é a única página em que o título não leva o sufixo da marca.
    title: { absolute: `${nome} — atendimento e vendas por WhatsApp com agentes de IA` },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      siteName: nome,
      title: `${nome} — atendimento e vendas por WhatsApp`,
      description:
        "Centralize o atendimento por WhatsApp num funil só. Agentes de IA resolvem o que dá para resolver e passam para o time humano o que importa.",
    },
  };
}

export default async function LandingPage() {
  const [nome, oferta] = await Promise.all([nomeDoProduto(), lerOfertaDaLp()]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Ir para o conteúdo
      </a>
      <Cabecalho nome={nome} oferta={oferta} />
      <main id="conteudo">
        <Hero oferta={oferta} />
        <Recursos />
        <ComoFunciona />
        <Nichos />
        <Planos oferta={oferta} />
        <Perguntas oferta={oferta} />
        <ChamadaFinal oferta={oferta} />
      </main>
      <Rodape nome={nome} />
    </div>
  );
}
