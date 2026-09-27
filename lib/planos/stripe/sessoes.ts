/**
 * A PARTE COM REDE E BANCO DO CHECKOUT, DO PORTAL E DO CANCELAMENTO.
 *
 * Separada das rotas para ser testável com o cliente do Stripe e o banco dublados,
 * e para as três rotas serem só borda: autentica, valida, chama isto, audita.
 *
 * ═══ O PREÇO É CRIADO NO STRIPE SOB DEMANDA, E UMA VEZ ═══
 *
 * O `Price` do provedor é imutável, e a nossa linha em `plano_precos` também
 * (append-only). Por isso um preço vira `Price` na PRIMEIRA vez que alguém tenta
 * assiná-lo, com chave de idempotência derivada do id da linha — duas abas abrindo
 * o checkout ao mesmo tempo criam UM `Price`, não dois. Reajuste é linha nova e
 * `Price` novo; quem já assinou fica no `Price` que assinou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { chamarStripe, type RespostaDoStripe } from "@/lib/planos/stripe/cliente";

export type FalhaDaSessao =
  | "plano_indisponivel"
  | "preco_indisponivel"
  | "sem_assinatura_no_provedor"
  | "provedor_recusou";

export type ResultadoDaSessao = { ok: true; url: string } | { ok: false; falha: FalhaDaSessao; detalhe?: string };

interface PrecoVigente {
  id: string;
  plano_id: string;
  intervalo: "mensal" | "anual";
  valor_cents: number;
  moeda: string;
  stripe_price_id: string | null;
}

/** O cliente que o Stripe já conhece para esta organização, se houver. */
export async function clienteDoStripeDaOrganizacao(db: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data: assin } = await db
    .from("assinaturas")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const daAssinatura = (assin as { stripe_customer_id: string | null } | null)?.stripe_customer_id;
  if (daAssinatura) return daAssinatura;

  const { data: ultimo } = await db
    .from("cobranca_checkouts")
    .select("stripe_customer_id")
    .eq("organization_id", organizationId)
    .not("stripe_customer_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (ultimo as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null;
}

/** Garante o `Price` no Stripe e devolve o id. Nunca lança. */
async function garantirPrecoNoStripe(
  db: SupabaseClient,
  chave: string,
  preco: PrecoVigente,
  nomeDoPlano: string,
): Promise<{ ok: true; id: string } | { ok: false; detalhe: string }> {
  if (preco.stripe_price_id) return { ok: true, id: preco.stripe_price_id };

  const r = await chamarStripe<{ id: string }>(
    chave,
    "POST",
    "/v1/prices",
    {
      currency: preco.moeda.toLowerCase(),
      unit_amount: preco.valor_cents,
      recurring: { interval: preco.intervalo === "anual" ? "year" : "month" },
      product_data: { name: `${nomeDoPlano} (${preco.intervalo})` },
      metadata: { plano_preco_id: preco.id },
    },
    { idempotencia: `price:${preco.id}` },
  );
  if (!r.ok) return { ok: false, detalhe: r.mensagem };

  // `publicado_em` acompanha: a constraint só admite preço publicado COM objeto de
  // cobrança, e agora ele existe.
  await db
    .from("plano_precos")
    .update({ stripe_price_id: r.dados.id, publicado_em: new Date().toISOString() })
    .eq("id", preco.id);
  return { ok: true, id: r.dados.id };
}

export async function criarCheckout(entrada: {
  db: SupabaseClient;
  chave: string;
  organizationId: string;
  usuarioId: string;
  emailDoUsuario: string | null;
  planoId: string;
  intervalo: "mensal" | "anual";
  urlBase: string;
  idioma: string;
  agora?: Date;
}): Promise<ResultadoDaSessao> {
  const { db, chave, organizationId, planoId, intervalo, urlBase } = entrada;

  // Só plano PUBLICADO e não arquivado é vendável: rascunho não se compra por URL
  // adivinhada, e arquivado não volta.
  const { data: plano } = await db
    .from("planos")
    .select("id, nome, publicado_em, arquivado_em")
    .eq("id", planoId)
    .maybeSingle();
  const p = plano as { id: string; nome: string; publicado_em: string | null; arquivado_em: string | null } | null;
  if (!p || !p.publicado_em || p.arquivado_em) return { ok: false, falha: "plano_indisponivel" };

  const { data: precoLinha } = await db
    .from("plano_precos")
    .select("id, plano_id, intervalo, valor_cents, moeda, stripe_price_id")
    .eq("plano_id", planoId)
    .eq("intervalo", intervalo)
    .is("arquivado_em", null)
    .maybeSingle();
  if (!precoLinha) return { ok: false, falha: "preco_indisponivel" };
  const preco = { ...(precoLinha as PrecoVigente), valor_cents: Number((precoLinha as PrecoVigente).valor_cents) };

  const garantido = await garantirPrecoNoStripe(db, chave, preco, p.nome);
  if (!garantido.ok) return { ok: false, falha: "provedor_recusou", detalhe: garantido.detalhe };

  const clienteId = await clienteDoStripeDaOrganizacao(db, organizationId);
  const minuto = Math.floor((entrada.agora ?? new Date()).getTime() / 60_000);

  const r = await chamarStripe<{ id: string; url: string }>(
    chave,
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      line_items: [{ price: garantido.id, quantity: 1 }],
      success_url: `${urlBase}/app/settings/billing?checkout=ok`,
      cancel_url: `${urlBase}/app/settings/billing?checkout=cancelado`,
      client_reference_id: organizationId,
      allow_promotion_codes: true,
      locale: entrada.idioma === "es" ? "es" : "pt-BR",
      // Cliente conhecido é REUSADO (mesmo cartão, mesmo histórico); senão o Stripe cria
      // um e o `checkout.session.completed` nos devolve o id.
      ...(clienteId ? { customer: clienteId } : entrada.emailDoUsuario ? { customer_email: entrada.emailDoUsuario } : {}),
      // Conveniência de quem depura no painel do Stripe. A organização que VALE vem de
      // `cobranca_checkouts`, gravada logo abaixo — nunca deste campo.
      subscription_data: { metadata: { organization_id: organizationId } },
      metadata: { organization_id: organizationId },
    },
    // Um minuto de janela: duplo clique não cria duas sessões, e quem volta depois
    // de desistir recebe uma sessão nova em vez de uma expirada.
    { idempotencia: `checkout:${organizationId}:${preco.id}:${minuto}` },
  );
  if (!r.ok || !r.dados.url) return { ok: false, falha: "provedor_recusou", detalhe: r.ok ? "sem url" : r.mensagem };

  const { error } = await db.from("cobranca_checkouts").insert({
    session_id: r.dados.id,
    organization_id: organizationId,
    plano_id: planoId,
    preco_id: preco.id,
    stripe_customer_id: clienteId,
    criado_por: entrada.usuarioId,
  });
  // Sem este registro o pagamento chegaria sem dono. Melhor recusar a sessão que
  // entregar ao cliente um link que cobra e não libera.
  if (error && error.code !== "23505") return { ok: false, falha: "provedor_recusou", detalhe: error.message };

  return { ok: true, url: r.dados.url };
}

export async function criarPortal(entrada: {
  db: SupabaseClient;
  chave: string;
  organizationId: string;
  urlBase: string;
}): Promise<ResultadoDaSessao> {
  const clienteId = await clienteDoStripeDaOrganizacao(entrada.db, entrada.organizationId);
  if (!clienteId) return { ok: false, falha: "sem_assinatura_no_provedor" };

  const r = await chamarStripe<{ url: string }>(entrada.chave, "POST", "/v1/billing_portal/sessions", {
    customer: clienteId,
    return_url: `${entrada.urlBase}/app/settings/billing`,
  });
  if (!r.ok || !r.dados.url) return { ok: false, falha: "provedor_recusou", detalhe: r.ok ? "sem url" : r.mensagem };
  return { ok: true, url: r.dados.url };
}

/** Cancela NO FIM DO PERÍODO: quem pagou usa até o fim, e o Stripe avisa quando acaba. */
export async function cancelarNoFimDoPeriodo(entrada: {
  db: SupabaseClient;
  chave: string;
  organizationId: string;
}): Promise<{ ok: true } | { ok: false; falha: FalhaDaSessao; detalhe?: string }> {
  const { data } = await entrada.db
    .from("assinaturas")
    .select("stripe_subscription_id")
    .eq("organization_id", entrada.organizationId)
    .maybeSingle();
  const id = (data as { stripe_subscription_id: string | null } | null)?.stripe_subscription_id;
  if (!id) return { ok: false, falha: "sem_assinatura_no_provedor" };

  const r: RespostaDoStripe<Record<string, unknown>> = await chamarStripe(
    entrada.chave,
    "POST",
    `/v1/subscriptions/${encodeURIComponent(id)}`,
    { cancel_at_period_end: true },
  );
  return r.ok ? { ok: true } : { ok: false, falha: "provedor_recusou", detalhe: r.mensagem };
}
