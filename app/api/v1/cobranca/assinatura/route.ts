/**
 * CANCELAR A PRÓPRIA ASSINATURA — A PORTA DE SAÍDA LITERAL.
 *
 * `lib/voice/guarda.ts:16-21`: "o interruptor de desligar não pode exigir a coisa
 * ligada". Cancelar não pode depender de a assinatura estar em dia — quem está
 * inadimplente e quer sair tem de conseguir. Por isso sob `/api/v1/cobranca/`
 * (isento do gate) e com `portaDeSaida`.
 *
 * Cancela NO FIM DO PERÍODO: quem pagou usa até o fim, e o provedor avisa quando
 * acaba (`customer.subscription.deleted`) — que é quando o acesso de fato fecha.
 * Nada é apagado: os dados ficam, e voltar a assinar reabre tudo.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { credenciaisDoStripe } from "@/lib/planos/stripe/cliente";
import { cancelarNoFimDoPeriodo } from "@/lib/planos/stripe/sessoes";
import { createAdminClient } from "@/lib/supabase/admin";

export async function DELETE(): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "cobranca",
    portaDeSaida: "Cancelar: sair não pode depender de a assinatura estar em dia.",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const cred = await credenciaisDoStripe();
  if (!cred.chave) {
    return fail(
      "cobranca_indisponivel_na_instalacao",
      t("O pagamento online não está disponível nesta instalação. Fale com quem administra o sistema."),
      503,
      { requestId },
    );
  }

  const r = await cancelarNoFimDoPeriodo({ db: createAdminClient(), chave: cred.chave, organizationId: authz.org.orgId });
  if (!r.ok) {
    if (r.falha === "sem_assinatura_no_provedor") {
      return fail(
        "cobranca_sem_assinatura_no_provedor",
        t("Este acesso foi liberado por quem administra o sistema, e não por pagamento online. Fale com essa pessoa para cancelar."),
        409,
        { requestId },
      );
    }
    return fail("unavailable", t("Não foi possível cancelar agora. Tente de novo em instantes."), 502, { requestId });
  }

  void audit({
    action: "assinatura.cancelamento_pedido",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "assinatura",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { ao_fim_do_periodo: true },
  });
  return ok({ cancelada_no_fim_do_periodo: true }, { requestId });
}
