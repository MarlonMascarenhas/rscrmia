/**
 * A GUARDA DE COBRANÇA — UMA FUNÇÃO, NUNCA UM `if` POR ROTA.
 *
 * A razão está escrita em `lib/voice/guarda.ts:4-10` e vale ainda mais aqui,
 * onde há ~356 rotas: "repetição de gate é como se perde um — a sétima rota nasce
 * sem ele, ninguém percebe, e a organização que não pagou consegue trabalhar por
 * uma porta lateral". Com 356 portas não é *se*, é *quando*.
 *
 * ═══ AS PORTAS DE SAÍDA NUNCA DEPENDEM DO INTERRUPTOR ═══
 *
 * Decisão (b) de `lib/voice/guarda.ts:11-21`, e aqui ela tem um caso extremo que
 * não existe na voz: **trancar o webhook do provedor de pagamento faria o
 * pagamento não conseguir destrancar a conta que ele acabou de pagar.** É um
 * impasse que se fecha sobre si mesmo, e a única saída seria mexer no banco à
 * mão. Por isso a lista de `SEM_GATE_DE_COBRANCA` não é conveniência — é parte do
 * mecanismo.
 *
 * ═══ A ENTRADA NUNCA É TRANCADA, SÓ A SAÍDA ═══
 *
 * `/api/v1/webhooks/**` está de fora inteiro, e não só o do pagamento: barrar a
 * ingestão do WhatsApp de quem venceu faria as conversas daquele cliente serem
 * **perdidas para sempre**, e ele voltaria a pagar para encontrar um buraco no
 * histórico. Bloqueie enviar, responder, campanha e IA; nunca receber. É também o
 * invariante 1 do Sistema Vivo: nada morre por falta de resposta.
 */
import type { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { PORTA_DA_CAPACIDADE, planoLibera, type CapacidadeDePlano } from "@/lib/planos/capacidades";
import { lerEstadoDeCobranca, type EstadoDeCobranca } from "@/lib/planos/estado";
import { estadoDeCobrancaDoPedido, usoDoPedido } from "@/lib/planos/pedido";
import { decidirLimite, FORMA_DO_LIMITE, type LimiteDePlano, type ModoDeLimite } from "@/lib/planos/limites";

/**
 * As portas que a cobrança NUNCA tranca, por PREFIXO de caminho.
 *
 * Cada linha tem razão escrita porque cada uma é uma decisão, não um descuido — e
 * porque `tests/unit/planos-portas-de-saida.test.ts` lê esta lista e prova que
 * elas passam com a conta vencida. Acrescentar aqui sem razão reprova na revisão.
 */
export const SEM_GATE_DE_COBRANCA: ReadonlyArray<{ prefixo: string; porque: string }> = [
  // ── O impasse que se fecha sobre si mesmo ──
  {
    prefixo: "/api/v1/webhooks/",
    porque:
      "Trancar o webhook do provedor faria o pagamento não conseguir destrancar a conta que acabou de pagar. E barrar a ingestão do WhatsApp perderia mensagem para sempre.",
  },
  {
    prefixo: "/api/v1/cron/",
    porque: "É o mecanismo que avisa, expira e reconcilia. Trancá-lo congela o estado.",
  },
  // ── A porta de saída literal ──
  {
    prefixo: "/api/v1/cobranca/",
    porque: "Ver o plano, ver a fatura, pagar e CANCELAR. O interruptor de desligar não pode exigir a coisa ligada.",
  },
  // ── Direito legal, não cortesia ──
  {
    prefixo: "/api/v1/lgpd/",
    porque: "Direito do titular não depende de o operador ter sido pago. Tem SLA próprio na doutrina.",
  },
  // ── Portas pessoais: a classe que `PORTAS_ESSENCIAIS` já reconhece ──
  {
    prefixo: "/api/v1/settings/profile",
    porque: "Porta pessoal. Trocar a própria senha não é uso do produto.",
  },
  {
    prefixo: "/api/v1/settings/security",
    porque: "Porta pessoal: MFA. Trancar aqui prenderia alguém fora da própria conta.",
  },
  {
    prefixo: "/api/v1/auth/",
    porque:
      "Sair, trocar senha e provar o segundo fator nunca dependem de estar em dia. Trancar aqui prenderia a pessoa fora da própria conta, sem sequer conseguir sair dela.",
  },
  // ── Diagnóstico e administração ──
  {
    prefixo: "/api/v1/health",
    porque:
      "Diagnóstico da instalação, já público no proxy. Quem monitora a VPS precisa saber se ela está de pé independentemente de qualquer organização ter pagado.",
  },
  {
    prefixo: "/api/v1/admin/",
    porque: "É a porta manual de quem administra a instalação — quem libera. Tem gate próprio (requirePlatformAdmin).",
  },
  {
    prefixo: "/api/v1/support/",
    porque:
      "Encerrar o acompanhamento de suporte. Trancar a saída deixaria quem administra preso dentro da organização que está diagnosticando.",
  },
  {
    prefixo: "/api/v1/tenants/provision",
    porque: "Provisionamento por sistema externo, com segredo da instalação.",
  },
  {
    prefixo: "/api/v1/system/",
    porque: "Superfície da instalação, não da organização.",
  },
];

/** O caminho está fora do gate de cobrança? */
export function foraDoGateDeCobranca(pathname: string): boolean {
  return SEM_GATE_DE_COBRANCA.some((p) => pathname.startsWith(p.prefixo));
}

type Negacao = NextResponse<ApiError> | null;

/**
 * A negação como DADO, antes de virar resposta HTTP.
 *
 * Existe porque há dois protocolos de erro no produto: as rotas devolvem
 * `fail()`, e o ramo Bearer (`lib/mcp/auth.ts`) **lança** `McpAuthError` com
 * código JSON-RPC. Sem esta função, a tabela código→frase→status viveria duas
 * vezes, e a segunda cópia envelheceria — é o defeito clássico de gate duplicado,
 * e aqui ele apareceria como o integrador recebendo uma frase que a tela não diz.
 *
 * `null` = pode seguir.
 */
export function negacaoDeAcesso(
  estado: EstadoDeCobranca,
  organizationId: string,
  t: (texto: string) => string,
): { code: "assinatura_vencida" | "assinatura_inadimplente"; status: 402; mensagem: string } | null {
  if (estado.acesso.naoMedido) {
    // Libera, e ALARMA. A escolha de lado está em `decisao.ts`; o alarme é o que
    // impede a escolha de virar um interruptor invisível.
    logger.error("cobrança: acesso liberado sem medição — verifique a leitura do estado", {
      organization_id: organizationId,
    });
    return null;
  }
  if (estado.acesso.liberado) return null;

  if (estado.acesso.motivo === "inadimplente") {
    return {
      code: "assinatura_inadimplente",
      status: 402,
      mensagem: t(
        "O último pagamento não foi concluído. Atualize a forma de pagamento para continuar.",
      ),
    };
  }
  return {
    code: "assinatura_vencida",
    status: 402,
    mensagem:
      estado.acesso.motivo === "teste_vencido"
        ? t("O período de teste terminou. Escolha um plano para continuar.")
        : t("A assinatura desta organização não está ativa. Regularize para continuar."),
  };
}

interface OptsDaGuarda {
  requestId?: string;
  idioma?: Idioma;
  /** Já resolvido pelo chamador (o layout, por exemplo) — evita reler. */
  estado?: EstadoDeCobranca;
  /**
   * Cliente injetado, SÓ para teste. Em produção fica de fora: a guarda obtém o
   * seu de forma preguiçosa e memoizada por requisição (`pedido.ts`), e é isso que
   * a mantém fora do caminho de validação de `env` no import.
   */
  db?: SupabaseClient;
}

async function estadoDe(
  organizationId: string,
  opts: { estado?: EstadoDeCobranca; db?: SupabaseClient },
): Promise<EstadoDeCobranca> {
  if (opts.estado) return opts.estado;
  if (opts.db) return lerEstadoDeCobranca(opts.db, organizationId);
  return estadoDeCobrancaDoPedido(organizationId);
}

/**
 * `null` = pode seguir. Uma `Response` = a rota devolve isso e para.
 *
 * O contrato é o de `exigirVozLigada` (`lib/voice/guarda.ts:74`), e é o que
 * permite uma linha por rota: `const negado = await exigirAcessoLiberado(...); if
 * (negado) return negado;`
 */
export async function exigirAcessoLiberado(
  organizationId: string,
  opts: OptsDaGuarda = {},
): Promise<Negacao> {
  const { requestId, idioma, estado } = opts;
  const t = (texto: string) => (idioma ? traduzir(texto, idioma) : texto);

  const e = await estadoDe(organizationId, opts);

  // O código nomeia a causa, porque a ação de quem lê é diferente em cada uma.
  const negada = negacaoDeAcesso(e, organizationId, t);
  if (!negada) return null;

  return fail(negada.code, negada.mensagem, negada.status, { requestId });
}

/**
 * A negação de capacidade como DADO — pela mesma razão de `negacaoDeAcesso`: o
 * ramo Bearer lança `McpAuthError` em vez de devolver `Response`, e a tabela
 * código→frase→status não pode existir duas vezes.
 *
 * `null` = pode seguir.
 *
 * Falha FECHADO, e com 503 quando não mediu — nunca 422. O raio aqui é uma
 * feature, não o produto, e a assimetria com o gate de acesso está argumentada no
 * cabeçalho de `lib/planos/decisao.ts`.
 */
export function negacaoDeCapacidade(
  estado: EstadoDeCobranca,
  capacidade: CapacidadeDePlano,
  t: (texto: string) => string,
):
  | { code: "plano_estado_indeterminado"; status: 503; mensagem: string }
  | { code: "plano_nao_inclui"; status: 422; mensagem: string }
  | null {
  if (estado.acesso.naoMedido) {
    // 503 e NÃO `plano_nao_inclui`: a recusa não pode AFIRMAR uma causa que
    // ninguém mediu, senão o admin sai procurando um botão de upgrade para um
    // problema de banco (`lib/voice/guarda.ts:96-107`).
    return {
      code: "plano_estado_indeterminado",
      status: 503,
      mensagem: t("Não foi possível confirmar o seu plano agora. Tente de novo em instantes."),
    };
  }
  if (
    planoLibera(capacidade, {
      cobrancaLigada: estado.cobrancaLigada,
      liberaTudo: estado.liberaTudo,
      capacidades: estado.capacidades,
    })
  ) {
    return null;
  }
  return { code: "plano_nao_inclui", status: 422, mensagem: t(PORTA_DA_CAPACIDADE[capacidade].frase) };
}

/** A capacidade está no plano? `null` = segue; `Response` = a rota devolve e para. */
export async function exigirCapacidade(
  organizationId: string,
  capacidade: CapacidadeDePlano,
  opts: OptsDaGuarda = {},
): Promise<Negacao> {
  const { requestId, idioma } = opts;
  const t = (texto: string) => (idioma ? traduzir(texto, idioma) : texto);

  const e = await estadoDe(organizationId, opts);
  const negada = negacaoDeCapacidade(e, capacidade, t);
  if (!negada) return null;

  return fail(negada.code, negada.mensagem, negada.status, {
    requestId,
    ...(negada.code === "plano_nao_inclui" ? { details: { capacidade } } : {}),
  });
}

/**
 * Há folga no teto?
 *
 * O uso é medido AQUI, na régua declarada em `FORMA_DO_LIMITE`, e só quando há o
 * que medir: sem cobrança ligada, sem teto no plano ou com o modo em `off`, nenhuma
 * consulta é feita — o caminho comum de quem não vende continua custando zero.
 *
 * `opts.uso` existe para quem JÁ tem a contagem (ou para teste). Passe `null`
 * quando a medição não voltou — **nunca `0`**, que diria "medi, e é zero" e faria o
 * teto nunca disparar.
 *
 * O modo vem da INSTALAÇÃO (`LIMITES_MODO`, que nasce `avisar`): ninguém é bloqueado
 * sem antes ter sido avisado — o argumento de `lib/planos/limites.ts`.
 */
export async function exigirFolgaNoLimite(
  organizationId: string,
  limite: LimiteDePlano,
  opts: OptsDaGuarda & { modo?: ModoDeLimite; uso?: number | null } = {},
): Promise<Negacao> {
  const { requestId, idioma } = opts;
  const t = (texto: string) => (idioma ? traduzir(texto, idioma) : texto);

  const e = await estadoDe(organizationId, opts);
  const teto = e.liberaTudo ? null : (e.limites[limite] ?? null);
  const modo = opts.modo ?? e.modoDeLimite;

  const precisaMedir = e.cobrancaLigada && teto !== null && modo !== "off";
  const uso =
    opts.uso !== undefined ? opts.uso : precisaMedir ? await usoDoPedido(organizationId, limite) : null;

  const veredito = decidirLimite({ cobrancaLigada: e.cobrancaLigada, modo, teto, uso });

  if (veredito.acao !== "bloquear") {
    if (veredito.acao === "avisar_e_seguir") {
      logger.warn("cobrança: teto do plano atingido, seguindo por estar em modo avisar", {
        organization_id: organizationId,
        limite,
        teto: veredito.teto,
        uso,
      });
    }
    return null;
  }

  const forma = FORMA_DO_LIMITE[limite];
  return fail(
    "plano_limite_atingido",
    t(`O plano atual permite ${veredito.teto} ${forma.unidade}. Remova um ou troque de plano.`),
    409,
    { requestId, details: { limite, teto: veredito.teto } },
  );
}
