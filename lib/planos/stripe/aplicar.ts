/**
 * APLICAR UM EVENTO DO STRIPE AO BANCO — A PARTE COM I/O.
 *
 * A decisão de O QUE fazer é `webhook.ts`, puro e testado contra os desvios do
 * provedor. Aqui só se resolve DE QUEM é o pagamento e se grava o resultado.
 *
 * ═══ A ORGANIZAÇÃO SAI DE DADO NOSSO, NUNCA DO PAYLOAD ═══
 *
 * O CLAUDE.md manda que a organização venha de fonte confiável e nunca do corpo. A
 * ordem de resolução é: a assinatura já vinculada (`stripe_subscription_id`, depois
 * `stripe_customer_id`) e, para a primeira vez, `cobranca_checkouts` — a sessão que
 * ESTE produto criou, com a organização de quem pediu. `metadata.organization_id`
 * do payload é conveniência de quem depura no painel do Stripe e não é lido aqui.
 *
 * Um evento cuja organização não se resolve NÃO é adivinhado: recebe o resultado
 * `sem_organizacao`, fica registrado, e aparece para quem administra reconciliar.
 * Adivinhar a organização de um pagamento é o defeito mais perigoso deste eixo — o
 * único em que um terceiro poderia escolher qual tenant recebe o acesso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import {
  planejarEfeito,
  proximaAssinatura,
  type AssinaturaAtual,
  type Efeito,
  type EventoDoStripe,
} from "@/lib/planos/stripe/webhook";

export interface ResultadoDoEvento {
  /** Vocabulário fechado: vai para `cobranca_eventos.resultado`. */
  resultado:
    | "aplicado"
    | "vinculado"
    | "sem_organizacao"
    | "ignorado_fora_de_ordem"
    | "ignorado_sem_efeito"
    | "ignorado_sem_periodo"
    | "ignorado_sem_assinatura"
    | "ignorado_tipo"
    | "erro";
  organizationId: string | null;
  detalhe?: string;
}

interface LinhaDeCheckout {
  session_id: string;
  organization_id: string;
  plano_id: string | null;
  preco_id: string | null;
}

interface LinhaDeAssinatura {
  organization_id: string;
  plano_id: string | null;
  preco_id: string | null;
  situacao: AssinaturaAtual["situacao"];
  liberado_ate: string | null;
  carencia_ate: string | null;
  cancelada_em: string | null;
  ultimo_evento_em: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

const data = (v: string | null): Date | null => (v ? new Date(v) : null);

/** Acha a assinatura já vinculada, por assinatura e depois por cliente. */
async function assinaturaVinculada(
  db: SupabaseClient,
  assinaturaId: string | null,
  clienteId: string | null,
): Promise<LinhaDeAssinatura | null> {
  const colunas =
    "organization_id, plano_id, preco_id, situacao, liberado_ate, carencia_ate, cancelada_em, ultimo_evento_em, stripe_customer_id, stripe_subscription_id";
  for (const [coluna, valor] of [
    ["stripe_subscription_id", assinaturaId],
    ["stripe_customer_id", clienteId],
  ] as const) {
    if (!valor) continue;
    const { data: linha, error } = await db.from("assinaturas").select(colunas).eq(coluna, valor).maybeSingle();
    if (error) throw new Error(`assinaturas(${coluna}): ${error.message}`);
    if (linha) return linha as unknown as LinhaDeAssinatura;
  }
  return null;
}

/** Acha o checkout que ESTE produto criou, por sessão, assinatura e depois cliente. */
async function checkoutVinculado(
  db: SupabaseClient,
  ids: { sessaoId?: string | null; assinaturaId?: string | null; clienteId?: string | null },
): Promise<LinhaDeCheckout | null> {
  const colunas = "session_id, organization_id, plano_id, preco_id";
  for (const [coluna, valor] of [
    ["session_id", ids.sessaoId],
    ["stripe_subscription_id", ids.assinaturaId],
    ["stripe_customer_id", ids.clienteId],
  ] as const) {
    if (!valor) continue;
    const { data: linha, error } = await db
      .from("cobranca_checkouts")
      .select(colunas)
      .eq(coluna, valor)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`cobranca_checkouts(${coluna}): ${error.message}`);
    if (linha) return linha as unknown as LinhaDeCheckout;
  }
  return null;
}

export async function processarEventoDoStripe(
  db: SupabaseClient,
  evento: EventoDoStripe,
  opts: { agora?: Date; carenciaDias: number },
): Promise<ResultadoDoEvento> {
  const agora = opts.agora ?? new Date();
  const efeito: Efeito = planejarEfeito(evento);

  if (efeito.tipo === "ignorar") {
    return { resultado: "ignorado_tipo", organizationId: null, detalhe: efeito.porque };
  }

  // ── vincular o checkout: só grava o mapa, nunca toca em `assinaturas` ────────
  if (efeito.tipo === "vincular_checkout") {
    const checkout = await checkoutVinculado(db, { sessaoId: efeito.sessaoId });
    if (!checkout) return { resultado: "sem_organizacao", organizationId: null, detalhe: "sessão desconhecida" };
    const { error } = await db
      .from("cobranca_checkouts")
      .update({ stripe_customer_id: efeito.clienteId, stripe_subscription_id: efeito.assinaturaId })
      .eq("session_id", efeito.sessaoId);
    if (error) throw new Error(`cobranca_checkouts(update): ${error.message}`);
    return { resultado: "vinculado", organizationId: checkout.organization_id };
  }

  // ── assinatura / fatura: resolve a organização por dado nosso ───────────────
  const atualLinha = await assinaturaVinculada(db, efeito.assinaturaId, efeito.clienteId);
  const checkout = atualLinha
    ? null
    : await checkoutVinculado(db, { assinaturaId: efeito.assinaturaId, clienteId: efeito.clienteId });
  const organizationId = atualLinha?.organization_id ?? checkout?.organization_id ?? null;
  if (!organizationId) {
    return { resultado: "sem_organizacao", organizationId: null, detalhe: "assinatura e cliente desconhecidos" };
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
    eventoCriadoEm: new Date(evento.created * 1000),
    agora,
    carenciaDias: opts.carenciaDias,
  });

  if (!t.aplicar) {
    const mapa = {
      fora_de_ordem: "ignorado_fora_de_ordem",
      sem_efeito: "ignorado_sem_efeito",
      sem_periodo: "ignorado_sem_periodo",
      sem_assinatura: "ignorado_sem_assinatura",
    } as const;
    return { resultado: mapa[t.motivo], organizationId };
  }

  // Na PRIMEIRA vez (sem linha), plano e preço vêm do checkout que criamos; depois
  // disso a linha os carrega e o evento nunca os troca.
  const planoId = atualLinha?.plano_id ?? checkout?.plano_id ?? null;
  const precoId = atualLinha?.preco_id ?? checkout?.preco_id ?? null;

  let valorCents: number | null = null;
  let moeda: string | null = null;
  if (!atualLinha && precoId) {
    const { data: preco } = await db.from("plano_precos").select("valor_cents, moeda").eq("id", precoId).maybeSingle();
    if (preco) {
      valorCents = Number((preco as { valor_cents: number }).valor_cents);
      moeda = (preco as { moeda: string }).moeda;
    }
  }

  const { error } = await db.from("assinaturas").upsert(
    {
      organization_id: organizationId,
      plano_id: planoId,
      preco_id: precoId,
      situacao: t.valores.situacao,
      liberado_ate: t.valores.liberadoAte?.toISOString() ?? null,
      carencia_ate: t.valores.carenciaAte?.toISOString() ?? null,
      cancelada_em: t.valores.canceladaEm?.toISOString() ?? null,
      ultimo_evento_em: t.valores.ultimoEventoEm.toISOString(),
      stripe_customer_id: efeito.clienteId ?? atualLinha?.stripe_customer_id ?? null,
      stripe_subscription_id: efeito.assinaturaId ?? atualLinha?.stripe_subscription_id ?? null,
      // A liberação é do PROVEDOR, não de uma pessoa: o autor e o motivo da porta
      // manual ficam vazios, e é assim que a tela distingue as duas origens.
      liberado_por: null,
      motivo: null,
      ...(valorCents !== null ? { valor_cents: valorCents, moeda } : {}),
    },
    { onConflict: "organization_id" },
  );
  if (error) {
    logger.error("stripe: falha ao gravar a assinatura", { organization_id: organizationId, detalhe: error.message });
    throw new Error(`assinaturas(upsert): ${error.message}`);
  }
  return { resultado: "aplicado", organizationId };
}
