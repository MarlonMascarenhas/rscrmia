"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

type GrupoResposta = { mostrar_grupos: boolean; waha: "ja_convergida" | "aplicada" | "nao_aplicada" };

/**
 * Chave por número (por QR) para ligar/desligar se as mensagens de grupo
 * entram na caixa de entrada. A rota (`/grupos`) é admin only e é quem decide
 * de verdade — aqui só refletimos o resultado dela.
 */
export function ChannelGroupsToggle({
  channelId,
  mostrarGrupos,
}: {
  channelId: string;
  mostrarGrupos: boolean;
}) {
  const t = useT();
  const id = useId();
  const qc = useQueryClient();
  const [checked, setChecked] = useState(mostrarGrupos);
  const [busy, setBusy] = useState(false);

  async function alternar(novo: boolean) {
    const anterior = checked;
    setChecked(novo);
    setBusy(true);
    try {
      const res = await apiClient.patch<{ data: GrupoResposta }>(
        `/api/v1/channel-sessions/${channelId}/grupos`,
        { mostrar_grupos: novo },
      );
      setChecked(res.data.mostrar_grupos);
      void qc.invalidateQueries({ queryKey: ["channel-sessions"] });
      if (res.data.waha === "nao_aplicada") {
        toast.warning(
          t(
            "Salvo. O WhatsApp não confirmou a mudança — use Reconectar neste número para aplicar.",
          ),
        );
      } else {
        toast.success(novo ? t("Grupos ligados neste número.") : t("Grupos desligados neste número."));
      }
    } catch {
      setChecked(anterior);
      toast.error(t("Não foi possível salvar a opção de grupos."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-2">
      <Switch id={id} checked={checked} disabled={busy} onCheckedChange={(v) => void alternar(v)} />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{t("Mostrar grupos na caixa de entrada")}</Label>
        <p className="text-xs text-muted-foreground">
          {t(
            "As mensagens dos grupos deste número chegam à caixa de entrada e a equipe responde por lá. Grupos não viram contato nem negócio, e a IA não responde neles.",
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("Grupos aumentam o volume de mensagens recebidas por este número.")}
        </p>
      </div>
    </div>
  );
}
