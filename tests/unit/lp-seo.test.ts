/**
 * SEO DA LP (`app/_lp/rs/seo.ts`): o preço dito aos buscadores é o do banco, e o JSON-LD
 * é JSON válido que nunca fecha a tag <script> por engano.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://exemplo.test/" } }));

import type { OfertaDaLp, PlanoDaLp } from "@/app/_lp/oferta";
import { aplicarPrecosAoHtml, montarJsonLd, textoDePrecos, urlBase } from "@/app/_lp/rs/seo";

const plano = (nome: string, precos: PlanoDaLp["precos"]): PlanoDaLp => ({
  nome,
  descricao: null,
  liberaTudo: false,
  precos,
  inclui: [],
  tetos: [],
});
const mensal = (cents: number) => ({ mensal: { valorCents: cents, moeda: "BRL" } });
const oferta = (planos: PlanoDaLp[]): OfertaDaLp => ({ planos, testeGratisDias: null, cadastro: "aberto" });

const TRES = oferta([
  plano("Essencial", mensal(9700)),
  plano("Profissional", mensal(21700)),
  plano("Completo", mensal(29700)),
]);

describe("urlBase", () => {
  it("tira a barra final e lê NEXT_PUBLIC_APP_URL", () => {
    expect(urlBase()).toBe("https://exemplo.test");
    expect(urlBase("https://outro.test///")).toBe("https://outro.test");
  });
  it("vazio ou ilegível devolve string vazia, sem lançar", () => {
    expect(urlBase("")).toBe("");
    expect(urlBase("isto nao e url")).toBe("");
  });
});

describe("textoDePrecos", () => {
  it("lista nome e valor dos planos vigentes, como a vitrine formata", () => {
    expect(textoDePrecos(TRES)).toBe(
      "Os planos vigentes são: Essencial (R$ 97/mês), Profissional (R$ 217/mês) e Completo (R$ 297/mês).",
    );
  });
  it("centavos aparecem; plano só anual vira /ano", () => {
    const o = oferta([plano("Essencial", mensal(9750)), plano("Anual", { anual: { valorCents: 100000, moeda: "BRL" } })]);
    expect(textoDePrecos(o)).toBe("Os planos vigentes são: Essencial (R$ 97,50/mês) e Anual (R$ 1.000/ano).");
  });
  it("sem planos remete à seção de planos", () => {
    expect(textoDePrecos(oferta([]))).toBe("Os valores vigentes estão na seção de planos desta página.");
  });
  it("plano sem nenhum preço não entra", () => {
    expect(textoDePrecos(oferta([plano("Fantasma", {})]))).toBe(
      "Os valores vigentes estão na seção de planos desta página.",
    );
  });
});

describe("aplicarPrecosAoHtml", () => {
  it("troca o token e escapa o HTML do texto", () => {
    const o = oferta([plano("<b>X</b>", mensal(1000))]);
    const html = aplicarPrecosAoHtml("a {{PRECOS_DA_LP}} b", o);
    expect(html).not.toContain("{{PRECOS_DA_LP}}");
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });
});

describe("montarJsonLd", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nos = (json: string) => (JSON.parse(json) as { "@graph": Array<Record<string, any>> })["@graph"];

  it("é JSON parseável e não contém '<' cru", () => {
    const json = montarJsonLd(TRES, "https://exemplo.test");
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain("<");
    const comMenor = montarJsonLd(oferta([plano("A<script>", mensal(100))]), "");
    expect(comMenor).not.toContain("<");
    expect(JSON.stringify(nos(comMenor))).toContain("A<script>");
  });

  it("offers vêm do banco, um por plano com preço vigente", () => {
    const app = nos(montarJsonLd(TRES, "https://exemplo.test")).find((n) => n["@type"] === "SoftwareApplication")!;
    expect(app.offers).toEqual([
      { "@type": "Offer", name: "Essencial", price: "97.00", priceCurrency: "BRL", url: "https://exemplo.test/#planos" },
      { "@type": "Offer", name: "Profissional", price: "217.00", priceCurrency: "BRL", url: "https://exemplo.test/#planos" },
      { "@type": "Offer", name: "Completo", price: "297.00", priceCurrency: "BRL", url: "https://exemplo.test/#planos" },
    ]);
    expect(app.image).toBe("https://exemplo.test/lp/rs-og.png");
    expect(app.publisher).toMatchObject({
      "@id": "https://exemplo.test#org",
      name: "RS Mídias e Anúncios LTDA",
      brand: "RS CRM IA",
      logo: "https://exemplo.test/lp/rs-icone-512.png",
    });
  });

  it("sem planos não há offers", () => {
    const app = nos(montarJsonLd(oferta([]), "https://exemplo.test")).find((n) => n["@type"] === "SoftwareApplication")!;
    expect(app).not.toHaveProperty("offers");
  });

  it("tem WebSite e o FAQPage inclui a FAQ visível; o custo usa o texto do banco", () => {
    const grafo = nos(montarJsonLd(TRES, "https://exemplo.test"));
    expect(grafo.find((n) => n["@type"] === "WebSite")).toMatchObject({ name: "RS CRM IA", inLanguage: "pt-BR" });
    const faq = grafo.find((n) => n["@type"] === "FAQPage")!;
    const perguntas = faq.mainEntity.map((q: { name: string }) => q.name);
    expect(perguntas).toContain("Preciso ter o WhatsApp Business para usar?");
    const custo = faq.mainEntity.find((q: { name: string }) => q.name.startsWith("Quanto custa"));
    expect(custo.acceptedAnswer.text).toContain("Essencial (R$ 97/mês)");
    expect(JSON.stringify(grafo)).not.toContain("{{PRECOS_DA_LP}}");
  });

  it("sem base, as URLs saem relativas", () => {
    const app = nos(montarJsonLd(TRES, "")).find((n) => n["@type"] === "SoftwareApplication")!;
    expect(app.image).toBe("/lp/rs-og.png");
    expect(app.offers[0].url).toBe("/#planos");
  });
});
