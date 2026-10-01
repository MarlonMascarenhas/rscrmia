/**
 * INICIAR O CHECKOUT — O CLIENTE ASSINA UM PLANO.
 *
 * Sob `/api/v1/cobranca/`, que o gate de cobrança isenta por prefixo, e por isso o
 * `portaDeSaida` abaixo: quem está bloqueado por teste vencido precisa poder
 * assinar. Trancar esta rota seria o bloqueio virando perda do cliente.
 *
 * `admin`: quem contrata pela organização é quem a administra. O plano vem do
 * corpo, mas a ORGANIZAÇÃO vem só do cookie validado por `requireRole` — nunca do
 * corpo, como manda o CLAUDE.md.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { credenciaisDaCakto, caktoPronto } from "@/lib/planos/cakto/cliente";
import { criarCheckoutNaCakto } from "@/lib/planos/cakto/sessoes";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.object({
  plano_id: z.string().uuid(),
  intervalo: z.enum(["mensal", "anual"]),
});

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "cobranca",
    portaDeSaida: "Assinar: quem está bloqueado por teste vencido precisa poder pagar.",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const cred = await credenciaisDaCakto();
  if (!caktoPronto(cred)) {
    return fail(
      "cobranca_indisponivel_na_instalacao",
      t("O pagamento online não está disponível nesta instalação. Fale com quem administra o sistema para assinar."),
      503,
      { requestId },
    );
  }

  const r = await criarCheckoutNaCakto({
    db: createAdminClient(),
    cred,
    organizationId: authz.org.orgId,
    usuarioId: authz.user.id,
    planoId: parsed.data.plano_id,
    intervalo: parsed.data.intervalo,
  });

  if (!r.ok) {
    const indisponivel = r.falha === "plano_indisponivel" || r.falha === "preco_indisponivel";
    const mensagem = indisponivel
      ? t("Este plano não está disponível para assinatura.")
      : t("Não foi possível iniciar o pagamento agora. Tente de novo em instantes.");
    return fail(indisponivel ? "not_found" : "unavailable", mensagem, indisponivel ? 404 : 502, { requestId });
  }

  void audit({
    action: "assinatura.checkout_iniciado",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "assinatura",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { plano_id: parsed.data.plano_id, intervalo: parsed.data.intervalo, provedor: "cakto" },
  });

  return ok({ url: r.url }, { requestId });
}
