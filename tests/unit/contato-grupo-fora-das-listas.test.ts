import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

/**
 * CERCA: contato de GRUPO do WhatsApp fora das listas.
 *
 * `contacts.is_group` (migration 0394) marca uma linha que representa um GRUPO,
 * nunca uma pessoa. O banco já trava lead e fusão (`fn_contato_grupo_nao_vira_lead`,
 * `fn_contato_grupo_nao_mescla`); este teste é a cerca do resto: nenhuma consulta
 * de listagem/busca/audiência/limite/agenda/fila/tag alcança `contacts` sem
 * filtrar (ou identificar por id/identidade/escrita, ou estar numa exceção com
 * motivo escrito) grupo do WhatsApp.
 *
 * ═══ COMO A VARREDURA LÊ O CÓDIGO ═══
 *
 * Para cada `.from("contacts")` encontrado em `app|lib|workers|hooks|components`
 * (fora de `*.test.*`), o trecho até o próximo `;` é classificado como ACEITO
 * quando tem filtro por id, escrita, chave de identidade ou `"is_group"` — e
 * como exceção declarada, ou reprovado.
 *
 * ═══ COMENTÁRIOS SÃO REMOVIDOS ANTES DE VARRER (e a ORDEM importa) ═══
 *
 * Sem isto, `hooks/notifications/useInboundMessageAlerts.ts` reprovava por um
 * `.from("contacts")` que só existe dentro de um JSDoc, narrando código
 * HISTÓRICO que já foi removido ("Este bloco JÁ FOI um `createClient().from(
 * "contacts")...`" — não é chamada real.
 *
 * A remoção não é "tirar `//` até o fim da linha" em qualquer lugar: isso
 * cortaria `//` dentro de string (`"https://..."`) em código real. A régua
 * aqui só apaga a linha INTEIRA quando a parte não-espaço dela COMEÇA com
 * `//` — comentário de bloco (JSDoc incluso) é removido por região.
 *
 * A ORDEM das duas passadas é o detalhe que não é óbvio: remover comentário de
 * BLOCO primeiro, antes do de linha, incendeia texto real. Um comentário de
 * linha deste próprio arquivo (`app/api/v1/contacts/_handler.ts`, doc da L-06)
 * tem o texto `**from/to**` — que CONTÉM a sequência asterisco-barra como
 * texto solto, sem ser abertura de bloco nenhuma. Uma passada de bloco
 * ingênua, rodando ANTES da de linha, acha essa abertura "de mentira" e a
 * casa (non-greedy) com o fechamento de bloco mais próximo do arquivo —
 * 130+ linhas adiante —, apagando todo o corpo
 * de `patchContactHandler` no meio do caminho: a chamada real
 * `.eq("id", contactId)` sumia, e a linha virava um falso reprovado. Rodar a
 * passada de LINHA primeiro apaga esse comentário (e o `/*` de mentira junto)
 * antes de a passada de bloco sequer rodar — medido: sem a troca de ordem,
 * `app/api/v1/contacts/_handler.ts` reprovava; com ela, não.
 *
 * O que esta heurística NÃO cobre (aceito, documentado): comentário de bloco
 * (`/* ... *\/`) dentro de uma STRING de código real seria mal-interpretado —
 * não há caso disso hoje em `.from("contacts")`; comentário de LINHA que não
 * ocupa a linha inteira (`codigo(); // nota`) não é removido — só entra na
 * conta se citar `.from("contacts")` num trecho que o teste de fato varre, o
 * que não acontece em nenhum arquivo medido.
 */

const RAIZES = ["app", "lib", "workers", "hooks", "components"] as const;

function removerComentarios(texto: string): string {
  // 1) Linha inteira de comentário — só quando a parte não-espaço da linha
  //    COMEÇA com `//`. Nunca corta `//` no meio de uma linha de código real
  //    (ex.: uma URL dentro de string), e roda ANTES da passada de bloco (ver
  //    cabeçalho — a ordem inversa incendeia código real).
  const semLinha = texto
    .split("\n")
    .map((linha) => (/^\s*\/\//.test(linha) ? "" : linha))
    .join("\n");
  // 2) Bloco (inclusive JSDoc): substitui o conteúdo por espaços, preservando
  //    as quebras de linha — número de linha do que sobra continua correto.
  return semLinha.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Métodos que já identificam a linha por id, identidade ou a escrevem. */
const ACEITA: readonly RegExp[] = [
  /\.(eq|in)\("id"/,
  /\.(insert|update|delete|upsert)\(/,
  /\.(eq|in)\("(phone_number|email_normalized|social_identity|wa_lid|wa_identity)"/,
  /\.eq\("source_metadata->>/,
  /\.not\("(wa_identity|phone_number)", "is", null\)/,
  /"is_group"/,
];

interface Ocorrencia {
  arquivo: string;
  linha: number;
  trecho: string;
  aceita: boolean;
}

function ocorrenciasDoArquivo(absoluto: string): Ocorrencia[] {
  const original = readFileSync(absoluto, "utf8");
  const semComentario = removerComentarios(original);
  const arquivo = caminhoRelativo(absoluto);
  const achados: Ocorrencia[] = [];
  const re = /\.from\(["']contacts["']\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(semComentario)) !== null) {
    const inicio = m.index;
    const fim = semComentario.indexOf(";", inicio);
    const trecho = fim === -1 ? semComentario.slice(inicio) : semComentario.slice(inicio, fim + 1);
    const linha = semComentario.slice(0, inicio).split("\n").length;
    achados.push({ arquivo, linha, trecho, aceita: ACEITA.some((r) => r.test(trecho)) });
  }
  return achados;
}

/**
 * Exceções — só encolhe. Cada entrada diz por que uma consulta a `contacts`
 * não filtra `is_group` nem identifica por id/identidade/escrita.
 */
const EXCECOES: readonly { arquivo: string; motivo: string }[] = [
  {
    arquivo: "app/api/v1/conversations/_handler.ts",
    motivo: "Busca da inbox: um grupo do WhatsApp precisa ser encontrável ali — é a única tela que mostra a conversa dele.",
  },
  {
    arquivo: "app/api/v1/webhooks/nuvemshop/store-redact/route.ts",
    motivo: "Contagem para auditoria da desinstalação da loja, não listagem de pessoa.",
  },
  {
    arquivo: "lib/lgpd/cascata.ts",
    motivo: "Varredura de contatos já anonimizados (cascata de redact), não listagem de contato vivo.",
  },
  {
    arquivo: "workers/lgpd-redact-worker.ts",
    motivo:
      "Varredura de anonimização do tenant inteiro (desinstalação de loja): o contato-grupo também " +
      "deve ser anonimizado, então aqui NÃO se filtra is_group.",
  },
];

/** Os 8 arquivos que este briefing filtrou — controle positivo. */
const FILTRADOS_DE_GRUPO: readonly string[] = [
  "app/api/v1/contacts/_handler.ts",
  "app/api/v1/contacts/duplicates/route.ts",
  "lib/campanhas/consulta-de-audiencia.ts",
  "lib/planos/uso.ts",
  "app/api/v1/agenda/vinculos/route.ts",
  "app/api/v1/ai/followups/queue/route.ts",
  "app/api/v1/contact-tags/route.ts",
  "lib/messaging/open-shared-contact-conversation.ts",
];

const ARQUIVOS = arquivosDeCodigo(RAIZES);
const OCORRENCIAS = ARQUIVOS.flatMap(ocorrenciasDoArquivo);

const descrever = (o: Ocorrencia): string => `${o.arquivo}:${o.linha}`;

const foraDaRegra = OCORRENCIAS.filter((o) => !o.aceita).filter(
  (o) => !EXCECOES.some((e) => e.arquivo === o.arquivo),
);

describe("contato de grupo do WhatsApp fora das listas", () => {
  it("a varredura enxerga arquivos e ocorrências (guarda de vacuidade)", () => {
    expect(ARQUIVOS.length).toBeGreaterThan(500);
    expect(OCORRENCIAS.length).toBeGreaterThan(50);
  });

  it("ignora .from(\"contacts\") dentro de comentário (controle do filtro de comentário)", () => {
    const amostra = [
      "/**",
      ' * Isto já foi um `admin.from("contacts").select("id")` antigo — código morto,',
      " * só prosa.",
      " */",
      "async function x() {",
      '  // outro comentário citando .from("contacts") também não conta',
      "  const real = await admin",
      '    .from("contacts")',
      '    .select("id")',
      '    .eq("organization_id", orgId)',
      '    .eq("is_group", false)',
      "    .maybeSingle();",
      "}",
    ].join("\n");
    const semComentario = removerComentarios(amostra);
    const achados = [...semComentario.matchAll(/\.from\(["']contacts["']\)/g)];
    // Só a chamada real sobra — as duas menções em comentário (bloco e linha) somem.
    expect(achados.length).toBe(1);
    expect(semComentario).toContain('"is_group"');
  });

  it("controle positivo: os 8 arquivos filtrados por este briefing contêm is_group", () => {
    for (const arquivo of FILTRADOS_DE_GRUPO) {
      const doArquivo = OCORRENCIAS.filter((o) => o.arquivo === arquivo);
      expect(doArquivo.length, `nenhuma ocorrência de contacts em ${arquivo} — a varredura perdeu o arquivo`).toBeGreaterThan(0);
      expect(
        doArquivo.some((o) => o.trecho.includes('"is_group"')),
        `${arquivo} não filtra is_group em nenhuma consulta a contacts`,
      ).toBe(true);
    }
  });

  it("toda consulta a contacts é aceita (id/identidade/escrita/is_group) ou está numa exceção com motivo", () => {
    expect(
      foraDaRegra.map(descrever),
      "Consulta a `contacts` sem filtro de id/identidade/escrita, sem \"is_group\" e fora das EXCECOES " +
        "declaradas: um grupo do WhatsApp pode vazar para esta lista. Filtre .eq(\"is_group\", false) ou " +
        "acrescente a EXCECOES com o motivo escrito.",
    ).toEqual([]);
  });

  it("exceção que não corresponde a nenhuma ocorrência real reprova (sem exceção órfã)", () => {
    for (const excecao of EXCECOES) {
      const achados = OCORRENCIAS.filter((o) => o.arquivo === excecao.arquivo && !o.aceita);
      expect(
        achados.length,
        `exceção órfã: \`${excecao.arquivo}\` não tem mais consulta a contacts fora da regra — remova de EXCECOES`,
      ).toBeGreaterThan(0);
      expect(excecao.motivo.trim().length, `exceção sem motivo escrito: ${excecao.arquivo}`).toBeGreaterThan(10);
    }
  });
});
