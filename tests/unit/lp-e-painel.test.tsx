/**
 * A LP DE VENDAS E A PORTA DE ENTRADA DO PAINEL.
 *
 * O que estes casos protegem, em ordem de gravidade:
 *
 *   1. A LP nunca promete o que o produto não faz. "Teste grátis" e "sem cartão" só
 *      aparecem quando o teste existe (cobrança ligada); desligada, a página troca a
 *      promessa por uma frase que continua verdadeira.
 *   2. O preço da LP é o preço do banco: vem dos planos publicados, e plano sem preço
 *      vigente NÃO aparece (o checkout o recusaria).
 *   3. Banco fora do ar não derruba a página: a porta de entrada de um negócio não dá 500
 *      por causa da vitrine.
 *   4. `/painel` manda o logado para o produto e o deslogado para o login — e sessão que
 *      falha na resolução vai para o login, nunca para um 500.
 *   5. `/painel` é público no proxy, e SÓ ele: `/painel/x` não nasce público de carona.
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
import { esquecerOfertaDaLp, lerOfertaDaLp } from "@/app/_lp/oferta";
import {
  Cabecalho,
  Hero,
  Perguntas,
  Planos,
  rotuloDoCadastro,
} from "@/app/_lp/secoes";
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

describe("o que a página promete", () => {
  const comTeste = { planos: [], testeGratisDias: 7, cadastro: "aberto" as const };
  const semTeste = { planos: [], testeGratisDias: null, cadastro: "aberto" as const };
  const soConvite = { planos: [], testeGratisDias: null, cadastro: "so_convite" as const };
  const comAprovacao = { planos: [], testeGratisDias: null, cadastro: "com_aprovacao" as const };

  it("o botão diz 'teste grátis' só quando o teste existe", () => {
    expect(rotuloDoCadastro(comTeste)).toBe("Começar teste grátis");
    expect(rotuloDoCadastro(semTeste)).toBe("Criar minha conta");
  });

  it("'so_convite' não oferece cadastro; 'com_aprovacao' pede acesso", () => {
    expect(rotuloDoCadastro(soConvite)).toBeNull();
    expect(rotuloDoCadastro(comAprovacao)).toBe("Solicitar acesso");
  });

  it("Hero com 'so_convite' não leva ao cadastro, leva ao painel, e não fala em teste grátis", () => {
    const html = renderToStaticMarkup(<Hero oferta={soConvite} />);
    expect(html).not.toContain('href="/signup"');
    expect(html).toContain('href="/painel"');
    expect(html).not.toMatch(/teste grátis/i);
  });

  it("Cabecalho com 'so_convite' tem só UM botão para o painel, e nenhum para /signup", () => {
    const html = renderToStaticMarkup(<Cabecalho nome="Teste" oferta={soConvite} />);
    expect(html.match(/href="\/painel"/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('href="/signup"');
  });

  it("com teste: anuncia os dias e 'sem cartão'", () => {
    const html = renderToStaticMarkup(<Hero oferta={comTeste} />);
    expect(html).toContain("7 dias de teste grátis. Sem cartão de crédito.");
  });

  it("SEM teste: não fala em teste grátis nem em cartão em lugar nenhum do hero", () => {
    const html = renderToStaticMarkup(<Hero oferta={semTeste} />);
    expect(html).not.toMatch(/teste grátis/i);
    expect(html).not.toMatch(/cartão/i);
  });

  it("o botão principal leva ao cadastro", () => {
    expect(renderToStaticMarkup(<Hero oferta={comTeste} />)).toContain('href="/signup"');
  });

  it("a pergunta 'preciso de cartão?' só existe quando há teste", () => {
    expect(renderToStaticMarkup(<Perguntas oferta={comTeste} />)).toContain("Preciso de cartão de crédito para testar?");
    expect(renderToStaticMarkup(<Perguntas oferta={semTeste} />)).not.toContain("cartão");
  });

  it("nenhum número inventado: sem porcentagem de ganho, sem 'clientes atendidos'", () => {
    // Só o TEXTO visível, sem tags: o `16%` do gradiente e o `max-w-[85%]` de uma classe são
    // CSS, não promessa.
    const html = [
      renderToStaticMarkup(<Hero oferta={comTeste} />),
      renderToStaticMarkup(<Perguntas oferta={comTeste} />),
    ]
      .join("")
      .replace(/<[^>]*>/g, " ");
    expect(html).not.toMatch(/\d+\s?%/);
    expect(html).not.toMatch(/mil clientes|milhares|\+\d+ empresas|nota \d/i);
  });
});

describe("a vitrine de planos", () => {
  it("SEM plano publicado, a seção inteira some", () => {
    expect(renderToStaticMarkup(<Planos oferta={{ planos: [], testeGratisDias: 7, cadastro: "aberto" }} />)).toBe("");
  });

  it("mostra nome, preço formatado em reais, o anual e os tetos", async () => {
    dbAtual.db = dbFalso({ platform_config: config(true), planos: { data: [planoPro] } }).db;
    // O `Intl` separa "R$" do valor com um espaço NÃO-SEPARÁVEL (U+00A0): normaliza para comparar.
    const html = renderToStaticMarkup(<Planos oferta={await lerOfertaDaLp()} />).replace(/ /g, " ");
    expect(html).toContain("Profissional");
    expect(html).toContain("R$ 197,00");
    expect(html).toContain("R$ 1.900,00 por ano");
    expect(html).toContain("Até 5 usuários");
    expect(html).toContain("Chamada de voz");
    // O preço arquivado (R$ 99) nunca aparece.
    expect(html).not.toContain("99,00");
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
