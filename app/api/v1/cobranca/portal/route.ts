/**
 * O PORTAL DO STRIPE — ATUALIZAR CARTÃO, VER FATURAS, CANCELAR.
 *
 * É a razão de o produto não guardar tabela de faturas nem tela de cartão: o
 * portal hospedado pelo provedor cobre as duas, com PCI resolvido do lado dele, e
 * uma cópia nossa envelheceria. Só o link de entrada é nosso.
 *
 * Porta de saída do gate (`/api/v1/cobranca/`): a organização inadimplente precisa
 * chegar aqui para atualizar o cartão — trancar esta rota impediria justamente a
 * ação que a destrancaria.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { credenciaisDoStripe, stripePronto } from "@/lib/planos/stripe/cliente";
import { criarPortal } from "@/lib/planos/stripe/sessoes";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "cobranca",
    portaDeSaida: "Atualizar o cartão: a organização inadimplente precisa chegar aqui para se destrancar.",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const cred = await credenciaisDoStripe();
  if (!stripePronto(cred) || !cred.chave) {
    return fail(
      "cobranca_indisponivel_na_instalacao",
      t("O pagamento online não está disponível nesta instalação. Fale com quem administra o sistema."),
      503,
      { requestId },
    );
  }

  const r = await criarPortal({
    db: createAdminClient(),
    chave: cred.chave,
    organizationId: authz.org.orgId,
    urlBase: env.NEXT_PUBLIC_APP_URL.replace(/\/$/, ""),
  });

  if (!r.ok) {
    if (r.falha === "sem_assinatura_no_provedor") {
      return fail(
        "cobranca_sem_assinatura_no_provedor",
        t("Este acesso foi liberado por quem administra o sistema, e não por pagamento online. Fale com essa pessoa para mudar ou cancelar."),
        409,
        { requestId },
      );
    }
    return fail("unavailable", t("Não foi possível abrir o portal agora. Tente de novo em instantes."), 502, { requestId });
  }
  return ok({ url: r.url }, { requestId });
}
