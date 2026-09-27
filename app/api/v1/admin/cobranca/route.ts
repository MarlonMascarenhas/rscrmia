/**
 * LIGAR E AJUSTAR A COBRANÇA DA INSTALAÇÃO.
 *
 * Sob `/api/v1/admin/` — porta de saída do gate, e tem de ser: é aqui que se
 * desliga a cobrança quando ela trancou gente por engano.
 *
 * `scope === 'full'`: ligar a cobrança decide quem trabalha e quem não, e
 * super-admin de leitura não o faz.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  contarOrganizacoesVencidas,
  lerConfigDeCobranca,
  linhasDoPatch,
  validarTransicaoDeModo,
} from "@/lib/planos/config";
import { createAdminClient } from "@/lib/supabase/admin";

const patchSchema = z
  .object({
    ligada: z.boolean(),
    diasDeTeste: z.number().int().min(1).max(365),
    carenciaDias: z.number().int().min(0).max(90),
    modoDeLimite: z.enum(["off", "avisar", "bloquear"]),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nada para alterar.");

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  const db = createAdminClient();
  const [config, vencidas] = await Promise.all([lerConfigDeCobranca(db), contarOrganizacoesVencidas(db)]);
  return ok({ config, organizacoes_vencidas: vencidas }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
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

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const patch = parsed.data;

  const db = createAdminClient();
  const antes = await lerConfigDeCobranca(db);

  if (patch.modoDeLimite !== undefined) {
    const motivo = validarTransicaoDeModo(antes.modoDeLimite, patch.modoDeLimite);
    if (motivo) return fail("validation_failed", motivo, 422, { requestId, details: { campo: "modoDeLimite" } });
  }

  const linhas = linhasDoPatch(patch).map((l) => ({
    ...l,
    eh_segredo: false,
    // Foi uma pessoa: nada sobrescreve na reaplicação do baseline.
    semeado_do_env: false,
    updated_by: admin.user.id,
  }));
  const { error } = await db.from("platform_config").upsert(linhas, { onConflict: "chave" });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const depois = await lerConfigDeCobranca(db);
  void audit({
    action: "cobranca.configuracao_alterada",
    actorUserId: admin.user.id,
    organizationId: null,
    resourceType: "platform_config",
    resourceId: null,
    requestId,
    // Antes e depois, sempre: a pergunta que se faz meses depois é "quem ligou a
    // cobrança, e o que valia antes".
    metadata: { antes, depois },
  });

  return ok({ config: depois }, { requestId });
}
