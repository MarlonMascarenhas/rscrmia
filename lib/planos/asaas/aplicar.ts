/**
 * APLICAR UM EVENTO DO ASAAS AO BANCO — A PARTE COM I/O.
 *
 * A decisão de O QUE fazer é `webhook.ts` (evento → efeito) e `cobranca/maquina.ts`
 * (efeito → transição de estado), os dois puros e testados contra os desvios do
 * provedor. Aqui só se resolve DE QUEM é o pagamento e se grava o resultado.
 *
 * ═══ A ORGANIZAÇÃO SAI DE DADO NOSSO, NUNCA DO PAYLOAD ═══
 *
 * A ordem de resolução (ver `resolverOrganizacao`) é: uma organização forçada por
 * quem chama (ligação manual); o token opaco nosso (`externalReference` →
 * `cobranca_checkouts.session_id`); o id da assinatura Asaas já vinculado à
 * organização; o id da assinatura gravado no checkout; e, por último, a consulta
 * `GET /subscriptions/{id}` para ler o `externalReference` — que cobre a janela em
 * que o webhook de uma assinatura recém-criada chega antes de o checkout guardar o
 * id dela. Nada do payload (valor, e-mail, nome) resolve organização: evento que
 * não se resolve NÃO é adivinhado — recebe `sem_organizacao`, fica registrado, e
 * aparece para quem administra ligar à mão.
 *
 * ═══ A CONTA DO ASAAS PODE TER OUTRAS COBRANÇAS ═══
 *
 * O webhook recebe os eventos da conta inteira. Cobrança sem assinatura nem token, ou
 * assinatura cujo `externalReference` não é um token nosso (`dc_...`), não é deste
 * produto: é ignorada, em vez de empilhar `sem_organizacao` na tela do operador.
 *
 * ═══ TROCA DE PLANO: A ASSINATURA VIGENTE NÃO É ADIVINHADA ═══
 *
 * Uma organização com assinatura vigente `C` pode receber um evento de OUTRA
 * assinatura `S`. Falha/cancelamento/estorno de `S` quando o vigente é `C` nunca
 * toca `C`. Só um `pago` de um checkout nosso ainda não pago é reconhecido como
 * TROCA (compra nova); qualquer outro `pago` de `S≠C` estende o período sem trocar
 * o id, e o detalhe registra o que aconteceu. Ao trocar, a assinatura antiga é
 * removida NO ASAAS como melhor esforço — nunca bloqueia o efeito local.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { chamarAsaas, removerAssinaturaNoAsaas, type CredenciaisDoAsaas } from "@/lib/planos/asaas/cliente";
import {
  planejarEventoDoAsaas,
  proximoVencimento,
  type EventoDoAsaas,
} from "@/lib/planos/asaas/webhook";
import {
  fimDoAcessoPago,
  proximaAssinatura,
  type AssinaturaAtual,
  type EfeitoNaAssinatura,
} from "@/lib/planos/cobranca/maquina";
import type { SituacaoDeAssinatura } from "@/lib/planos/decisao";

export type ViaDeResolucao =
  | "organizacaoForcada"
  | "token"
  | "assinatura"
  | "checkout_por_assinatura"
  | "assinatura_consultada";

export interface ResultadoDoEventoDoAsaas {
  /** Vocabulário fechado: vai para `cobranca_eventos_asaas.resultado`. */
  resultado:
    | "aplicado"
    | "fatura_registrada"
    | "ignorado_tipo"
    | "sem_organizacao"
    | "ignorado_assinatura_antiga"
    | "ignorado_sem_periodo"
    | "sem_efeito"
    | "sem_assinatura"
    | "fora_de_ordem";
  organizationId: string | null;
  via: ViaDeResolucao | null;
  detalhe?: string;
}

interface LinhaDeCheckout {
  session_id: string;
  organization_id: string;
  plano_id: string | null;
  preco_id: string | null;
  pago_em: string | null;
  asaas_assinatura_id: string | null;
}

interface LinhaDeAssinaturaAtual {
  situacao: SituacaoDeAssinatura;
  liberado_ate: string | null;
  carencia_ate: string | null;
  cancelada_em: string | null;
  ultimo_evento_em: string | null;
  asaas_assinatura_id: string | null;
  asaas_cliente_id: string | null;
  asaas_fatura_url: string | null;
  plano_id: string | null;
  preco_id: string | null;
}

const data = (v: string | null): Date | null => (v ? new Date(v) : null);

/** O prefixo dos tokens que `sessoes.ts` gera: o que distingue uma assinatura NOSSA de outra da mesma conta. */
const PREFIXO_DO_TOKEN = "dc_";

const COLUNAS_CHECKOUT = "session_id, organization_id, plano_id, preco_id, pago_em, asaas_assinatura_id";
const COLUNAS_ASSINATURA_ATUAL =
  "situacao, liberado_ate, carencia_ate, cancelada_em, ultimo_evento_em, asaas_assinatura_id, asaas_cliente_id, asaas_fatura_url, plano_id, preco_id";

interface ResolucaoDeOrganizacao {
  organizationId: string | null;
  via: ViaDeResolucao | null;
  checkout: LinhaDeCheckout | null;
  /** A assinatura existe no Asaas mas não é nossa (sem token `dc_`). */
  deTerceiro: boolean;
}

const SEM_RESOLUCAO: ResolucaoDeOrganizacao = { organizationId: null, via: null, checkout: null, deTerceiro: false };

async function checkoutPorToken(db: SupabaseClient, token: string): Promise<LinhaDeCheckout | null> {
  const { data: linha, error } = await db
    .from("cobranca_checkouts")
    .select(COLUNAS_CHECKOUT)
    .eq("provedor", "asaas")
    .eq("session_id", token)
    .maybeSingle();
  if (error) throw new Error(`cobranca_checkouts(session_id): ${error.message}`);
  return (linha as unknown as LinhaDeCheckout | null) ?? null;
}

/** A ordem de resolução. Cada degrau anota como resolveu (`via`). */
async function resolverOrganizacao(
  db: SupabaseClient,
  e: EventoDoAsaas,
  cred: CredenciaisDoAsaas,
  organizacaoForcada?: string,
): Promise<ResolucaoDeOrganizacao> {
  if (organizacaoForcada) {
    return { organizationId: organizacaoForcada, via: "organizacaoForcada", checkout: null, deTerceiro: false };
  }

  if (e.referenciaExterna) {
    const checkout = await checkoutPorToken(db, e.referenciaExterna);
    if (checkout) return { organizationId: checkout.organization_id, via: "token", checkout, deTerceiro: false };
  }

  if (e.assinaturaId) {
    const { data: porAssinatura, error: erroAssinatura } = await db
      .from("assinaturas")
      .select("organization_id")
      .eq("asaas_assinatura_id", e.assinaturaId)
      .maybeSingle();
    if (erroAssinatura) throw new Error(`assinaturas(asaas_assinatura_id): ${erroAssinatura.message}`);
    if (porAssinatura) {
      return {
        organizationId: (porAssinatura as { organization_id: string }).organization_id,
        via: "assinatura",
        checkout: null,
        deTerceiro: false,
      };
    }

    const { data: porCheckout, error: erroCheckout } = await db
      .from("cobranca_checkouts")
      .select(COLUNAS_CHECKOUT)
      .eq("provedor", "asaas")
      .eq("asaas_assinatura_id", e.assinaturaId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (erroCheckout) throw new Error(`cobranca_checkouts(asaas_assinatura_id): ${erroCheckout.message}`);
    if (porCheckout) {
      const checkout = porCheckout as unknown as LinhaDeCheckout;
      return { organizationId: checkout.organization_id, via: "checkout_por_assinatura", checkout, deTerceiro: false };
    }

    // O webhook pode chegar antes de `criarCheckoutNoAsaas` gravar o id da assinatura
    // no checkout. O `externalReference` da assinatura é o token do checkout.
    const consulta = await chamarAsaas<{ externalReference?: unknown }>(
      cred,
      "GET",
      `/subscriptions/${encodeURIComponent(e.assinaturaId)}`,
      undefined,
      { timeoutMs: 4000 },
    );
    if (consulta.ok) {
      const token = typeof consulta.dados.externalReference === "string" ? consulta.dados.externalReference : null;
      if (!token || !token.startsWith(PREFIXO_DO_TOKEN)) return { ...SEM_RESOLUCAO, deTerceiro: true };
      const checkout = await checkoutPorToken(db, token);
      if (checkout) {
        return { organizationId: checkout.organization_id, via: "assinatura_consultada", checkout, deTerceiro: false };
      }
    }
  }

  return SEM_RESOLUCAO;
}

interface PlanoEPrecoResolvido {
  planoId: string | null;
  precoId: string | null;
  valorCents: number | null;
  moeda: string | null;
  intervalo: "mensal" | "anual" | null;
}

/** Preço e plano pelo checkout que NÓS criamos; sem checkout, nada a resolver. */
async function resolverPlanoEPreco(db: SupabaseClient, checkout: LinhaDeCheckout | null): Promise<PlanoEPrecoResolvido> {
  const vazio: PlanoEPrecoResolvido = { planoId: checkout?.plano_id ?? null, precoId: null, valorCents: null, moeda: null, intervalo: null };
  const precoId = checkout?.preco_id ?? null;
  if (!precoId) return vazio;

  const { data: linha, error } = await db
    .from("plano_precos")
    .select("plano_id, valor_cents, moeda, intervalo")
    .eq("id", precoId)
    .maybeSingle();
  if (error) throw new Error(`plano_precos(id): ${error.message}`);
  if (!linha) return vazio;
  const l = linha as { plano_id: string; valor_cents: number; moeda: string; intervalo: string };
  return {
    planoId: l.plano_id,
    precoId,
    valorCents: Number(l.valor_cents),
    moeda: l.moeda,
    intervalo: l.intervalo === "mensal" || l.intervalo === "anual" ? l.intervalo : null,
  };
}

/** O intervalo do preço JÁ vinculado à assinatura — renovação simples, sem troca de plano. */
async function resolverIntervalo(db: SupabaseClient, precoId: string | null): Promise<"mensal" | "anual" | null> {
  if (!precoId) return null;
  const { data: linha, error } = await db.from("plano_precos").select("intervalo").eq("id", precoId).maybeSingle();
  if (error) throw new Error(`plano_precos(intervalo): ${error.message}`);
  const intervalo = (linha as { intervalo?: string } | null)?.intervalo;
  return intervalo === "mensal" || intervalo === "anual" ? intervalo : null;
}

/** `PAYMENT_CREATED`: guarda o link e o vencimento da fatura em aberto, se a organização já tem assinatura. */
async function registrarFatura(
  db: SupabaseClient,
  e: EventoDoAsaas,
  organizationId: string,
  via: ViaDeResolucao | null,
  checkout: LinhaDeCheckout | null,
): Promise<ResultadoDoEventoDoAsaas> {
  if (checkout && e.pagamentoId) {
    const { error } = await db
      .from("cobranca_checkouts")
      .update({ asaas_pagamento_id: e.pagamentoId, ...(checkout.asaas_assinatura_id ? {} : { asaas_assinatura_id: e.assinaturaId }) })
      .eq("session_id", checkout.session_id);
    if (error) throw new Error(`cobranca_checkouts(fatura): ${error.message}`);
  }

  if (!e.faturaUrl) return { resultado: "sem_efeito", organizationId, via, detalhe: "sem_link_de_fatura" };

  const { data: linha, error: erroLeitura } = await db
    .from("assinaturas")
    .select("asaas_assinatura_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroLeitura) throw new Error(`assinaturas(fatura): ${erroLeitura.message}`);
  const vigente = linha as { asaas_assinatura_id: string | null } | null;
  // `assinaturas` só nasce com período pago: antes disso o link já foi entregue ao cliente no checkout.
  if (!vigente) return { resultado: "sem_efeito", organizationId, via, detalhe: "sem_linha_de_assinatura" };
  if (vigente.asaas_assinatura_id && e.assinaturaId && vigente.asaas_assinatura_id !== e.assinaturaId) {
    return { resultado: "sem_efeito", organizationId, via, detalhe: "fatura_de_outra_assinatura" };
  }

  const { error } = await db
    .from("assinaturas")
    .update({ asaas_fatura_url: e.faturaUrl, asaas_fatura_vencimento: e.vencimento })
    .eq("organization_id", organizationId);
  if (error) throw new Error(`assinaturas(fatura): ${error.message}`);
  return { resultado: "fatura_registrada", organizationId, via };
}

export async function processarEventoDoAsaas(
  db: SupabaseClient,
  e: EventoDoAsaas,
  opts: {
    agora: Date;
    eventoCriadoEm: Date;
    carenciaDias: number;
    cred: CredenciaisDoAsaas;
    /** Ligação manual (reconciliação em /admin) — nunca vem do payload. */
    organizacaoForcada?: string;
  },
): Promise<ResultadoDoEventoDoAsaas> {
  const plano = planejarEventoDoAsaas(e);
  if (plano.acao === "ignorar") {
    return { resultado: "ignorado_tipo", organizationId: null, via: null, detalhe: plano.motivo };
  }
  // Cobrança avulsa da conta, que não é assinatura nem nasceu de um checkout nosso.
  if (!e.assinaturaId && !e.referenciaExterna && !opts.organizacaoForcada) {
    return { resultado: "ignorado_tipo", organizationId: null, via: null, detalhe: "sem_assinatura_nem_referencia" };
  }

  const resolucao = await resolverOrganizacao(db, e, opts.cred, opts.organizacaoForcada);
  if (resolucao.deTerceiro) {
    return { resultado: "ignorado_tipo", organizationId: null, via: null, detalhe: "assinatura_de_terceiro" };
  }
  if (!resolucao.organizationId) {
    return { resultado: "sem_organizacao", organizationId: null, via: null };
  }
  const { organizationId, via, checkout } = resolucao;

  if (plano.acao === "fatura") {
    return registrarFatura(db, e, organizationId, via, checkout);
  }

  // ── plano.acao === "efeito" — lê a linha ATUAL pela organização, sempre ────
  const { data: linhaAtual, error: erroAtual } = await db
    .from("assinaturas")
    .select(COLUNAS_ASSINATURA_ATUAL)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroAtual) throw new Error(`assinaturas(organization_id): ${erroAtual.message}`);
  const atualLinha = linhaAtual as LinhaDeAssinaturaAtual | null;

  let detalhe: string | undefined;
  let houveTroca = false;
  let assinaturaAntigaParaRemover: string | null = null;
  let asaasAssinaturaIdFinal: string | null = atualLinha?.asaas_assinatura_id ?? null;

  // ── guarda de assinatura antiga: evento de OUTRA assinatura não é adivinhado ─
  if (atualLinha?.asaas_assinatura_id && e.assinaturaId && atualLinha.asaas_assinatura_id !== e.assinaturaId) {
    const antiga = atualLinha.asaas_assinatura_id;
    if (plano.efeito.tipo !== "pago") {
      return {
        resultado: "ignorado_assinatura_antiga",
        organizationId,
        via,
        detalhe: `evento de ${e.assinaturaId}, vigente é ${antiga}`,
      };
    }
    // Só uma compra nova, de um checkout nosso ainda sem pagamento, é TROCA.
    const compraNova = checkout !== null && checkout.pago_em === null;
    if (compraNova) {
      houveTroca = true;
      asaasAssinaturaIdFinal = e.assinaturaId;
      if (atualLinha.situacao !== "cancelada") assinaturaAntigaParaRemover = antiga;
    } else {
      detalhe = "assinatura_antiga_cobrou";
    }
  }

  if (asaasAssinaturaIdFinal === null && e.assinaturaId) asaasAssinaturaIdFinal = e.assinaturaId;
  const asaasClienteIdFinal = e.clienteId ?? atualLinha?.asaas_cliente_id ?? null;

  // ── plano/preço/valor: só na primeira vez ou na troca; do contrário a linha já carrega ─
  let planoId: string | null;
  let precoId: string | null;
  let valorCents: number | null = null;
  let moeda: string | null = null;
  let efeito: EfeitoNaAssinatura;
  /** Colunas da fatura em aberto que ESTE evento muda; ausente = não mexe. */
  const faturaPatch: Record<string, unknown> = {};

  if (plano.efeito.tipo === "pago") {
    let intervalo: "mensal" | "anual" | null;
    if (!atualLinha || houveTroca) {
      const resolvido = await resolverPlanoEPreco(db, checkout);
      planoId = resolvido.planoId;
      precoId = resolvido.precoId;
      valorCents = resolvido.valorCents;
      moeda = resolvido.moeda;
      intervalo = resolvido.intervalo;
    } else {
      planoId = atualLinha.plano_id;
      precoId = atualLinha.preco_id;
      intervalo = await resolverIntervalo(db, precoId);
    }
    const periodoAte = fimDoAcessoPago({
      proximaCobranca: e.vencimento && intervalo ? proximoVencimento(e.vencimento, intervalo) : null,
      intervalo,
      agora: opts.agora,
    });
    if (periodoAte === null) {
      return { resultado: "ignorado_sem_periodo", organizationId, via, detalhe };
    }
    efeito = { tipo: "pago", periodoAte };
    // A fatura paga deixa de estar em aberto — mas só se era ELA a guardada: a da próxima
    // cobrança pode já ter sido registrada por um `PAYMENT_CREATED` anterior a este.
    if (atualLinha?.asaas_fatura_url && e.faturaUrl && atualLinha.asaas_fatura_url === e.faturaUrl) {
      faturaPatch.asaas_fatura_url = null;
      faturaPatch.asaas_fatura_vencimento = null;
    }
  } else {
    planoId = atualLinha?.plano_id ?? null;
    precoId = atualLinha?.preco_id ?? null;
    efeito = { tipo: plano.efeito.tipo };
    if (plano.efeito.tipo === "falhou") {
      if (e.faturaUrl) {
        faturaPatch.asaas_fatura_url = e.faturaUrl;
        faturaPatch.asaas_fatura_vencimento = e.vencimento;
      }
    } else {
      // Assinatura removida ou dinheiro devolvido: as cobranças pendentes deixam de existir.
      faturaPatch.asaas_fatura_url = null;
      faturaPatch.asaas_fatura_vencimento = null;
    }
  }

  const atual: AssinaturaAtual | null = atualLinha
    ? {
        situacao: atualLinha.situacao,
        liberadoAte: data(atualLinha.liberado_ate),
        carenciaAte: data(atualLinha.carencia_ate),
        canceladaEm: data(atualLinha.cancelada_em),
        ultimoEventoEm: data(atualLinha.ultimo_evento_em),
      }
    : null;

  const t = proximaAssinatura({
    atual,
    efeito,
    eventoCriadoEm: opts.eventoCriadoEm,
    agora: opts.agora,
    carenciaDias: opts.carenciaDias,
  });

  if (!t.aplicar) {
    const mapa = {
      fora_de_ordem: "fora_de_ordem",
      sem_efeito: "sem_efeito",
      sem_periodo: "ignorado_sem_periodo",
      sem_assinatura: "sem_assinatura",
    } as const;
    return { resultado: mapa[t.motivo], organizationId, via, detalhe };
  }

  const { error: erroUpsert } = await db.from("assinaturas").upsert(
    {
      organization_id: organizationId,
      plano_id: planoId,
      preco_id: precoId,
      situacao: t.valores.situacao,
      liberado_ate: t.valores.liberadoAte?.toISOString() ?? null,
      carencia_ate: t.valores.carenciaAte?.toISOString() ?? null,
      cancelada_em: t.valores.canceladaEm?.toISOString() ?? null,
      ultimo_evento_em: t.valores.ultimoEventoEm.toISOString(),
      asaas_assinatura_id: asaasAssinaturaIdFinal,
      asaas_cliente_id: asaasClienteIdFinal,
      // A liberação é do PROVEDOR, não de uma pessoa: sem autor e sem motivo de
      // porta manual — é assim que a tela distingue as duas origens.
      liberado_por: null,
      motivo: null,
      ...(valorCents !== null ? { valor_cents: valorCents, moeda } : {}),
      ...faturaPatch,
    },
    { onConflict: "organization_id" },
  );
  if (erroUpsert) throw new Error(`assinaturas(upsert): ${erroUpsert.message}`);

  // ── pago de um checkout nosso: ele guarda que pagou ────────────────────────
  if (plano.efeito.tipo === "pago" && checkout) {
    const { error: erroCheckout } = await db
      .from("cobranca_checkouts")
      .update({
        ...(checkout.pago_em === null ? { pago_em: opts.agora.toISOString() } : {}),
        asaas_pagamento_id: e.pagamentoId ?? null,
        asaas_assinatura_id: e.assinaturaId ?? checkout.asaas_assinatura_id,
        asaas_cliente_id: e.clienteId ?? null,
      })
      .eq("session_id", checkout.session_id);
    if (erroCheckout) throw new Error(`cobranca_checkouts(pago_em): ${erroCheckout.message}`);
  }

  // ── troca de plano: remove a antiga NO ASAAS, melhor esforço ───────────────
  if (assinaturaAntigaParaRemover) {
    const remocao = await removerAssinaturaNoAsaas(opts.cred, assinaturaAntigaParaRemover, { timeoutMs: 4000 });
    const resumo = `assinatura_antiga_cancelamento:${remocao.ok ? "ok" : "falhou"}`;
    detalhe = detalhe ? `${detalhe}; ${resumo}` : resumo;
    if (remocao.ok) {
      void audit({
        action: "assinatura.assinatura_antiga_cancelada",
        actorUserId: null,
        organizationId,
        resourceType: "assinatura",
        resourceId: organizationId,
        metadata: { assinatura_antiga: assinaturaAntigaParaRemover, assinatura_nova: asaasAssinaturaIdFinal },
      });
    }
  }

  return { resultado: "aplicado", organizationId, via, detalhe };
}
