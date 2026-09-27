"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/**
 * Os botões da tela de cobrança. Cada um chama uma rota de `/api/v1/cobranca/` e
 * SEGUE o link que ela devolve — o pagamento e o cartão vivem no domínio do
 * provedor (PCI resolvido do lado dele), e nada do que o cliente digita passa por aqui.
 */
async function seguir(caminho: string, metodo: "POST" | "DELETE", corpo?: unknown): Promise<{ url?: string; ok: boolean; mensagem?: string }> {
  const r = await fetch(caminho, {
    method: metodo,
    headers: corpo ? { "Content-Type": "application/json" } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = (await r.json().catch(() => null)) as { data?: { url?: string }; error?: { message?: string } } | null;
  return r.ok ? { ok: true, url: j?.data?.url } : { ok: false, mensagem: j?.error?.message };
}

export function BotaoAssinar({ planoId, intervalo, rotulo }: { planoId: string; intervalo: "mensal" | "anual"; rotulo: string }) {
  const t = useT();
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        disabled={pendente}
        onClick={() =>
          startTransition(async () => {
            setErro(null);
            const r = await seguir("/api/v1/cobranca/checkout", "POST", { plano_id: planoId, intervalo });
            if (r.ok && r.url) window.location.assign(r.url);
            else setErro(r.mensagem ?? t("Não foi possível iniciar o pagamento agora. Tente de novo em instantes."));
          })
        }
      >
        {pendente ? t("Abrindo…") : rotulo}
      </Button>
      {erro ? (
        <p role="alert" className="text-xs text-destructive">
          {erro}
        </p>
      ) : null}
    </div>
  );
}

export function BotoesDaAssinatura({ podeCancelar }: { podeCancelar: boolean }) {
  const t = useT();
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [cancelada, setCancelada] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pendente}
          onClick={() =>
            startTransition(async () => {
              setErro(null);
              const r = await seguir("/api/v1/cobranca/portal", "POST");
              if (r.ok && r.url) window.location.assign(r.url);
              else setErro(r.mensagem ?? t("Não foi possível abrir o portal agora. Tente de novo em instantes."));
            })
          }
        >
          {t("Cartão, faturas e recibos")}
        </Button>

        {podeCancelar && !cancelada ? (
          confirmando ? (
            <>
              <span className="self-center text-xs text-muted-foreground">
                {t("Você usa até o fim do período já pago. Seus dados não são apagados.")}
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
          )
        ) : null}
      </div>

      {cancelada ? (
        <p role="status" className="text-sm text-emerald-600">
          {t("Cancelamento pedido. Você continua com acesso até o fim do período pago.")}
        </p>
      ) : null}
      {erro ? (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
