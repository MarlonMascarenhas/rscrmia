/**
 * A PARTE COM REDE E BANCO DO CHECKOUT E DO CANCELAMENTO — PROVEDOR ASAAS.
 *
 * Molde: `lib/planos/cakto/sessoes.ts` (removido pela ADR-0006). A diferença de
 * fundo é que o Asaas não tem produto nem oferta: um CLIENTE (o pagador) e uma
 * ASSINATURA (recorrência) bastam. A assinatura nasce com `billingType: UNDEFINED`
 * — quem escolhe Pix, boleto ou cartão é o cliente, na fatura hospedada — e a
 * resposta dela NÃO traz link de pagamento: o link (`invoiceUrl`) está na primeira
 * cobrança, que se busca em seguida.
 *
 * ═══ O CPF/CNPJ VAI AO ASAAS E A MAIS LUGAR NENHUM ═══
 *
 * É pedido uma vez, na hora de assinar, só quando a organização ainda não tem
 * cliente no Asaas. Não é gravado aqui, não vai para log nem para audit. Guardamos
 * o ID do cliente do Asaas, que é o que basta para as próximas assinaturas.
 *
 * ═══ O CLIENTE DUPLICADO ═══
 *
 * A API do Asaas aceita cadastrar o mesmo pagador duas vezes. Antes de criar, busca
 * `GET /customers?externalReference=<organização>`: se uma tentativa anterior criou
 * o cliente e a resposta se perdeu (timeout), ele é reaproveitado em vez de recriado
 * às cegas. O id é gravado no registro do checkout ANTES de criar a assinatura.
 *
 * ═══ A ORGANIZAÇÃO DO PAGAMENTO SAI DE DADO NOSSO ═══
 *
 * O registro de `cobranca_checkouts` nasce ANTES da assinatura, com um token opaco
 * nosso (`session_id`) que vai como `externalReference` da assinatura; o id da
 * assinatura é gravado nele assim que o Asaas responde. É o que o webhook usa.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { chamarAsaas, removerAssinaturaNoAsaas, type CredenciaisDoAsaas } from "@/lib/planos/asaas/cliente";
import { documentoValido, somenteDigitos } from "@/lib/planos/asaas/documento";
import { urlDeFaturaValida } from "@/lib/planos/asaas/webhook";
import { proximaAssinatura, type AssinaturaAtual } from "@/lib/planos/cobranca/maquina";
import type { SituacaoDeAssinatura } from "@/lib/planos/decisao";

export type FalhaDoCheckout =
  | "plano_indisponivel"
  | "preco_indisponivel"
  | "documento_obrigatorio"
  | "documento_invalido"
  | "provedor_recusou"
  | "registro_falhou"
  | "fatura_indisponivel";
export type ResultadoDoCheckout = { ok: true; url: string } | { ok: false; falha: FalhaDoCheckout; detalhe?: string };

export type FalhaDoCancelamento = "sem_assinatura_no_provedor" | "provedor_recusou";
export type ResultadoDoCancelamento =
  | { ok: true; acessoAte: Date | null }
  | { ok: false; falha: FalhaDoCancelamento; detalhe?: string };

/** O Asaas cobra em reais: não há campo de moeda na API. */
const MOEDA_DO_ASAAS = "BRL";

const TENTATIVAS_DA_FATURA = 4;
const ESPERA_ENTRE_TENTATIVAS_MS = 1_000;

/** `YYYY-MM-DD` de hoje em America/Sao_Paulo — o `nextDueDate` da primeira cobrança. */
export function hojeEmSaoPaulo(agora: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

/** Centavos → reais decimais, só na chamada ao Asaas. */
export const centavosParaReais = (cents: number): number => Number((cents / 100).toFixed(2));

/**
 * O cliente do Asaas que esta organização já tem, ou `null`. Primeiro a assinatura
 * (o cliente vigente), depois o checkout mais recente que o gravou — a linha de
 * `assinaturas` só nasce quando há período pago, e quem ainda não pagou também
 * não deve ser perguntado de novo.
 */
export async function clienteDoAsaasDaOrganizacao(db: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data: assin, error: erroAssin } = await db
    .from("assinaturas")
    .select("asaas_cliente_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroAssin) throw new Error(`assinaturas(asaas_cliente_id): ${erroAssin.message}`);
  const daAssinatura = (assin as { asaas_cliente_id: string | null } | null)?.asaas_cliente_id;
  if (daAssinatura) return daAssinatura;

  const { data: checkout, error: erroCheckout } = await db
    .from("cobranca_checkouts")
    .select("asaas_cliente_id")
    .eq("organization_id", organizationId)
    .eq("provedor", "asaas")
    .not("asaas_cliente_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroCheckout) throw new Error(`cobranca_checkouts(asaas_cliente_id): ${erroCheckout.message}`);
  return (checkout as { asaas_cliente_id: string | null } | null)?.asaas_cliente_id ?? null;
}

/** Garante o cliente no Asaas (achando o que uma tentativa anterior criou) e devolve o id. Nunca lança. */
async function garantirClienteNoAsaas(
  cred: CredenciaisDoAsaas,
  entrada: { organizationId: string; nome: string; documento: string },
): Promise<{ ok: true; id: string } | { ok: false; detalhe: string }> {
  const busca = await chamarAsaas<{ data?: Array<{ id?: unknown }> }>(
    cred,
    "GET",
    `/customers?externalReference=${encodeURIComponent(entrada.organizationId)}&limit=1`,
  );
  if (!busca.ok) return { ok: false, detalhe: busca.mensagem };
  const existente = busca.dados.data?.[0]?.id;
  if (typeof existente === "string" && existente !== "") return { ok: true, id: existente };

  const criado = await chamarAsaas<{ id?: unknown }>(cred, "POST", "/customers", {
    name: entrada.nome,
    cpfCnpj: somenteDigitos(entrada.documento),
    externalReference: entrada.organizationId,
  });
  if (!criado.ok) return { ok: false, detalhe: criado.mensagem };
  if (typeof criado.dados.id !== "string" || criado.dados.id === "") {
    return { ok: false, detalhe: "o Asaas não devolveu o id do cliente" };
  }
  return { ok: true, id: criado.dados.id };
}

/**
 * A fatura (`invoiceUrl`) da primeira cobrança da assinatura. O Asaas gera a
 * cobrança logo depois de criar a assinatura, mas não na mesma resposta; tenta
 * algumas vezes com pequeno intervalo. `null` = não apareceu.
 */
export async function buscarFaturaDaAssinatura(
  cred: CredenciaisDoAsaas,
  assinaturaId: string,
  opts: { tentativas?: number; esperaMs?: number } = {},
): Promise<{ url: string; pagamentoId: string | null } | null> {
  const tentativas = opts.tentativas ?? TENTATIVAS_DA_FATURA;
  const esperaMs = opts.esperaMs ?? ESPERA_ENTRE_TENTATIVAS_MS;

  for (let i = 0; i < tentativas; i++) {
    if (i > 0 && esperaMs > 0) await new Promise((r) => setTimeout(r, esperaMs));
    const r = await chamarAsaas<{ data?: Array<{ id?: unknown; invoiceUrl?: unknown; dueDate?: unknown }> }>(
      cred,
      "GET",
      `/subscriptions/${encodeURIComponent(assinaturaId)}/payments?limit=10`,
    );
    if (!r.ok) continue;
    const comLink = (r.dados.data ?? []).filter((p) => urlDeFaturaValida(p.invoiceUrl));
    if (comLink.length === 0) continue;
    // A mais antiga primeiro: a primeira cobrança é a que o cliente tem de pagar.
    comLink.sort((a, b) => String(a.dueDate ?? "").localeCompare(String(b.dueDate ?? "")));
    const primeira = comLink[0]!;
    return { url: primeira.invoiceUrl as string, pagamentoId: typeof primeira.id === "string" ? primeira.id : null };
  }
  return null;
}

interface PlanoParaAsaas {
  id: string;
  nome: string;
  publicado_em: string | null;
  arquivado_em: string | null;
}

interface PrecoVigente {
  id: string;
  intervalo: "mensal" | "anual";
  valor_cents: number;
  moeda: string;
}

export async function criarCheckoutNoAsaas(entrada: {
  db: SupabaseClient;
  cred: CredenciaisDoAsaas;
  organizationId: string;
  usuarioId: string;
  planoId: string;
  intervalo: "mensal" | "anual";
  /** Nome do pagador e CPF/CNPJ — exigidos só quando a organização ainda não tem cliente no Asaas. */
  pagador?: { nome: string; documento: string } | null;
  agora?: Date;
  esperaDaFaturaMs?: number;
}): Promise<ResultadoDoCheckout> {
  const { db, cred, organizationId, usuarioId, planoId, intervalo } = entrada;
  const agora = entrada.agora ?? new Date();

  // Só plano PUBLICADO e não arquivado é vendável: rascunho não se compra por URL
  // adivinhada, e arquivado não volta.
  const { data: planoLinha } = await db
    .from("planos")
    .select("id, nome, publicado_em, arquivado_em")
    .eq("id", planoId)
    .maybeSingle();
  const p = planoLinha as PlanoParaAsaas | null;
  if (!p || !p.publicado_em || p.arquivado_em) return { ok: false, falha: "plano_indisponivel" };

  const { data: precoLinha } = await db
    .from("plano_precos")
    .select("id, intervalo, valor_cents, moeda")
    .eq("plano_id", planoId)
    .eq("intervalo", intervalo)
    .is("arquivado_em", null)
    .maybeSingle();
  if (!precoLinha) return { ok: false, falha: "preco_indisponivel" };
  const preco = { ...(precoLinha as PrecoVigente), valor_cents: Number((precoLinha as PrecoVigente).valor_cents) };
  // O Asaas não tem moeda na API: um preço que não seja em reais seria cobrado errado.
  if (preco.moeda !== MOEDA_DO_ASAAS || !(preco.valor_cents > 0)) return { ok: false, falha: "preco_indisponivel" };

  // ── o cliente ─────────────────────────────────────────────────────────────
  let clienteId = await clienteDoAsaasDaOrganizacao(db, organizationId);
  if (!clienteId) {
    const nome = entrada.pagador?.nome?.trim() ?? "";
    const documento = entrada.pagador?.documento ?? "";
    if (nome === "" || documento.trim() === "") return { ok: false, falha: "documento_obrigatorio" };
    if (!documentoValido(documento)) return { ok: false, falha: "documento_invalido" };
    const cliente = await garantirClienteNoAsaas(cred, { organizationId, nome, documento });
    if (!cliente.ok) return { ok: false, falha: "provedor_recusou", detalhe: cliente.detalhe };
    clienteId = cliente.id;
  }

  // ── o registro nosso, ANTES da assinatura ─────────────────────────────────
  const token = `dc_${randomBytes(24).toString("base64url")}`;
  const { error: erroRegistro } = await db.from("cobranca_checkouts").insert({
    session_id: token,
    organization_id: organizationId,
    plano_id: planoId,
    preco_id: preco.id,
    provedor: "asaas",
    asaas_cliente_id: clienteId,
    criado_por: usuarioId,
  });
  // Sem este registro o pagamento chegaria sem dono. Melhor recusar que entregar
  // ao cliente uma cobrança que nada libera.
  if (erroRegistro) return { ok: false, falha: "registro_falhou", detalhe: erroRegistro.message };

  // ── a assinatura ──────────────────────────────────────────────────────────
  const assinatura = await chamarAsaas<{ id?: unknown }>(cred, "POST", "/subscriptions", {
    customer: clienteId,
    billingType: "UNDEFINED",
    value: centavosParaReais(preco.valor_cents),
    nextDueDate: hojeEmSaoPaulo(agora),
    cycle: preco.intervalo === "anual" ? "YEARLY" : "MONTHLY",
    description: `${p.nome} (${preco.intervalo})`.slice(0, 500),
    externalReference: token,
  });
  if (!assinatura.ok) return { ok: false, falha: "provedor_recusou", detalhe: assinatura.mensagem };
  const assinaturaId = assinatura.dados.id;
  if (typeof assinaturaId !== "string" || assinaturaId === "") {
    return { ok: false, falha: "provedor_recusou", detalhe: "o Asaas não devolveu o id da assinatura" };
  }

  const { error: erroVinculo } = await db
    .from("cobranca_checkouts")
    .update({ asaas_assinatura_id: assinaturaId })
    .eq("session_id", token);
  if (erroVinculo) return { ok: false, falha: "registro_falhou", detalhe: erroVinculo.message };

  // ── a fatura ──────────────────────────────────────────────────────────────
  const fatura = await buscarFaturaDaAssinatura(cred, assinaturaId, { esperaMs: entrada.esperaDaFaturaMs });
  // A assinatura já existe e está registrada: o webhook seguirá ligando os pagamentos
  // dela à organização. Só não há para onde mandar o cliente agora.
  if (!fatura) return { ok: false, falha: "fatura_indisponivel" };

  if (fatura.pagamentoId) {
    await db.from("cobranca_checkouts").update({ asaas_pagamento_id: fatura.pagamentoId }).eq("session_id", token);
  }
  return { ok: true, url: fatura.url };
}

interface LinhaDeAssinatura {
  situacao: SituacaoDeAssinatura;
  liberado_ate: string | null;
  carencia_ate: string | null;
  cancelada_em: string | null;
  ultimo_evento_em: string | null;
  asaas_assinatura_id: string | null;
}

/**
 * Remove NO ASAAS na hora e marca `nao_renova`: quem pagou usa até o fim do
 * período já pago (`liberado_ate` não muda), e o acesso fecha sozinho quando o
 * gate perceber, por data, que o prazo passou.
 */
export async function cancelarAssinaturaDaOrganizacao(entrada: {
  db: SupabaseClient;
  cred: CredenciaisDoAsaas;
  organizationId: string;
  agora: Date;
}): Promise<ResultadoDoCancelamento> {
  const { db, cred, organizationId, agora } = entrada;

  const { data } = await db
    .from("assinaturas")
    .select("situacao, liberado_ate, carencia_ate, cancelada_em, ultimo_evento_em, asaas_assinatura_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const linha = data as LinhaDeAssinatura | null;

  if (!linha || !linha.asaas_assinatura_id) return { ok: false, falha: "sem_assinatura_no_provedor" };

  const atual: AssinaturaAtual = {
    situacao: linha.situacao,
    liberadoAte: linha.liberado_ate ? new Date(linha.liberado_ate) : null,
    carenciaAte: linha.carencia_ate ? new Date(linha.carencia_ate) : null,
    canceladaEm: linha.cancelada_em ? new Date(linha.cancelada_em) : null,
    ultimoEventoEm: linha.ultimo_evento_em ? new Date(linha.ultimo_evento_em) : null,
  };

  // Já cancelada: nada a fazer no Asaas de novo.
  if (atual.canceladaEm) return { ok: true, acessoAte: atual.liberadoAte };

  const removeu = await removerAssinaturaNoAsaas(cred, linha.asaas_assinatura_id);
  if (!removeu.ok) return { ok: false, falha: "provedor_recusou", detalhe: removeu.mensagem };

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
