/**
 * A PARTE COM REDE E BANCO DO CHECKOUT E DO CANCELAMENTO — PROVEDOR CAKTO.
 *
 * Molde: `lib/planos/stripe/sessoes.ts`. A diferença de fundo é que a Cakto não
 * tem um objeto "Price" único: um PLANO precisa de um PRODUTO (uma vez) e cada
 * PREÇO precisa de uma OFERTA (uma vez, por preço) — e é a oferta, nunca o
 * produto, que vira o link de pagamento (`urlDePagamento`).
 *
 * ═══ PRODUTO E OFERTA SÃO CRIADOS SOB DEMANDA, E UMA VEZ ═══
 *
 * A idempotência é a mesma ideia do Stripe: chave derivada do id da NOSSA linha
 * (`produto:<planos.id>`, `oferta:<plano_precos.id>`) — duas abas assinando ao
 * mesmo tempo criam UM produto e UMA oferta, não dois.
 *
 * ═══ NUNCA A OFERTA PADRÃO DO PRODUTO ═══
 *
 * A criação do produto pode devolver ofertas próprias (a documentação lista
 * `offers` na resposta), mas o link de pagamento SEMPRE vem da oferta que
 * `garantirOfertaNaCakto` cria para o PREÇO em questão — nunca de algo que a
 * Cakto tenha criado por conta própria junto do produto.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { cancelarAssinaturaNaCakto, chamarCakto, urlDePagamento, type CredenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import { DIAS_DO_INTERVALO, proximaAssinatura, type AssinaturaAtual } from "@/lib/planos/cobranca/maquina";
import type { SituacaoDeAssinatura } from "@/lib/planos/decisao";

export type FalhaDoCheckout = "plano_indisponivel" | "preco_indisponivel" | "provedor_recusou" | "registro_falhou";
export type ResultadoDoCheckout = { ok: true; url: string } | { ok: false; falha: FalhaDoCheckout; detalhe?: string };

export type FalhaDoCancelamento = "sem_assinatura_no_provedor" | "provedor_recusou";
export type ResultadoDoCancelamento =
  | { ok: true; acessoAte: Date | null }
  | { ok: false; falha: FalhaDoCancelamento; detalhe?: string };

interface PlanoParaCakto {
  id: string;
  nome: string;
  descricao: string | null;
  cakto_produto_id: string | null;
}

interface PrecoVigente {
  id: string;
  plano_id: string;
  intervalo: "mensal" | "anual";
  valor_cents: number;
  moeda: string;
  cakto_oferta_id: string | null;
}

/** Garante o PRODUTO na Cakto e devolve o id. Nunca lança. */
export async function garantirProdutoNaCakto(
  db: SupabaseClient,
  cred: CredenciaisDaCakto,
  plano: PlanoParaCakto,
  preco: PrecoVigente,
): Promise<{ ok: true; id: string } | { ok: false; detalhe: string }> {
  if (plano.cakto_produto_id) return { ok: true, id: plano.cakto_produto_id };

  const r = await chamarCakto<{ id: string }>(
    cred,
    "POST",
    "/products/",
    {
      name: plano.nome.slice(0, 255),
      description: plano.descricao ?? plano.nome,
      price: (preco.valor_cents / 100).toFixed(2),
      type: "subscription",
      currency: preco.moeda,
    },
    { idempotencia: `produto:${plano.id}` },
  );
  if (!r.ok) return { ok: false, detalhe: r.mensagem };

  await db.from("planos").update({ cakto_produto_id: r.dados.id }).eq("id", plano.id);
  return { ok: true, id: r.dados.id };
}

/** Garante a OFERTA na Cakto para ESTE preço e devolve o id. Nunca lança. */
export async function garantirOfertaNaCakto(
  db: SupabaseClient,
  cred: CredenciaisDaCakto,
  plano: PlanoParaCakto,
  preco: PrecoVigente,
): Promise<{ ok: true; id: string } | { ok: false; detalhe: string }> {
  if (preco.cakto_oferta_id) return { ok: true, id: preco.cakto_oferta_id };
  if (!plano.cakto_produto_id) return { ok: false, detalhe: "produto ausente" };

  const r = await chamarCakto<{ id: string }>(
    cred,
    "POST",
    "/offers/",
    {
      product: plano.cakto_produto_id,
      name: `${plano.nome} (${preco.intervalo})`,
      price: preco.valor_cents / 100,
      type: "subscription",
      intervalType: preco.intervalo === "anual" ? "year" : "month",
      interval: 1,
      recurrence_period: DIAS_DO_INTERVALO[preco.intervalo],
      quantity_recurrences: -1,
      trial_days: 0,
      currency: preco.moeda,
      status: "active",
    },
    { idempotencia: `oferta:${preco.id}` },
  );
  if (!r.ok) return { ok: false, detalhe: r.mensagem };

  // `publicado_em` acompanha: a constraint só admite preço publicado COM oferta,
  // e agora ela existe.
  await db
    .from("plano_precos")
    .update({ cakto_oferta_id: r.dados.id, publicado_em: new Date().toISOString() })
    .eq("id", preco.id);
  return { ok: true, id: r.dados.id };
}

export async function criarCheckoutNaCakto(entrada: {
  db: SupabaseClient;
  cred: CredenciaisDaCakto;
  organizationId: string;
  usuarioId: string;
  planoId: string;
  intervalo: "mensal" | "anual";
}): Promise<ResultadoDoCheckout> {
  const { db, cred, organizationId, usuarioId, planoId, intervalo } = entrada;

  // Só plano PUBLICADO e não arquivado é vendável: rascunho não se compra por URL
  // adivinhada, e arquivado não volta.
  const { data: planoLinha } = await db
    .from("planos")
    .select("id, nome, descricao, publicado_em, arquivado_em, cakto_produto_id")
    .eq("id", planoId)
    .maybeSingle();
  const p = planoLinha as
    | (PlanoParaCakto & { publicado_em: string | null; arquivado_em: string | null })
    | null;
  if (!p || !p.publicado_em || p.arquivado_em) return { ok: false, falha: "plano_indisponivel" };

  const { data: precoLinha } = await db
    .from("plano_precos")
    .select("id, plano_id, intervalo, valor_cents, moeda, cakto_oferta_id")
    .eq("plano_id", planoId)
    .eq("intervalo", intervalo)
    .is("arquivado_em", null)
    .maybeSingle();
  if (!precoLinha) return { ok: false, falha: "preco_indisponivel" };
  const preco = { ...(precoLinha as PrecoVigente), valor_cents: Number((precoLinha as PrecoVigente).valor_cents) };

  const produto = await garantirProdutoNaCakto(db, cred, p, preco);
  if (!produto.ok) return { ok: false, falha: "provedor_recusou", detalhe: produto.detalhe };

  const planoComProduto: PlanoParaCakto = { id: p.id, nome: p.nome, descricao: p.descricao, cakto_produto_id: produto.id };
  const oferta = await garantirOfertaNaCakto(db, cred, planoComProduto, preco);
  if (!oferta.ok) return { ok: false, falha: "provedor_recusou", detalhe: oferta.detalhe };

  const token = `dc_${randomBytes(24).toString("base64url")}`;

  const { error } = await db.from("cobranca_checkouts").insert({
    session_id: token,
    organization_id: organizationId,
    plano_id: planoId,
    preco_id: preco.id,
    provedor: "cakto",
    cakto_oferta_id: oferta.id,
    criado_por: usuarioId,
  });
  // Sem este registro o pagamento chegaria sem dono. Melhor recusar o link que
  // entregar ao cliente uma cobrança que nada libera.
  if (error && error.code !== "23505") return { ok: false, falha: "registro_falhou", detalhe: error.message };

  const url = urlDePagamento(oferta.id, token);
  if (!url) return { ok: false, falha: "registro_falhou", detalhe: "url de pagamento inválida" };
  return { ok: true, url };
}

interface LinhaDeAssinatura {
  situacao: SituacaoDeAssinatura;
  liberado_ate: string | null;
  carencia_ate: string | null;
  cancelada_em: string | null;
  ultimo_evento_em: string | null;
  cakto_assinatura_id: string | null;
}

/**
 * Cancela NA CAKTO na hora e marca `nao_renova`: quem pagou usa até o fim do
 * período já pago (`liberado_ate` não muda), e o acesso fecha sozinho quando o
 * webhook (ou o gate, por data) perceber que o prazo passou.
 */
export async function cancelarAssinaturaDaOrganizacao(entrada: {
  db: SupabaseClient;
  cred: CredenciaisDaCakto;
  organizationId: string;
  agora: Date;
}): Promise<ResultadoDoCancelamento> {
  const { db, cred, organizationId, agora } = entrada;

  const { data } = await db
    .from("assinaturas")
    .select("situacao, liberado_ate, carencia_ate, cancelada_em, ultimo_evento_em, cakto_assinatura_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const linha = data as LinhaDeAssinatura | null;

  if (!linha || !linha.cakto_assinatura_id) return { ok: false, falha: "sem_assinatura_no_provedor" };

  const atual: AssinaturaAtual = {
    situacao: linha.situacao,
    liberadoAte: linha.liberado_ate ? new Date(linha.liberado_ate) : null,
    carenciaAte: linha.carencia_ate ? new Date(linha.carencia_ate) : null,
    canceladaEm: linha.cancelada_em ? new Date(linha.cancelada_em) : null,
    ultimoEventoEm: linha.ultimo_evento_em ? new Date(linha.ultimo_evento_em) : null,
  };

  // Já cancelada: nada a fazer na Cakto de novo.
  if (atual.canceladaEm) return { ok: true, acessoAte: atual.liberadoAte };

  const cancelou = await cancelarAssinaturaNaCakto(cred, linha.cakto_assinatura_id);
  if (!cancelou.ok) return { ok: false, falha: "provedor_recusou", detalhe: cancelou.mensagem };

  const t = proximaAssinatura({ atual, efeito: { tipo: "nao_renova" }, eventoCriadoEm: agora, agora, carenciaDias: 0 });
  if (!t.aplicar) return { ok: true, acessoAte: atual.liberadoAte };

  const { error } = await db
    .from("assinaturas")
    .update({
      situacao: t.valores.situacao,
      liberado_ate: t.valores.liberadoAte?.toISOString() ?? null,
      carencia_ate: t.valores.carenciaAte?.toISOString() ?? null,
      cancelada_em: t.valores.canceladaEm?.toISOString() ?? null,
      ultimo_evento_em: t.valores.ultimoEventoEm.toISOString(),
    })
    .eq("organization_id", organizationId);
  if (error) throw new Error(`assinaturas(update): ${error.message}`);

  return { ok: true, acessoAte: t.valores.liberadoAte };
}
