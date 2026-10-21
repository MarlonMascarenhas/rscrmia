import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/admin/users/[id]/organizations/[orgId]/revoke
 *
 * O platform admin tira UM usuário de UMA empresa: revogação lógica do vínculo
 * (`user_organizations.revoked_at`), a mesma de `team/[user_id]/revoke`, mas feita
 * de fora da empresa. A conta do usuário e os vínculos com outras empresas ficam.
 *
 * A regra do último admin e a mudança acontecem NUMA função SQL só, sob trava
 * (`fn_admin_revogar_vinculo`, migration 0398) — a rota do team conta e depois
 * atualiza em dois comandos, e duas revogações concorrentes passam as duas.
 *
 * Só platform admin (+ AAL2, que `requirePlatformAdmin` já exige). Remover a si
 * mesmo é recusado (409). `organization_id` vem do PATH, nunca do body.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
});

interface ResultadoRevogacao {
  ok: boolean;
  codigo: "nao_encontrado" | "ja_revogado" | "ultimo_admin" | "revogado";
  role?: string;
  revoked_at?: string;
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; orgId: string }> },
) {
  const requestId = randomUUID();
  const rawParams = await ctx.params;

  const supportDenied = await requireSupportWrite(rawParams.orgId);
  if (supportDenied) return supportDenied;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const parsed = paramsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return fail("validation_failed", "Invalid path params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { id: targetUserId, orgId } = parsed.data;

  if (targetUserId === adminCtx.user.id) {
    return fail(
      "state_conflict",
      "Não é possível remover a própria conta de uma empresa.",
      409,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_admin_revogar_vinculo", {
    p_user_id: targetUserId,
    p_org_id: orgId,
  });
  if (error) {
    return fail("internal_error", "Failed to revoke membership", 500, { requestId });
  }

  const res = data as ResultadoRevogacao | null;
  if (!res) {
    return fail("internal_error", "Failed to revoke membership", 500, { requestId });
  }

  if (res.codigo === "nao_encontrado") {
    return fail("not_found", "Este usuário não tem vínculo com esta empresa.", 404, { requestId });
  }
  if (res.codigo === "ultimo_admin") {
    return fail(
      "ultimo_admin",
      "Este usuário é o único admin ativo desta empresa. Promova outra pessoa a admin antes de removê-lo.",
      409,
      { requestId, details: { organization_id: orgId } },
    );
  }
  if (res.codigo === "ja_revogado") {
    return ok(
      { user_id: targetUserId, organization_id: orgId, already_revoked: true },
      { requestId },
    );
  }

  await audit({
    action: "admin.user_removed_from_org",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: orgId,
    resourceType: "membership",
    resourceId: targetUserId,
    requestId,
    metadata: {
      target_user_id: targetUserId,
      organization_id: orgId,
      revoked_role: res.role ?? null,
    },
  });

  return ok(
    { user_id: targetUserId, organization_id: orgId, revoked_at: res.revoked_at ?? null },
    { requestId },
  );
}
