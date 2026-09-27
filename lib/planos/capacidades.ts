/**
 * AS CAPACIDADES QUE UM PLANO LIBERA — LISTA FECHADA.
 *
 * O molde é `lib/extensions/capacidades.ts`: lista `as const`, `Record`
 * EXAUSTIVO, e um tradutor único que devolve `null` fora da lista em vez de um
 * destino de reserva. Capacidade nova sem porta declarada **não compila**.
 *
 * ═══ A RÉGUA PARA ADMITIR UMA CAPACIDADE NOVA ═══
 *
 * Só entra aqui o que um cliente pode NÃO ter e seguir operando. Identidade,
 * autorização, isolamento, auditoria, a cadeia de envio e o próprio pagamento
 * são NÚCLEO e nunca viram capacidade de plano — trancar qualquer um deles
 * transforma um cliente em dado inacessível, não em cliente de plano menor.
 *
 * E a régua que importa mais, herdada de `docs/doctrine/extensoes.md:128-130`:
 * **capacidade nasce concedida a todo plano que já existe.** Só plano NOVO pode
 * nascer sem ela. Quem já usa não perde — e é por isso que
 * `planos.libera_tudo` é coluna, não a ausência de limites: sem ela, cada
 * recurso novo teria de ser acrescentado à mão a cada plano de topo, e um
 * esquecimento tiraria de um cliente pagante o que ele já tinha.
 *
 * O vocabulário é espelhado no CHECK de `plano_capacidades` (migration 0393), e
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre colunas
 * que JÁ têm CHECK — reprova divergência entre esta lista e o banco. Acrescentar
 * aqui sem a migration reprova o CI sozinho, que é o ponto.
 */

export const CAPACIDADES_DE_PLANO = [
  "campanhas",
  "voz",
  "banco_externo",
  "extensoes",
  "mcp_e_api",
  "anuncios",
  "agenda_google",
  "multiplas_conexoes",
  "relatorios_avancados",
] as const;

export type CapacidadeDePlano = (typeof CAPACIDADES_DE_PLANO)[number];

interface PortaDaCapacidade {
  /** O que quem administra a instalação lê em /admin/planos. */
  readonly rotulo: string;
  /** O que o cliente lê quando é recusado. Diz o que fazer, não o que faltou. */
  readonly frase: string;
  /**
   * Destinos do `NAV_CATALOG` que esta capacidade governa, LITERAIS — nunca
   * montados por concatenação, para que `grep` ache e o teste confira que
   * existem. Vazio é legítimo: capacidade que não tem tela própria.
   */
  readonly destinos: readonly string[];
}

/**
 * `Record` exaustivo: o TypeScript recusa capacidade sem porta, e é isso que
 * impede a lista de crescer sem alguém decidir o que ela governa.
 */
export const PORTA_DA_CAPACIDADE: Record<CapacidadeDePlano, PortaDaCapacidade> = {
  campanhas: {
    rotulo: "Campanhas de WhatsApp",
    frase: "Campanhas não estão incluídas no plano atual.",
    destinos: ["/app/campaigns"],
  },
  voz: {
    rotulo: "Chamada de voz",
    // A voz tem DOIS eixos antes deste: a instalação oferecer
    // (`WACALLS_API_BASE_URL`) e a organização consentir (`org_voice_calls`).
    // O plano é um terceiro, e nenhum dos três vence os outros — ver
    // `lib/voice/opt-in.ts:14-23`.
    frase: "Chamada de voz não está incluída no plano atual.",
    destinos: [],
  },
  banco_externo: {
    rotulo: "Banco de dados externo",
    frase: "A integração com banco de dados externo não está incluída no plano atual.",
    destinos: ["/app/integracao-dados"],
  },
  extensoes: {
    rotulo: "Extensões",
    frase: "Extensões não estão incluídas no plano atual.",
    destinos: ["/app/extensions"],
  },
  mcp_e_api: {
    rotulo: "API e MCP",
    frase: "O acesso por API não está incluído no plano atual.",
    destinos: ["/app/settings/api-tokens"],
  },
  anuncios: {
    rotulo: "Anúncios",
    frase: "A integração com plataformas de anúncio não está incluída no plano atual.",
    destinos: ["/app/ads/meta"],
  },
  agenda_google: {
    rotulo: "Agenda do Google",
    frase: "A sincronia com a Agenda do Google não está incluída no plano atual.",
    destinos: [],
  },
  multiplas_conexoes: {
    rotulo: "Mais de uma conexão de WhatsApp",
    frase: "O plano atual permite uma conexão de WhatsApp.",
    destinos: [],
  },
  relatorios_avancados: {
    rotulo: "Relatórios avançados",
    frase: "Os relatórios avançados não estão incluídos no plano atual.",
    destinos: [],
  },
};

/** Fora da lista devolve `false` — nunca uma capacidade de reserva. */
export function ehCapacidadeDePlano(valor: unknown): valor is CapacidadeDePlano {
  return (
    typeof valor === "string" &&
    (CAPACIDADES_DE_PLANO as readonly string[]).includes(valor)
  );
}

/**
 * Os destinos do menu que o PLANO esconde — função pura, para o layout entregá-los
 * à casca de navegação junto com `modulos_ligados`.
 *
 * Esconder do menu **não é gate**: a recusa de verdade mora na rota
 * (`requireRole({ capacidade })`), e isto só evita oferecer uma porta que a
 * organização não pode atravessar. `lib/navigation/interface.ts:1` já diz o mesmo
 * de toda a navegação.
 *
 * Devolve `[]` — nada escondido — em todo caso de dúvida: cobrança desligada, plano
 * que libera tudo, ou estado não medido. Esconder por engano é pior que mostrar
 * demais: a rota recusa de qualquer forma, e uma tela que some sem explicação
 * parece um defeito do produto.
 */
export function destinosOcultosPeloPlano(plano: {
  cobrancaLigada: boolean;
  liberaTudo: boolean;
  capacidades: readonly string[];
  naoMedido: boolean;
}): string[] {
  if (!plano.cobrancaLigada || plano.liberaTudo || plano.naoMedido) return [];
  return CAPACIDADES_DE_PLANO.filter((c) => !plano.capacidades.includes(c)).flatMap(
    (c) => PORTA_DA_CAPACIDADE[c].destinos,
  );
}

/**
 * A decisão de capacidade, PURA.
 *
 * `cobrancaLigada === false` libera tudo, e é o primeiro degrau: numa instalação
 * que não vende, nenhuma feature fica atrás de pagamento — a propriedade que faz
 * a doutrina de extensões seguir verdadeira em código.
 *
 * `liberaTudo` libera inclusive capacidade que NASCER DEPOIS deste plano ter
 * sido criado. É o que o dono pediu ("o plano que libera tudo") e o que impede
 * um recurso novo de escapar do plano de topo por esquecimento.
 */
export function planoLibera(
  capacidade: CapacidadeDePlano,
  plano: {
    cobrancaLigada: boolean;
    liberaTudo: boolean;
    /** O que a organização tem hoje. Strings cruas: o banco é vocabulário aberto. */
    capacidades: readonly string[];
  },
): boolean {
  if (!plano.cobrancaLigada) return true;
  if (plano.liberaTudo) return true;
  return plano.capacidades.includes(capacidade);
}
