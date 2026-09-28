/**
 * A LP DE VENDAS E A PORTA DE ENTRADA DO PAINEL.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. O preço da LP é o preço do banco: vem dos planos publicados, e plano sem preço
 *      vigente NÃO aparece (o checkout o recusaria).
 *   2. Banco fora do ar não derruba a página: a porta de entrada de um negócio não dá 500
 *      por causa da vitrine.
 *   3. A seção de planos (`app/_lp/rs/Planos.tsx`) usa a lista FIXA e verbatim dos três
 *      planos originais (Essencial, Profissional, Completo) e cai para a lista GERADA a
 *      partir de `inclui`/`tetos` em qualquer outro nome — e nunca oferece `/signup`
 *      numa instalação `so_convite`.
 *   4. O markup estático (`app/_lp/rs/markup.ts`) preserva o link ao painel e o texto
 *      original no trecho de antes dos planos, e troca o modal de privacidade por links
 *      reais no trecho de depois — sem sobrar `onclick`, `privModal` nem `openPrivacy`.
 *   5. `/painel` manda o logado para o produto e o deslogado para o login — e sessão que
 *      falha na resolução vai para o login, nunca para um 500.
 *   6. `/painel` é público no proxy, e SÓ ele: `/painel/x` não nasce público de carona.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbFalso } from "./helpers/db-falso-planos";

const dbAtual = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dbAtual.db }));

const auth = vi.hoisted(() => ({ carregar: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: auth.carregar }));

const nav = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: nav.redirect }));

const cadastroAtual = vi.hoisted(() => ({ modo: "aberto" as string, erro: null as Error | null }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({
  modoDeCadastro: () => (cadastroAtual.erro ? Promise.reject(cadastroAtual.erro) : Promise.resolve(cadastroAtual.modo)),
}));

import { isPublicPath } from "@/lib/auth/public-paths";
import { esquecerOfertaDaLp, lerOfertaDaLp, type OfertaDaLp } from "@/app/_lp/oferta";
import { ANTES_DOS_PLANOS, DEPOIS_DOS_PLANOS } from "@/app/_lp/rs/markup";
import { Planos } from "@/app/_lp/rs/Planos";
import PainelPage from "@/app/painel/page";

const config = (ligada: boolean, dias = "7") => ({
  data: [
    { chave: "COBRANCA_LIGADA", valor: ligada ? "ligado" : "desligado" },
    { chave: "DIAS_DE_TESTE", valor: dias },
    { chave: "CARENCIA_DIAS", valor: "5" },
    { chave: "LIMITES_MODO", valor: "avisar" },
  ],
});

const planoPro = {
  nome: "Profissional",
  descricao: "Para times pequenos",
  libera_tudo: false,
  plano_capacidades: [{ capacidade: "campanhas" }, { capacidade: "voz" }],
  plano_limites: [{ limite: "usuarios", valor: "5" }],
  plano_precos: [
    { intervalo: "mensal", valor_cents: "19700", moeda: "BRL", arquivado_em: null },
    { intervalo: "anual", valor_cents: "190000", moeda: "BRL", arquivado_em: null },
    // Preço ANTIGO, arquivado: nunca vai para a página.
    { intervalo: "mensal", valor_cents: "9900", moeda: "BRL", arquivado_em: "2026-01-01" },
  ],
};

beforeEach(() => {
  esquecerOfertaDaLp();
  nav.redirect.mockReset();
  auth.carregar.mockReset();
  cadastroAtual.modo = "aberto";
  cadastroAtual.erro = null;
});

describe("lerOfertaDaLp", () => {
  it("lê os planos publicados com o preço VIGENTE e ignora o arquivado", async () => {
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [planoPro] } }).db;
    const o = await lerOfertaDaLp();
    expect(o.planos).toHaveLength(1);
    expect(o.planos[0]!.precos.mensal).toEqual({ valorCents: 19700, moeda: "BRL" });
    expect(o.planos[0]!.precos.anual).toEqual({ valorCents: 190000, moeda: "BRL" });
  });

  it("traduz capacidades e tetos para o que o cliente lê", async () => {
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [planoPro] } }).db;
    const [p] = (await lerOfertaDaLp()).planos;
    expect(p!.inclui).toEqual(["Campanhas de WhatsApp", "Chamada de voz"]);
    expect(p!.tetos).toEqual(["5 usuários"]);
  });

  it("teto de UM fica no singular, e teto mensal diz 'por mês'", async () => {
    const tetos = {
      ...planoPro,
      plano_limites: [
        { limite: "usuarios", valor: "1" },
        { limite: "conexoes", valor: "1" },
        { limite: "mensagens_por_mes", valor: "1000" },
      ],
    };
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [tetos] } }).db;
    const [p] = (await lerOfertaDaLp()).planos;
    expect(p!.tetos).toEqual(["1 usuário", "1 conexão", "1000 mensagens por mês"]);
  });

  it("plano que LIBERA TUDO não lista capacidades nem tetos", async () => {
    const tudo = { ...planoPro, libera_tudo: true };
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [tudo] } }).db;
    const [p] = (await lerOfertaDaLp()).planos;
    expect(p).toMatchObject({ liberaTudo: true, inclui: [], tetos: [] });
  });

  it("plano SEM preço vigente não aparece — o checkout o recusaria", async () => {
    const semPreco = { ...planoPro, plano_precos: [{ intervalo: "mensal", valor_cents: "100", moeda: "BRL", arquivado_em: "2026-01-01" }] };
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [semPreco] } }).db;
    expect((await lerOfertaDaLp()).planos).toEqual([]);
  });

  it("o teste grátis só existe com a cobrança LIGADA", async () => {
    dbAtual.db = dbFalso({ platform_config: config(true, "14"), planos: { data: [] } }).db;
    expect((await lerOfertaDaLp()).testeGratisDias).toBe(14);
    esquecerOfertaDaLp();
    dbAtual.db = dbFalso({ platform_config: config(false, "14"), planos: { data: [] } }).db;
    // Desligada, quem se cadastra usa sem prazo: prometer "14 dias" seria mentir.
    expect((await lerOfertaDaLp()).testeGratisDias).toBeNull();
  });

  it("erro do banco devolve a oferta VAZIA — a página segue de pé", async () => {
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { error: { message: "boom" } } }).db;
    expect(await lerOfertaDaLp()).toEqual({ planos: [], testeGratisDias: null, cadastro: "aberto" });
  });

  it("cliente que EXPLODE não lança", async () => {
    dbAtual.db = { from: () => { throw new Error("morto"); } };
    expect(await lerOfertaDaLp()).toEqual({ planos: [], testeGratisDias: null, cadastro: "aberto" });
  });

  it("cadastro 'so_convite' não tem teste grátis, mesmo com a cobrança ligada", async () => {
    cadastroAtual.modo = "so_convite";
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [] } }).db;
    const o = await lerOfertaDaLp();
    expect(o.testeGratisDias).toBeNull();
    expect(o.cadastro).toBe("so_convite");
  });

  it("erro na leitura dos planos preserva o modo de cadastro lido", async () => {
    cadastroAtual.modo = "so_convite";
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { error: { message: "boom" } } }).db;
    expect(await lerOfertaDaLp()).toEqual({ planos: [], testeGratisDias: null, cadastro: "so_convite" });
  });

  it("modoDeCadastro que LANÇA não lança a oferta: cai em 'aberto'", async () => {
    cadastroAtual.erro = new Error("boom");
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [] } }).db;
    await expect(lerOfertaDaLp()).resolves.toEqual({ planos: [], testeGratisDias: 7, cadastro: "aberto" });
  });

  it("memoiza por um minuto e depois relê", async () => {
    const primeiro = dbFalso({ platform_config: config(true), planos: { data: [planoPro] } });
    dbAtual.db = primeiro.db;
    await lerOfertaDaLp(1_000);
    const consultasDepoisDaPrimeira = primeiro.consultas.length;
    await lerOfertaDaLp(30_000);
    expect(primeiro.consultas.length).toBe(consultasDepoisDaPrimeira); // dentro do TTL: sem ida ao banco
    await lerOfertaDaLp(70_000);
    expect(primeiro.consultas.length).toBeGreaterThan(consultasDepoisDaPrimeira);
  });
});

describe("a vitrine de planos (app/_lp/rs/Planos.tsx)", () => {
  const ofertaBase = (planos: OfertaDaLp["planos"], cadastro: OfertaDaLp["cadastro"] = "aberto"): OfertaDaLp => ({
    planos,
    testeGratisDias: null,
    cadastro,
  });

  const planoProfissional = {
    nome: "Profissional",
    descricao: "Para times pequenos",
    liberaTudo: false,
    precos: { mensal: { valorCents: 21700, moeda: "BRL" } },
    inclui: [],
    tetos: [],
  };

  it("plano 'Profissional': R$, valor sem símbolo, badge, classe 'pop', item original, e /signup", () => {
    const html = renderToStaticMarkup(<Planos oferta={ofertaBase([planoProfissional])} />);
    expect(html).toContain("R$");
    expect(html).toContain("217");
    expect(html).toContain("Mais escolhido");
    expect(html).toContain('class="plan-card pop"');
    expect(html).toContain("Follow-up automático");
    expect(html).toContain('href="/signup"');
  });

  it("plano com nome fora dos três originais usa a lista GERADA, e não é 'pop'", () => {
    const turbo = {
      nome: "Turbo",
      descricao: null,
      liberaTudo: false,
      precos: { mensal: { valorCents: 9900, moeda: "BRL" } },
      inclui: ["Campanhas de WhatsApp"],
      tetos: ["5 usuários"],
    };
    const html = renderToStaticMarkup(<Planos oferta={ofertaBase([turbo])} />);
    expect(html).toContain("Campanhas de WhatsApp");
    expect(html).toContain("Até 5 usuários");
    expect(html).not.toContain("Mais escolhido");
    expect(html).not.toContain('class="plan-card pop"');
  });

  it("'so_convite': todo botão de plano diz 'Entrar' e leva a /painel — nenhum /signup", () => {
    const html = renderToStaticMarkup(<Planos oferta={ofertaBase([planoProfissional], "so_convite")} />);
    expect(html).not.toContain('href="/signup"');
    expect(html).toContain('href="/painel"');
    expect(html).toContain("Entrar");
  });

  it("oferta vazia: mostra o aviso e a garantia-bar, sem grid de planos", () => {
    const html = renderToStaticMarkup(<Planos oferta={ofertaBase([])} />);
    expect(html).toContain("Os planos estão sendo atualizados");
    expect(html).toContain("garantia-bar");
    expect(html).toContain("Cancele quando quiser, sem burocracia");
  });
});

describe("o markup estático (app/_lp/rs/markup.ts)", () => {
  it("ANTES_DOS_PLANOS mantém o link ao painel e o texto original do hero", () => {
    expect(ANTES_DOS_PLANOS).toContain('href="/painel" class="nav-a">Entrar');
    expect(ANTES_DOS_PLANOS).toContain("Pare de perder clientes");
  });

  it("DEPOIS_DOS_PLANOS troca o modal de privacidade por links reais", () => {
    expect(DEPOIS_DOS_PLANOS).toContain('href="/legal/privacy"');
    expect(DEPOIS_DOS_PLANOS).toContain('href="/legal/terms"');
  });

  it("nenhuma das duas strings sobrevive com onclick, privModal ou openPrivacy", () => {
    for (const trecho of [ANTES_DOS_PLANOS, DEPOIS_DOS_PLANOS]) {
      expect(trecho).not.toContain("onclick");
      expect(trecho).not.toContain("privModal");
      expect(trecho).not.toContain("openPrivacy");
    }
  });
});

describe("/painel — a porta de entrada", () => {
  it("logado vai para o produto", async () => {
    auth.carregar.mockResolvedValue({ id: "u1" });
    await PainelPage();
    expect(nav.redirect).toHaveBeenCalledWith("/app");
  });

  it("deslogado vai para o login, guardando o destino", async () => {
    auth.carregar.mockResolvedValue(null);
    await PainelPage();
    expect(nav.redirect).toHaveBeenCalledWith("/login?next=/app");
  });

  it("sessão que FALHA ao resolver vai para o login — nunca um 500", async () => {
    auth.carregar.mockRejectedValue(new Error("auth_permissions_unavailable"));
    await expect(PainelPage()).resolves.not.toThrow();
    expect(nav.redirect).toHaveBeenCalledWith("/login?next=/app");
  });
});

describe("/painel no proxy", () => {
  it("é público, e a raiz também", () => {
    expect(isPublicPath("/painel")).toBe(true);
    expect(isPublicPath("/")).toBe(true);
  });
  it("mas NADA sob /painel nasce público de carona", () => {
    for (const p of ["/painel/", "/painel/qualquer", "/painelx", "/painel/admin"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
  it("o produto e o admin continuam protegidos", () => {
    for (const p of ["/app", "/app/inbox", "/admin", "/admin/planos"]) expect(isPublicPath(p), p).toBe(false);
  });
});
