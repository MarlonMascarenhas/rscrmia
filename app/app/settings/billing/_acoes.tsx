"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

/**
 * O botão de cancelar da tela de cobrança. Chama `/api/v1/cobranca/assinatura` e
 * SEGUE o resultado — nada do que o cliente digita passa por aqui.
 *
 * SEM PORTAL: a Cakto não tem painel do cliente para cartão, fatura ou recibo — só
 * o checkout (assinar) e o cancelamento, que são as duas ações desta tela.
 * Cancelar na Cakto é IMEDIATO, mas o acesso segue até `acesso_ate`, que a rota
 * devolve — é essa data que a confirmação e o aviso de sucesso mostram.
 */
async function seguir(
  caminho: string,
  metodo: "POST" | "DELETE",
  corpo?: unknown,
): Promise<{ ok: boolean; acessoAte?: string | null; mensagem?: string }> {
  const r = await fetch(caminho, {
    method: metodo,
    headers: corpo ? { "Content-Type": "application/json" } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = (await r.json().catch(() => null)) as
    | { data?: { acesso_ate?: string | null }; error?: { message?: string } }
    | null;
  return r.ok ? { ok: true, acessoAte: j?.data?.acesso_ate ?? null } : { ok: false, mensagem: j?.error?.message };
}

export function BotoesDaAssinatura({
  podeCancelar,
  expiraEmTexto,
}: {
  podeCancelar: boolean;
  /** A data já formatada que a tela mostra em "Renova / vence em". `null` = sem prazo a citar. */
  expiraEmTexto: string | null;
}) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [dataCancelada, setDataCancelada] = useState<string | null>(null);
  const [cancelada, setCancelada] = useState(false);

  if (cancelada) {
    return (
      <p role="status" className="text-sm text-emerald-600">
        {dataCancelada
          ? t("Cancelada — acesso até {data}.").replace("{data}", dataCancelada)
          : t("A cobrança para agora. Seus dados não são apagados.")}
      </p>
    );
  }

  if (!podeCancelar) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {confirmando ? (
          <>
            <span className="self-center text-xs text-muted-foreground">
              {expiraEmTexto
                ? t("A cobrança para agora. Você usa até {data}. Seus dados não são apagados.").replace(
                    "{data}",
                    expiraEmTexto,
                  )
                : t("A cobrança para agora. Seus dados não são apagados.")}
            </span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pendente}
              onClick={() =>
                startTransition(async () => {
                  setErro(null);
                  const r = await seguir("/api/v1/cobranca/assinatura", "DELETE");
                  if (r.ok) {
                    setDataCancelada(
                      r.acessoAte ? new Date(r.acessoAte).toLocaleDateString(tagDeIdioma) : expiraEmTexto,
                    );
                    setCancelada(true);
                    setConfirmando(false);
                  } else setErro(r.mensagem ?? t("Não foi possível cancelar agora. Tente de novo em instantes."));
                })
              }
            >
              {t("Confirmar cancelamento")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmando(false)}>
              {t("Voltar")}
            </Button>
          </>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmando(true)}>
            {t("Cancelar assinatura")}
          </Button>
        )}
      </div>

      {erro ? (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
