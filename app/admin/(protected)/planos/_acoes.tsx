"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

import { FormularioDePlano, type PlanoParaEditar } from "./_form";

/**
 * As ações de ciclo de vida de UM plano: editar, publicar/despublicar, arquivar.
 *
 * ═══ ARQUIVAR PEDE CONFIRMAÇÃO, E DIZ QUANTOS CLIENTES O USAM ═══
 *
 * Arquivar é lógico e sem volta pela tela (desarquivar não existe — se o plano
 * volta a ser vendido, cria-se outro). Quem já o tem continua com ele. A frase da
 * confirmação diz quantas organizações estão nele, porque "vai sumir da vitrine"
 * soa inofensivo até alguém descobrir que 40 clientes estão naquele plano.
 */
export function AcoesDoPlano({
  plano,
  publicado,
  organizacoes,
}: {
  plano: PlanoParaEditar;
  publicado: boolean;
  organizacoes: number;
}) {
  const t = useT();
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [editando, setEditando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function patch(corpo: Record<string, unknown>) {
    setErro(null);
    startTransition(async () => {
      const r = await fetch(`/api/v1/admin/planos/${plano.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        setErro(j?.error?.message ?? t("Não deu para salvar. Tente de novo em instantes."));
        return;
      }
      setConfirmando(false);
      router.refresh();
    });
  }

  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setEditando((v) => !v)}>
          {editando ? t("Fechar edição") : t("Editar")}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pendente} onClick={() => patch({ publicado: !publicado })}>
          {publicado ? t("Despublicar") : t("Publicar")}
        </Button>
        {confirmando ? (
          <>
            <span className="self-center text-xs text-muted-foreground">
              {organizacoes > 0
                ? `${organizacoes} ${t("organizações estão neste plano e continuam com ele. Arquivar não tem volta pela tela.")}`
                : t("Ninguém usa este plano. Arquivar não tem volta pela tela.")}
            </span>
            <Button type="button" size="sm" variant="destructive" disabled={pendente} onClick={() => patch({ arquivar: true })}>
              {t("Confirmar arquivamento")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
              {t("Cancelar")}
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmando(true)}>
            {t("Arquivar")}
          </Button>
        )}
      </div>

      {erro ? (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      ) : null}

      {editando ? (
        <div className="rounded-md border p-4">
          <FormularioDePlano plano={plano} aoSalvar={() => setEditando(false)} />
        </div>
      ) : null}
    </div>
  );
}
