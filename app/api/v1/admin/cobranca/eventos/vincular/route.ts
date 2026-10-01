/**
 * LIGA À MÃO UM EVENTO DA CAKTO SEM DONO A UMA ORGANIZAÇÃO.
 *
 * O webhook (`app/api/v1/webhooks/cakto/route.ts`) registra todo evento que não
 * consegue resolver organização como `sem_organizacao` — o pagamento nunca fica
 * perdido, só sem dono. Esta rota é a reconciliação manual: quem administra a
 * instalação escolhe a organização, e o evento é reprocessado com
 * `organizacaoForcada`, o mesmo caminho de `lib/planos/cakto/aplicar.ts`.
 *
 * Sob `/api/v1/admin/`, porta de saída do gate de cobrança. `scope === 'full'`:
 * ligar um pagamento a uma organização decide quem passa a ter acesso liberado,
 * e super-admin de leitura não o faz — mesma régua de `admin/cobranca/route.ts`.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { processarEventoDaCakto, type ResultadoDoEventoDaCakto } from "@/lib/planos/cakto/aplicar";
import { credenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import { eventoDaEntrada } from "@/lib/planos/cakto/webhook";
import { lerConfigDeCobranca } from "@/lib/planos/config";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z
  .object({
    chave: z.string().min(3).max(400),
    organization_slug: z.string().min(1).max(200),
  })
  .strict();

interface LinhaDoEvento {
  chave: string;
  entrada: unknown;
  processado_em: string | null;
  resultado: string | null;
  enviado_em: string | null;
  recebido_em: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  let admin: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  if (admin.platformAdmin.scope !== "full") {
    return fail("forbidden", "Este acesso é somente leitura.", 403, { requestId });
  }

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const { chave, organization_slug: slug } = parsed.data;

  const db = createAdminClient();

  const { data: org, error: erroOrg } = await db
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (erroOrg) return fail("internal_error", erroOrg.message, 500, { requestId });
  if (!org) return fail("not_found", "Organização não encontrada.", 404, { requestId });
  const organizationId = (org as { id: string }).id;

  const { data: linha, error: erroEvento } = await db
    .from("cobranca_eventos_cakto")
    .select("chave, entrada, processado_em, resultado, enviado_em, recebido_em")
    .eq("chave", chave)
    .maybeSingle();
  if (erroEvento) return fail("internal_error", erroEvento.message, 500, { requestId });
  if (!linha) return fail("not_found", "Evento não encontrado.", 404, { requestId });
  const evento = linha as LinhaDoEvento;

  // Só evento ainda não processado, ou processado como `sem_organizacao` (o
  // único desfecho que este endereço existe para corrigir), pode ser religado.
  if (evento.processado_em !== null && evento.resultado !== "sem_organizacao") {
    return fail("state_conflict", "Este pagamento já foi processado.", 409, { requestId });
  }

  const eventoDaCakto = eventoDaEntrada(evento.entrada);
  if (!eventoDaCakto) {
    return fail("validation_failed", "Não foi possível reconstruir o evento a partir do registro salvo.", 422, {
      requestId,
    });
  }

  const cred = await credenciaisDaCakto();
  const { carenciaDias } = await lerConfigDeCobranca(db);
  const eventoCriadoEm = new Date(evento.enviado_em ?? evento.recebido_em);

  let resultado: ResultadoDoEventoDaCakto;
  try {
    resultado = await processarEventoDaCakto(db, eventoDaCakto, {
      agora: new Date(),
      eventoCriadoEm,
      carenciaDias,
      cred,
      organizacaoForcada: organizationId,
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await db.from("cobranca_eventos_cakto").update({ erro: mensagem.slice(0, 500) }).eq("chave", chave);
    return fail("internal_error", "Não foi possível processar o evento.", 500, { requestId });
  }

  await db
    .from("cobranca_eventos_cakto")
    .update({
      processado_em: new Date().toISOString(),
      resultado: resultado.resultado,
      organization_id: resultado.organizationId,
      vinculado_por: admin.user.id,
      erro: null,
    })
    .eq("chave", chave);

  void audit({
    action: "assinatura.evento_vinculado_manualmente",
    actorUserId: admin.user.id,
    organizationId: resultado.organizationId,
    resourceType: "organization",
    resourceId: resultado.organizationId,
    requestId,
    metadata: { chave, resultado: resultado.resultado, organization_id: resultado.organizationId },
  });

  return ok({ resultado: resultado.resultado }, { requestId });
}
