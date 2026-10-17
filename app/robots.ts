import type { MetadataRoute } from "next";

import { urlBase } from "./_lp/rs/seo";

/** robots.txt: a LP e as páginas legais indexam; o painel, o admin e a API não. */
// Lê a URL base em runtime: a imagem é pré-buildada, o build não conhece o domínio.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = urlBase();
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/app", "/admin", "/api", "/painel"] },
    sitemap: `${base}/sitemap.xml`,
  };
}
