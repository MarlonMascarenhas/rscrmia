import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { convergirGruposDoCanal, lerCanalParaGrupos } from "@/lib/channels/grupos";
import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const grupoUpdateSchema = z.object({ mostrar_grupos: z.boolean() }).strict();

/** Liga/desliga se os grupos deste número aparecem no CRM, e converge o transporte. Admin only. */
export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return fail("validation_failed", "Canal inválido.", 422, { requestId });
  const parsed = grupoUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Informe se os grupos aparecem.", 422, { requestId });
  const { mostrar_grupos } = parsed.data;

  const canal = await lerCanalParaGrupos(createAdminClient(), auth.org.orgId, id);
  if (canal.situacao === "erro") return fail("internal_error", "Não foi possível carregar o canal.", 500, { requestId });
  if (canal.situacao === "nao_encontrado") return fail("not_found", "Canal não encontrado.", 404, { requestId });
  if (canal.situacao === "sem_sessao") return fail("validation_failed", "Grupos só existem em números conectados por QR.", 422, { requestId });

  const { error: updateError } = await createAdminClient().from("channel_sessions")
    .update({ mostrar_grupos }).eq("organization_id", auth.org.orgId).eq("id", id).is("archived_at", null);
  if (updateError) return fail("internal_error", "Não foi possível salvar a preferência de grupos.", 500, { requestId });

  const aplicacao = await convergirGruposDoCanal(canal.sessionRef, mostrar_grupos);

  void audit({
    action: "channel.groups_visibility_updated", actorUserId: auth.user.id,
    organizationId: auth.org.orgId, resourceType: "channel_session", resourceId: id, requestId,
    metadata: { mostrar_grupos, aplicacao },
  });
  return ok({ mostrar_grupos, aplicacao }, { requestId });
}
