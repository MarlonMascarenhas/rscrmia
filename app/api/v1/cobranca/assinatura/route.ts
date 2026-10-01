/**
 * CANCELAR A PRÓPRIA ASSINATURA — A PORTA DE SAÍDA LITERAL.
 *
 * `lib/voice/guarda.ts:16-21`: "o interruptor de desligar não pode exigir a coisa
 * ligada". Cancelar não pode depender de a assinatura estar em dia — quem está
 * inadimplente e quer sair tem de conseguir. Por isso sob `/api/v1/cobranca/`
 * (isento do gate) e com `portaDeSaida`.
 *
 * Cancela NA CAKTO na hora, mas o ACESSO segue até o fim do período já pago
 * (`liberado_ate` não muda) — efeito `nao_renova` de `lib/planos/cobranca/maquina.ts`.
 * Nada é apagado: os dados ficam, e voltar a assinar reabre tudo.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { caktoPronto, credenciaisDaCakto } from "@/lib/planos/cakto/cliente";
import { cancelarAssinaturaDaOrganizacao } from "@/lib/planos/cakto/sessoes";
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

  const cred = await credenciaisDaCakto();
  if (!caktoPronto(cred)) {
    return fail(
      "cobranca_indisponivel_na_instalacao",
      t("O pagamento online não está disponível nesta instalação. Fale com quem administra o sistema."),
      503,
      { requestId },
    );
  }

  const r = await cancelarAssinaturaDaOrganizacao({
    db: createAdminClient(),
    cred,
    organizationId: authz.org.orgId,
    agora: new Date(),
  });
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
    metadata: { imediato_no_provedor: true, acesso_ate: r.acessoAte ? r.acessoAte.toISOString() : null },
  });
  return ok({ cancelada: true, acesso_ate: r.acessoAte ? r.acessoAte.toISOString() : null }, { requestId });
}
