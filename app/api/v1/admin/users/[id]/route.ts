import { requireSupportWrite } from "@/lib/impersonate/support";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit, hashEmail } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/users/[id]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Load auth user via admin auth API
  const { data: authUserData, error: authError } =
    await admin.auth.admin.getUserById(id);

  if (authError || !authUserData?.user) {
    return fail("not_found", "User not found", 404, { requestId });
  }

  const authUser = authUserData.user;

  // Load memberships (user_organizations + organizations join)
  const { data: memberships, error: membershipError } = await admin
    .from("user_organizations")
    .select(
      `
      organization_id,
      role,
      accepted_at,
      revoked_at,
      organizations(display_name, slug)
    `,
    )
    .eq("user_id", id)
    .order("accepted_at", { ascending: false });

  if (membershipError) {
    return fail("internal_error", "Membership query failed", 500, {
      requestId,
      details: membershipError.message,
    });
  }

  type RawMembership = {
    organization_id: string;
    role: string;
    accepted_at: string | null;
    revoked_at: string | null;
    organizations: { display_name: string; slug: string } | null;
  };

  const formattedMemberships = ((memberships ?? []) as unknown as RawMembership[]).map(
    (m) => ({
      organization_id: m.organization_id,
      tenant_name: m.organizations?.display_name ?? null,
      tenant_slug: m.organizations?.slug ?? null,
      role: m.role,
      accepted_at: m.accepted_at,
      revoked_at: m.revoked_at,
    }),
  );

  // Load recent audit entries where actor_user_id = id (LIMIT 50)
  const { data: recentAudit, error: auditError } = await admin
    .from("api_audit_log")
    .select(
      "id, action, organization_id, resource_type, resource_id, created_at, metadata",
    )
    .eq("actor_user_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (auditError) {
    // Non-fatal: return empty array and continue
  }

  const { data: paRow } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", id)
    .is("revoked_at", null)
    .maybeSingle();

  const userMeta = authUser.user_metadata as Record<string, unknown> | null;

  const userPayload = {
    id: authUser.id,
    email: authUser.email ?? null,
    full_name: (userMeta?.full_name as string | undefined) ?? null,
    phone: authUser.phone ?? null,
    is_platform_admin: !!paRow,
    is_self: authUser.id === adminCtx.user.id,
    last_sign_in_at: authUser.last_sign_in_at ?? null,
    created_at: authUser.created_at,
    email_confirmed_at: authUser.email_confirmed_at ?? null,
    factors: (authUser.factors ?? []).map((f) => ({
      id: f.id,
      type: f.factor_type,
      status: f.status,
    })),
  };

  void audit({
    action: "platform_admin.user_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "user",
    resourceId: id,
    requestId,
    metadata: {
      email_hash: authUser.email
        ? Buffer.from(authUser.email.toLowerCase()).toString("hex").slice(0, 12) +
          "..."
        : null,
    },
  });

  return ok(
    {
      user: userPayload,
      memberships: formattedMemberships,
      recent_audit: recentAudit ?? [],
    },
    { requestId },
  );
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/users/[id] — apaga a CONTA (Auth)
//
// Perde o login e sai de todas as empresas; o histórico (mensagens, atividades,
// auditoria) fica, sem o vínculo. Só platform admin (+ AAL2).
//
// Ordem, e por quê:
//  1. `fn_admin_preparar_exclusao_de_usuario` (migration 0398), UMA transação sob
//     trava: recusa platform admin ativo, o único admin ativo de qualquer empresa
//     e FK NOT NULL sem cascade para auth.users (ex.: commissions); sem bloqueio,
//     anula as FKs anuláveis e revoga os vínculos ativos. Com bloqueio NADA muda.
//  2. `auth.admin.deleteUser`. Se falhar (502), o que o passo 1 anulou/revogou
//     PERMANECE — a conta segue existindo, só sem acesso às empresas. Repetir o
//     pedido é seguro: o passo 1 é idempotente. A revogação fica auditada
//     (admin.user_removed_from_org) mesmo no 502.
//
// Auditoria NÃO guarda o e-mail em claro: só o hash (hashEmail).
// ---------------------------------------------------------------------------

const idSchema = z.string().uuid();

interface BloqueiosExclusao {
  ultimos_admins: Array<{ organization_id: string; nome: string }>;
  registros_obrigatorios: Array<{ tabela: string; coluna: string; quantidade: number }>;
}

interface ResultadoPreparo {
  ok: boolean;
  codigo: "nao_encontrado" | "platform_admin" | "bloqueado" | "preparado";
  bloqueios?: BloqueiosExclusao;
  organizacoes_revogadas?: string[];
  anuladas?: Array<{ tabela: string; coluna: string; quantidade: number }>;
}

const NOME_DA_TABELA: Record<string, string> = { commissions: "comissões" };

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const rawId = (await params).id;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const parsedId = idSchema.safeParse(rawId);
  if (!parsedId.success) {
    return fail("validation_failed", "Invalid user id", 400, { requestId });
  }
  const id = parsedId.data;

  if (id === adminCtx.user.id) {
    return fail("state_conflict", "Não é possível apagar a própria conta.", 409, { requestId });
  }

  const admin = createAdminClient();

  const { data: authUserData, error: authError } = await admin.auth.admin.getUserById(id);
  if (authError || !authUserData?.user) {
    return fail("not_found", "User not found", 404, { requestId });
  }
  const emailHash = authUserData.user.email ? hashEmail(authUserData.user.email) : null;

  const { data, error } = await admin.rpc("fn_admin_preparar_exclusao_de_usuario", {
    p_user_id: id,
  });
  const preparo = data as ResultadoPreparo | null;
  if (error || !preparo) {
    return fail("internal_error", "Failed to prepare user deletion", 500, { requestId });
  }

  if (preparo.codigo === "nao_encontrado") {
    return fail("not_found", "User not found", 404, { requestId });
  }
  if (preparo.codigo === "platform_admin") {
    return fail(
      "state_conflict",
      "Este usuário é platform admin. Revogue o acesso de plataforma dele antes de apagar a conta.",
      409,
      { requestId },
    );
  }
  if (preparo.codigo === "bloqueado") {
    const ultimos = preparo.bloqueios?.ultimos_admins ?? [];
    const obrigatorios = preparo.bloqueios?.registros_obrigatorios ?? [];
    if (obrigatorios.length > 0) {
      const lista = obrigatorios
        .map((r) => `${NOME_DA_TABELA[r.tabela.replace(/^public./, "")] ?? r.tabela} (${r.quantidade})`)
        .join(", ");
      return fail(
        "usuario_tem_registros_obrigatorios",
        `Este usuário tem registros que dependem dele: ${lista}. Remova-o das empresas em vez de apagar a conta.`,
        409,
        { requestId, details: { registros_obrigatorios: obrigatorios, ultimos_admins: ultimos } },
      );
    }
    return fail(
      "usuario_e_ultimo_admin",
      "Este usuário é o único admin ativo de uma ou mais empresas. Promova outra pessoa a admin nelas antes de apagar a conta.",
      409,
      { requestId, details: { ultimos_admins: ultimos } },
    );
  }

  const organizacoesRevogadas = preparo.organizacoes_revogadas ?? [];
  const anuladas = preparo.anuladas ?? [];

  const { error: deleteError } = await admin.auth.admin.deleteUser(id);
  if (deleteError) {
    for (const orgId of organizacoesRevogadas) {
      await audit({
        action: "admin.user_removed_from_org",
        actorUserId: adminCtx.user.id,
        actingAsPlatformAdmin: true,
        bypassedRls: true,
        organizationId: orgId,
        resourceType: "membership",
        resourceId: id,
        requestId,
        metadata: { target_user_id: id, organization_id: orgId, via: "delete_user_failed" },
      });
    }
    return fail(
      "upstream_unavailable",
      "Não foi possível apagar a conta no serviço de autenticação. O usuário já foi removido das empresas; tente apagar a conta de novo.",
      502,
      { requestId },
    );
  }

  await audit({
    action: "admin.user_deleted",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "user",
    resourceId: id,
    requestId,
    metadata: {
      target_user_id: id,
      email_hash: emailHash,
      organization_ids: organizacoesRevogadas,
      nullified: anuladas,
    },
  });

  return ok({ id, deleted: true, organization_ids: organizacoesRevogadas }, { requestId });
}
