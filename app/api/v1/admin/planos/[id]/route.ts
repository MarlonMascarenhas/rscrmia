/**
 * ATUALIZAR, PUBLICAR E ARQUIVAR UM PLANO.
 *
 * ═══ PREÇO É APPEND-ONLY, E É AQUI QUE ISSO SE CUMPRE ═══
 *
 * Mudar o valor de um preço NÃO faz `update` em `plano_precos.valor_cents`: cria
 * uma linha nova e arquiva a antiga. Três razões que se somam (o cabeçalho da
 * 0393 as desenvolve): o `Price` do provedor de pagamento é imutável; quem já
 * assinou fica no preço que assinou (no Brasil, reajuste sem novo consentimento é
 * problema de CDC); e o mandato do Pix Automático falha acima do valor autorizado.
 *
 * Só há linha nova onde o VALOR muda. Reenviar o mesmo preço é no-op, e é isso que
 * deixa a tela salvar o formulário inteiro sem gerar histórico à toa.
 *
 * ═══ CAPACIDADES E LIMITES SÃO SUBSTITUÍDOS POR DIFERENÇA ═══
 *
 * Apagar tudo e reinserir deixaria uma janela em que o plano existe SEM nenhuma
 * capacidade — e o gate falha FECHADO em capacidade. Aqui só se apaga o que saiu e
 * só se insere o que entrou, então o plano nunca fica vazio por um instante.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { atualizarPlanoSchema } from "@/lib/planos/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  // Catálogo é dinheiro: super-admin de leitura não edita (mesma fronteira da porta manual).
  if (admin.platformAdmin.scope !== "full") {
    return fail("forbidden", "Este acesso é somente leitura.", 403, { requestId });
  }

  const { id } = await ctx.params;
  const parsed = atualizarPlanoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const e = parsed.data;

  const db = createAdminClient();
  const { data: atual, error: erroAtual } = await db
    .from("planos")
    .select("id, publicado_em, arquivado_em")
    .eq("id", id)
    .maybeSingle();
  if (erroAtual) return fail("internal_error", erroAtual.message, 500, { requestId });
  if (!atual) return fail("not_found", "Plano não encontrado.", 404, { requestId });
  if ((atual as { arquivado_em: string | null }).arquivado_em) {
    return fail("state_conflict", "Este plano está arquivado e não muda mais.", 409, { requestId });
  }

  // ── campos do próprio plano + ciclo de vida ────────────────────────────────
  const campos: Record<string, unknown> = { updated_by: admin.user.id };
  if (e.nome !== undefined) campos.nome = e.nome;
  if (e.descricao !== undefined) campos.descricao = e.descricao ?? null;
  if (e.ordem !== undefined) campos.ordem = e.ordem;
  if (e.libera_tudo !== undefined) campos.libera_tudo = e.libera_tudo;
  if (e.publicado !== undefined) campos.publicado_em = e.publicado ? new Date().toISOString() : null;
  if (e.arquivar) campos.arquivado_em = new Date().toISOString();

  const { error: erroUpd } = await db.from("planos").update(campos).eq("id", id);
  if (erroUpd) return fail("internal_error", erroUpd.message, 500, { requestId });

  // ── capacidades: só a diferença ────────────────────────────────────────────
  if (e.capacidades !== undefined) {
    const { data: hoje } = await db.from("plano_capacidades").select("capacidade").eq("plano_id", id);
    const tem = new Set(((hoje ?? []) as Array<{ capacidade: string }>).map((c) => c.capacidade));
    const quer = new Set<string>(e.capacidades);
    const sair = [...tem].filter((c) => !quer.has(c));
    const entrar = [...quer].filter((c) => !tem.has(c));
    if (entrar.length > 0) {
      await db.from("plano_capacidades").insert(entrar.map((capacidade) => ({ plano_id: id, capacidade })));
    }
    if (sair.length > 0) {
      await db.from("plano_capacidades").delete().eq("plano_id", id).in("capacidade", sair);
    }
  }

  // ── limites: só a diferença; valor mudado é upsert ─────────────────────────
  if (e.limites !== undefined) {
    const { data: hoje } = await db.from("plano_limites").select("limite").eq("plano_id", id);
    const tem = new Set(((hoje ?? []) as Array<{ limite: string }>).map((l) => l.limite));
    const quer = new Map(e.limites.map((l) => [l.limite as string, l.valor]));
    const sair = [...tem].filter((l) => !quer.has(l));
    if (quer.size > 0) {
      await db
        .from("plano_limites")
        .upsert([...quer].map(([limite, valor]) => ({ plano_id: id, limite, valor })), { onConflict: "plano_id,limite" });
    }
    if (sair.length > 0) {
      await db.from("plano_limites").delete().eq("plano_id", id).in("limite", sair);
    }
  }

  // ── preços: APPEND-ONLY ────────────────────────────────────────────────────
  let precosNovos = 0;
  if (e.precos !== undefined) {
    const { data: vigentes } = await db
      .from("plano_precos")
      .select("id, intervalo, valor_cents, moeda")
      .eq("plano_id", id)
      .is("arquivado_em", null);
    const vig = (vigentes ?? []) as Array<{ id: string; intervalo: string; valor_cents: number; moeda: string }>;
    for (const p of e.precos) {
      const igual = vig.find((v) => v.intervalo === p.intervalo && v.moeda === p.moeda);
      if (igual && Number(igual.valor_cents) === p.valor_cents) continue; // reenviou o mesmo: no-op
      // ARQUIVA a antiga antes de inserir a nova: o índice único parcial
      // (plano, intervalo, moeda) onde `arquivado_em is null` recusaria as duas.
      if (igual) {
        await db.from("plano_precos").update({ arquivado_em: new Date().toISOString() }).eq("id", igual.id);
      }
      const { error: erroPreco } = await db
        .from("plano_precos")
        .insert({ plano_id: id, intervalo: p.intervalo, valor_cents: p.valor_cents, moeda: p.moeda });
      if (erroPreco) return fail("internal_error", erroPreco.message, 500, { requestId });
      precosNovos++;
    }
  }

  void audit({
    action: e.arquivar ? "plano.archived" : "plano.updated",
    actorUserId: admin.user.id,
    organizationId: null,
    resourceType: "plano",
    resourceId: id,
    requestId,
    metadata: {
      campos: Object.keys(campos).filter((c) => c !== "updated_by"),
      publicado: e.publicado ?? null,
      capacidades: e.capacidades ?? null,
      limites: e.limites ?? null,
      precos_novos: precosNovos,
    },
  });

  return ok({ id, precos_novos: precosNovos }, { requestId });
}
