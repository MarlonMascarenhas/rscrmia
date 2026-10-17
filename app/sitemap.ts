import type { MetadataRoute } from "next";

import { urlBase } from "./_lp/rs/seo";

/** sitemap.xml: só as páginas públicas. Sem URL base configurada, as entradas saem relativas. */
// Lê a URL base em runtime: a imagem é pré-buildada, o build não conhece o domínio.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = urlBase();
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/legal/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/legal/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
