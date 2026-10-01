/**
 * APLICAR UM EVENTO DA CAKTO AO BANCO — A PARTE COM I/O.
 *
 * A decisão de O QUE fazer é `webhook.ts` (evento → efeito) e `cobranca/maquina.ts`
 * (efeito → transição de estado), os dois puros e testados contra os desvios do
 * provedor. Aqui só se resolve DE QUEM é o pagamento e se grava o resultado — o
 * mesmo desenho de `lib/planos/stripe/aplicar.ts`.
 *
 * ═══ A ORGANIZAÇÃO SAI DE DADO NOSSO, NUNCA DO PAYLOAD ═══
 *
 * A ordem de resolução (ver `resolverOrganizacao`) é: uma organização forçada por
 * quem chama (ligação manual), o `callback` do checkout que ESTE produto criou, a
 * assinatura já vinculada, o cliente com EXATAMENTE uma organização, e por fim o
 * e-mail de um admin com EXATAMENTE uma organização. Nada do payload (nome,
 * metadata) resolve organização — um evento cuja organização não se resolve NÃO é
 * adivinhado: recebe `sem_organizacao`, fica registrado, e aparece para quem
 * administra reconciliar.
 *
 * ═══ TROCA DE PLANO: A ASSINATURA VIGENTE NÃO É ADIVINHADA ═══
 *
 * Uma organização com assinatura vigente `C` pode receber um evento de OUTRA
 * assinatura `S` (o cliente comprou de novo, ou uma renovação atrasada da que foi
 * substituída). Falha/cancelamento/estorno de `S` quando o vigente é `C` nunca toca
 * `C` — são assinaturas diferentes. Só um `pago` por `callback` de um checkout
 * ainda não pago é reconhecido como TROCA (compra nova); qualquer outro `pago` de
 * `S≠C` estende o período sem trocar o id, e o detalhe registra o que aconteceu.
 * Ao trocar, a assinatura antiga é cancelada NA CAKTO como melhor esforço — nunca
 * bloqueia o efeito local.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { cancelarAssinaturaNaCakto, type CredenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import type { EventoDaCakto } from "@/lib/planos/cakto/webhook";
import { planejarEventoDaCakto } from "@/lib/planos/cakto/webhook";
import {
  fimDoAcessoPago,
  proximaAssinatura,
  type AssinaturaAtual,
  type EfeitoNaAssinatura,
} from "@/lib/planos/cobranca/maquina";
import type { SituacaoDeAssinatura } from "@/lib/planos/decisao";

export type ViaDeResolucao =
  | "organizacaoForcada"
  | "callback"
  | "assinatura"
  | "checkout_por_assinatura"
  | "cliente"
  | "email";

export interface ResultadoDoEventoDaCakto {
  /** Vocabulário fechado: vai para `cobranca_eventos_cakto.resultado`. */
  resultado:
    | "aplicado"
    | "vinculado"
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

interface LinhaDeCheckoutCakto {
  session_id: string;
  organization_id: string;
  plano_id: string | null;
  preco_id: string | null;
  pago_em: string | null;
}

interface LinhaDeAssinaturaAtualCakto {
  situacao: SituacaoDeAssinatura;
  liberado_ate: string | null;
  carencia_ate: string | null;
  cancelada_em: string | null;
  ultimo_evento_em: string | null;
  cakto_assinatura_id: string | null;
  cakto_cliente_id: string | null;
  plano_id: string | null;
  preco_id: string | null;
}

const data = (v: string | null): Date | null => (v ? new Date(v) : null);

const COLUNAS_CHECKOUT = "session_id, organization_id, plano_id, preco_id, pago_em";
const COLUNAS_ASSINATURA_ATUAL =
  "situacao, liberado_ate, carencia_ate, cancelada_em, ultimo_evento_em, cakto_assinatura_id, cakto_cliente_id, plano_id, preco_id";

interface ResolucaoDeOrganizacao {
  organizationId: string | null;
  via: ViaDeResolucao | null;
  checkout: LinhaDeCheckoutCakto | null;
}

/** A ordem de resolução. Cada degrau anota como resolveu (`via`), para a
 *  auditoria e para a guarda de assinatura antiga saberem de onde veio. */
async function resolverOrganizacao(
  db: SupabaseClient,
  e: EventoDaCakto,
  organizacaoForcada?: string,
): Promise<ResolucaoDeOrganizacao> {
  if (organizacaoForcada) {
    return { organizationId: organizacaoForcada, via: "organizacaoForcada", checkout: null };
  }

  if (e.callback) {
    const { data: linha, error } = await db
      .from("cobranca_checkouts")
      .select(COLUNAS_CHECKOUT)
      .eq("provedor", "cakto")
      .eq("session_id", e.callback)
      .maybeSingle();
    if (error) throw new Error(`cobranca_checkouts(session_id): ${error.message}`);
    if (linha) {
      const checkout = linha as unknown as LinhaDeCheckoutCakto;
      return { organizationId: checkout.organization_id, via: "callback", checkout };
    }
  }

  if (e.assinatura?.id) {
    const { data: porAssinatura, error: erroAssinatura } = await db
      .from("assinaturas")
      .select("organization_id")
      .eq("cakto_assinatura_id", e.assinatura.id)
      .maybeSingle();
    if (erroAssinatura) throw new Error(`assinaturas(cakto_assinatura_id): ${erroAssinatura.message}`);
    if (porAssinatura) {
      return {
        organizationId: (porAssinatura as { organization_id: string }).organization_id,
        via: "assinatura",
        checkout: null,
      };
    }

    const { data: porCheckout, error: erroCheckout } = await db
      .from("cobranca_checkouts")
      .select(COLUNAS_CHECKOUT)
      .eq("cakto_assinatura_id", e.assinatura.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (erroCheckout) throw new Error(`cobranca_checkouts(cakto_assinatura_id): ${erroCheckout.message}`);
    if (porCheckout) {
      const checkout = porCheckout as unknown as LinhaDeCheckoutCakto;
      return { organizationId: checkout.organization_id, via: "checkout_por_assinatura", checkout };
    }
  }

  if (e.clienteId) {
    const { data: linhas, error } = await db.from("assinaturas").select("organization_id").eq("cakto_cliente_id", e.clienteId);
    if (error) throw new Error(`assinaturas(cakto_cliente_id): ${error.message}`);
    const encontradas = (linhas as Array<{ organization_id: string }> | null) ?? [];
    if (encontradas.length === 1) {
      return { organizationId: encontradas[0]!.organization_id, via: "cliente", checkout: null };
    }
  }

  if (e.email) {
    const { data: linhas, error } = await db.rpc("fn_cobranca_orgs_do_admin_por_email", { p_email: e.email });
    if (error) throw new Error(`fn_cobranca_orgs_do_admin_por_email: ${error.message}`);
    const encontradas = (linhas as Array<{ organization_id: string }> | null) ?? [];
    if (encontradas.length === 1) {
      return { organizationId: encontradas[0]!.organization_id, via: "email", checkout: null };
    }
  }

  return { organizationId: null, via: null, checkout: null };
}

interface PlanoEPrecoResolvido {
  planoId: string | null;
  precoId: string | null;
  valorCents: number | null;
  moeda: string | null;
  intervalo: "mensal" | "anual" | null;
}

/** Preço pelo checkout, senão pela oferta; plano pelo preço, senão pelo produto. */
async function resolverPlanoEPreco(
  db: SupabaseClient,
  e: EventoDaCakto,
  checkout: LinhaDeCheckoutCakto | null,
): Promise<PlanoEPrecoResolvido> {
  let precoId: string | null = checkout?.preco_id ?? null;
  let planoId: string | null = null;
  let valorCents: number | null = null;
  let moeda: string | null = null;
  let intervalo: "mensal" | "anual" | null = null;

  if (precoId) {
    const { data: linha, error } = await db
      .from("plano_precos")
      .select("plano_id, valor_cents, moeda, intervalo")
      .eq("id", precoId)
      .maybeSingle();
    if (error) throw new Error(`plano_precos(id): ${error.message}`);
    if (linha) {
      const l = linha as { plano_id: string; valor_cents: number; moeda: string; intervalo: string };
      planoId = l.plano_id;
      valorCents = Number(l.valor_cents);
      moeda = l.moeda;
      intervalo = l.intervalo === "mensal" || l.intervalo === "anual" ? l.intervalo : null;
    }
  } else if (e.ofertaId) {
    const { data: linha, error } = await db
      .from("plano_precos")
      .select("id, plano_id, valor_cents, moeda, intervalo")
      .eq("cakto_oferta_id", e.ofertaId)
      .maybeSingle();
    if (error) throw new Error(`plano_precos(cakto_oferta_id): ${error.message}`);
    if (linha) {
      const l = linha as { id: string; plano_id: string; valor_cents: number; moeda: string; intervalo: string };
      precoId = l.id;
      planoId = l.plano_id;
      valorCents = Number(l.valor_cents);
      moeda = l.moeda;
      intervalo = l.intervalo === "mensal" || l.intervalo === "anual" ? l.intervalo : null;
    }
  }

  if (!planoId) planoId = checkout?.plano_id ?? null;
  if (!planoId && e.produtoId) {
    const { data: linha, error } = await db.from("planos").select("id").eq("cakto_produto_id", e.produtoId).maybeSingle();
    if (error) throw new Error(`planos(cakto_produto_id): ${error.message}`);
    if (linha) planoId = (linha as { id: string }).id;
  }

  return { planoId, precoId, valorCents, moeda, intervalo };
}

/** O intervalo do preço JÁ vinculado à assinatura — usado quando não há troca de
 *  plano nem preço a resolver de novo (renovação simples). */
async function resolverIntervalo(db: SupabaseClient, precoId: string | null): Promise<"mensal" | "anual" | null> {
  if (!precoId) return null;
  const { data: linha, error } = await db.from("plano_precos").select("intervalo").eq("id", precoId).maybeSingle();
  if (error) throw new Error(`plano_precos(intervalo): ${error.message}`);
  const intervalo = (linha as { intervalo?: string } | null)?.intervalo;
  return intervalo === "mensal" || intervalo === "anual" ? intervalo : null;
}

async function vincular(
  db: SupabaseClient,
  e: EventoDaCakto,
  organizationId: string,
  via: ViaDeResolucao | null,
  checkout: LinhaDeCheckoutCakto | null,
): Promise<ResultadoDoEventoDaCakto> {
  if (via === "callback" && checkout) {
    const { error } = await db
      .from("cobranca_checkouts")
      .update({
        cakto_assinatura_id: e.assinatura?.id ?? null,
        cakto_cliente_id: e.clienteId ?? null,
        cakto_pedido_id: e.pedidoId ?? null,
      })
      .eq("session_id", checkout.session_id);
    if (error) throw new Error(`cobranca_checkouts(vincular): ${error.message}`);
  }
  if (e.assinatura?.id) {
    const { error } = await db
      .from("assinaturas")
      .update({ cakto_assinatura_id: e.assinatura.id })
      .eq("organization_id", organizationId)
      .is("cakto_assinatura_id", null);
    if (error) throw new Error(`assinaturas(vincular): ${error.message}`);
  }
  return { resultado: "vinculado", organizationId, via };
}

export async function processarEventoDaCakto(
  db: SupabaseClient,
  e: EventoDaCakto,
  opts: {
    agora: Date;
    eventoCriadoEm: Date;
    carenciaDias: number;
    cred: CredenciaisDaCakto;
    /** Ligação manual (reconciliação em /admin) — nunca vem do payload. */
    organizacaoForcada?: string;
  },
): Promise<ResultadoDoEventoDaCakto> {
  const plano = planejarEventoDaCakto(e);
  if (plano.acao === "ignorar") {
    return { resultado: "ignorado_tipo", organizationId: null, via: null, detalhe: plano.motivo };
  }

  const resolucao = await resolverOrganizacao(db, e, opts.organizacaoForcada);
  if (!resolucao.organizationId) {
    return { resultado: "sem_organizacao", organizationId: null, via: null };
  }
  const { organizationId, via, checkout } = resolucao;

  if (plano.acao === "vincular") {
    return vincular(db, e, organizationId, via, checkout);
  }

  // ── plano.acao === "efeito" — lê a linha ATUAL pela organização, sempre ────
  const { data: linhaAtual, error: erroAtual } = await db
    .from("assinaturas")
    .select(COLUNAS_ASSINATURA_ATUAL)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroAtual) throw new Error(`assinaturas(organization_id): ${erroAtual.message}`);
  const atualLinha = linhaAtual as LinhaDeAssinaturaAtualCakto | null;

  let detalhe: string | undefined;
  let houveTroca = false;
  let assinaturaAntigaParaCancelar: string | null = null;
  let caktoAssinaturaIdFinal: string | null = atualLinha?.cakto_assinatura_id ?? null;

  // ── guarda de assinatura antiga: evento de OUTRA assinatura não é adivinhado ─
  if (atualLinha?.cakto_assinatura_id && e.assinatura?.id && atualLinha.cakto_assinatura_id !== e.assinatura.id) {
    const antiga = atualLinha.cakto_assinatura_id;
    if (plano.efeito.tipo !== "pago") {
      return {
        resultado: "ignorado_assinatura_antiga",
        organizationId,
        via,
        detalhe: `evento de ${e.assinatura.id}, vigente é ${antiga}`,
      };
    }
    // Só uma compra nova por callback de checkout ainda sem pagamento é TROCA.
    const compraNova = via === "callback" && checkout !== null && checkout.pago_em === null;
    if (compraNova) {
      houveTroca = true;
      caktoAssinaturaIdFinal = e.assinatura.id;
      if (atualLinha.situacao !== "cancelada") assinaturaAntigaParaCancelar = antiga;
    } else {
      detalhe = "assinatura_antiga_cobrou";
    }
  }

  if (caktoAssinaturaIdFinal === null && e.assinatura?.id) {
    caktoAssinaturaIdFinal = e.assinatura.id;
  }
  const caktoClienteIdFinal = e.clienteId ?? atualLinha?.cakto_cliente_id ?? null;

  // ── plano/preço/valor: só na primeira vez ou na troca; do contrário a linha já carrega ─
  let planoId: string | null;
  let precoId: string | null;
  let valorCents: number | null = null;
  let moeda: string | null = null;
  let efeito: EfeitoNaAssinatura;

  if (plano.efeito.tipo === "pago") {
    let intervalo: "mensal" | "anual" | null;
    if (!atualLinha || houveTroca) {
      const resolvido = await resolverPlanoEPreco(db, e, checkout);
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
      proximaCobranca: e.assinatura?.proximaCobranca ?? null,
      intervalo,
      agora: opts.agora,
    });
    if (periodoAte === null) {
      return { resultado: "ignorado_sem_periodo", organizationId, via, detalhe };
    }
    efeito = { tipo: "pago", periodoAte };
  } else {
    planoId = atualLinha?.plano_id ?? null;
    precoId = atualLinha?.preco_id ?? null;
    efeito = { tipo: plano.efeito.tipo };
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
      cakto_assinatura_id: caktoAssinaturaIdFinal,
      cakto_cliente_id: caktoClienteIdFinal,
      // A liberação é do PROVEDOR, não de uma pessoa: sem autor e sem motivo de
      // porta manual — é assim que a tela distingue as duas origens.
      liberado_por: null,
      motivo: null,
      ...(valorCents !== null ? { valor_cents: valorCents, moeda } : {}),
    },
    { onConflict: "organization_id" },
  );
  if (erroUpsert) throw new Error(`assinaturas(upsert): ${erroUpsert.message}`);

  // ── pago via callback: o checkout que criamos guarda que pagou ─────────────
  if (plano.efeito.tipo === "pago" && via === "callback" && checkout) {
    const { error: erroCheckout } = await db
      .from("cobranca_checkouts")
      .update({
        pago_em: opts.agora.toISOString(),
        cakto_pedido_id: e.pedidoId ?? null,
        cakto_assinatura_id: e.assinatura?.id ?? null,
        cakto_cliente_id: e.clienteId ?? null,
      })
      .eq("session_id", checkout.session_id);
    if (erroCheckout) throw new Error(`cobranca_checkouts(pago_em): ${erroCheckout.message}`);
  }

  // ── troca de plano: cancela a antiga NA CAKTO, melhor esforço ──────────────
  if (assinaturaAntigaParaCancelar) {
    const cancelamento = await cancelarAssinaturaNaCakto(opts.cred, assinaturaAntigaParaCancelar, { timeoutMs: 4000 });
    const resumo = `assinatura_antiga_cancelamento:${cancelamento.ok ? "ok" : "falhou"}`;
    detalhe = detalhe ? `${detalhe}; ${resumo}` : resumo;
    if (cancelamento.ok) {
      void audit({
        action: "assinatura.assinatura_antiga_cancelada",
        actorUserId: null,
        organizationId,
        resourceType: "assinatura",
        resourceId: organizationId,
        metadata: { assinatura_antiga: assinaturaAntigaParaCancelar, assinatura_nova: caktoAssinaturaIdFinal },
      });
    }
  }

  return { resultado: "aplicado", organizationId, via, detalhe };
}
