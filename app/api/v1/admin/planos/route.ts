/**
 * O CATÁLOGO DE PLANOS — LISTAR E CRIAR.
 *
 * `requirePlatformAdmin`: o catálogo é da INSTALAÇÃO, e quem o edita é quem
 * administra o servidor, não o admin de uma organização. É a mesma fronteira que
 * `docs/doctrine/extensoes.md` chama de "a instância decide o pacote; a
 * organização decide o uso".
 *
 * Fica sob `/api/v1/admin/`, que é porta de saída do gate de cobrança
 * (`lib/planos/guarda.ts`) — e tem de ser: é aqui que se conserta uma cobrança
 * errada, e trancar isto por cobrança seria o impasse se fechando sobre si mesmo.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarPlanoSchema } from "@/lib/planos/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  // `requirePlatformAdmin` redireciona em contexto de tela e LANÇA em rota: o
  // try/catch é o padrão que `app/api/v1/admin/tenants/route.ts:51-56` firmou.
  let ctx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    ctx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  void ctx;

  const db = createAdminClient();
  const { data, error } = await db
    .from("planos")
    .select(
      "id, codigo, nome, descricao, ordem, libera_tudo, publicado_em, arquivado_em, created_at, " +
        "plano_capacidades(capacidade), plano_limites(limite, valor), " +
        "plano_precos(id, intervalo, valor_cents, moeda, stripe_price_id, publicado_em, arquivado_em)",
    )
    .is("arquivado_em", null)
    .order("ordem", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  // Quantas organizações usam cada plano. Serve à tela para não deixar alguém
  // arquivar um plano achando que ninguém o usa — e é leitura agregada, sem
  // expor nome de cliente nesta rota.
  const { data: emUso } = await db.from("assinaturas").select("plano_id");
  const contagem = new Map<string, number>();
  for (const a of (emUso ?? []) as Array<{ plano_id: string | null }>) {
    if (a.plano_id) contagem.set(a.plano_id, (contagem.get(a.plano_id) ?? 0) + 1);
  }

  // As tabelas de 0393 ainda não estão em `lib/database.types.ts` (que se
  // regenera com o banco de pé), então o PostgREST tipa a linha como erro. O
  // formato é conhecido e conferido pela própria consulta acima.
  const linhas = (data ?? []) as unknown as Array<Record<string, unknown> & { id: string }>;
  return ok(
    { planos: linhas.map((p) => ({ ...p, organizacoes: contagem.get(p.id) ?? 0 })) },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  let ctx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    ctx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const parsed = criarPlanoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const entrada = parsed.data;

  const db = createAdminClient();
  const { data: plano, error } = await db
    .from("planos")
    .insert({
      codigo: entrada.codigo,
      nome: entrada.nome,
      descricao: entrada.descricao ?? null,
      ordem: entrada.ordem,
      libera_tudo: entrada.libera_tudo,
      updated_by: ctx.user.id,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = o código já existe. Devolve 409 com o campo, para a tela apontar o
    // input em vez de mostrar um erro de banco.
    if (error.code === "23505") {
      return fail("state_conflict", "Já existe um plano com este código.", 409, {
        requestId,
        details: { campo: "codigo" },
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const planoId = plano.id as string;

  // Capacidades, limites e preços entram DEPOIS do plano, e um erro aqui não
  // desfaz o plano: ele nasce como rascunho (`publicado_em` null), então um
  // plano com metade das capacidades não é vendável nem visível ao cliente. Ter
  // o plano e completá-lo é melhor desfecho que perder o que foi digitado.
  if (entrada.capacidades.length > 0) {
    await db
      .from("plano_capacidades")
      .insert(entrada.capacidades.map((capacidade) => ({ plano_id: planoId, capacidade })));
  }
  if (entrada.limites.length > 0) {
    await db
      .from("plano_limites")
      .insert(entrada.limites.map((l) => ({ plano_id: planoId, limite: l.limite, valor: l.valor })));
  }
  if (entrada.precos.length > 0) {
    await db.from("plano_precos").insert(
      entrada.precos.map((p) => ({
        plano_id: planoId,
        intervalo: p.intervalo,
        valor_cents: p.valor_cents,
        moeda: p.moeda,
      })),
    );
  }

  void audit({
    action: "plano.created",
    actorUserId: ctx.user.id,
    organizationId: null,
    resourceType: "plano",
    resourceId: planoId,
    requestId,
    metadata: {
      codigo: entrada.codigo,
      libera_tudo: entrada.libera_tudo,
      capacidades: entrada.capacidades,
      limites: entrada.limites,
    },
  });
  // `plano.created` é `organizationId: null` de propósito: o plano é da instalação.

  return ok({ id: planoId }, { requestId });
}
