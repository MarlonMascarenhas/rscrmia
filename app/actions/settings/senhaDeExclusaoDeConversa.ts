"use server";

/**
 * SENHA DA ORGANIZAÇÃO PARA EXCLUIR CONVERSAS (Configurações › Atendimento).
 *
 * Só o admin define. Excluir uma conversa é irreversível; a senha é o segundo
 * fator de intenção. O hash (scrypt) mora em
 * `organization_conversation_delete_secret`, que só o service role alcança —
 * por isso o `organization_id` vem de `resolveActiveOrg`, nunca do corpo.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { gerarHashDeSenha } from "@/lib/auth/senha-de-exclusao";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDaSenhaDeExclusao = { ok: true } | { ok: false; erro: string };

const entradaSchema = z
  .object({
    senha: z.string().min(6, "A senha precisa ter ao menos 6 caracteres.").max(128, "A senha pode ter no máximo 128 caracteres."),
    confirmacao: z.string(),
  })
  .refine((v) => v.senha === v.confirmacao, { message: "A confirmação não é igual à senha.", path: ["confirmacao"] });

export async function definirSenhaDeExclusaoDeConversa(entrada: {
  senha: string;
  confirmacao: string;
}): Promise<ResultadoDaSenhaDeExclusao> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
  if (supportWriteError(user.support)) return { ok: false, erro: "Acompanhamento somente leitura ou encerrado." };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "Nenhuma empresa ativa." };

  if (org.role !== "admin") {
    return { ok: false, erro: "Só um administrador pode definir essa senha." };
  }

  const parsed = entradaSchema.safeParse(entrada);
  if (!parsed.success) {
    return { ok: false, erro: parsed.error.issues[0]?.message ?? "Senha inválida." };
  }

  const password_hash = await gerarHashDeSenha(parsed.data.senha);

  const admin = createAdminClient();
  const { error } = await admin.from("organization_conversation_delete_secret").upsert(
    {
      organization_id: org.orgId,
      password_hash,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" },
  );
  if (error) return { ok: false, erro: "Não consegui salvar a senha agora." };

  await audit({
    action: "conversation.delete_password_set",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
  });

  revalidatePath("/app/settings/atendimento");
  return { ok: true };
}
