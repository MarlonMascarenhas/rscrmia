"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/**
 * O BOTÃO DE ASSINAR — chama o checkout e SEGUE a URL de pagamento que a rota devolve.
 *
 * Extraído de `app/app/settings/billing/_acoes.tsx` (que continua a usá-lo) para
 * ser reutilizado por `app/assinatura-vencida/page.tsx`: quem está bloqueado por
 * teste vencido também precisa poder assinar, sem duplicar a chamada. Comportamento
 * idêntico ao de origem — o pagamento e o cartão vivem no domínio do provedor (PCI
 * resolvido do lado dele), e nada do que o cliente digita passa por aqui.
 */
export function BotaoAssinar({
  planoId,
  intervalo,
  rotulo,
}: {
  planoId: string;
  intervalo: "mensal" | "anual";
  rotulo: string;
}) {
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
            const r = await fetch("/api/v1/cobranca/checkout", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ plano_id: planoId, intervalo }),
            });
            const j = (await r.json().catch(() => null)) as
              | { data?: { url?: string }; error?: { message?: string } }
              | null;
            if (r.ok && j?.data?.url) window.location.assign(j.data.url);
            else setErro(j?.error?.message ?? t("Não foi possível iniciar o pagamento agora. Tente de novo em instantes."));
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
