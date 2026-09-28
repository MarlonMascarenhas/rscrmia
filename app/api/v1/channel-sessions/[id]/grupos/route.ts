import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

const grupoUpdateSchema = z.object({ mostrar_grupos: z.boolean() }).strict();

/** Liga/desliga se os grupos deste número aparecem no CRM, e converge o WAHA. Admin only. */
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

  const { data: row, error } = await createAdminClient().from("channel_sessions")
    .select("id, waha_session_name").eq("organization_id", auth.org.orgId).eq("id", id)
    .is("archived_at", null).maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar o canal.", 500, { requestId });
  if (!row) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  if (!row.waha_session_name) return fail("validation_failed", "Grupos só existem em números conectados por QR.", 422, { requestId });

  const { error: updateError } = await createAdminClient().from("channel_sessions")
    .update({ mostrar_grupos }).eq("organization_id", auth.org.orgId).eq("id", id).is("archived_at", null);
  if (updateError) return fail("internal_error", "Não foi possível salvar a preferência de grupos.", 500, { requestId });

  const waha = getWahaClient();
  const aplicado = waha ? await waha.convergirConfigDaSessao(row.waha_session_name, { mostrarGrupos: mostrar_grupos }) : "nao_aplicada";

  void audit({
    action: "channel.groups_visibility_updated", actorUserId: auth.user.id,
    organizationId: auth.org.orgId, resourceType: "channel_session", resourceId: id, requestId,
    metadata: { mostrar_grupos, waha: aplicado },
  });
  return ok({ mostrar_grupos, waha: aplicado }, { requestId });
}
