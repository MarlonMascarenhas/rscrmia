"use client";

import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/types";
import { useExcluirTenant } from "@/hooks/useExcluirTenant";
import { useT } from "@/hooks/i18n/useT";

/** O que a tela já sabe da empresa; o que não souber, não é mostrado (nunca inventado). */
export interface ContagensDaEmpresa {
  usuarios?: number;
  conversas?: number;
  mensagens?: number;
  leads?: number;
}

interface ExcluirEmpresaDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  slug: string;
  displayName: string;
  contagens?: ContagensDaEmpresa;
  /** Chamado depois de a exclusão ser confirmada pelo servidor. */
  onExcluida?: () => void;
}

function MensagemDeBloqueio({ erro }: { erro: unknown }) {
  const t = useT();
  let texto = t("Não foi possível excluir agora. Tente de novo.");
  if (erro instanceof ApiError) {
    if (erro.code === "assinatura_ativa") {
      texto = t("Esta empresa tem uma assinatura ativa. Cancele a assinatura antes de excluir a empresa.");
    } else if (erro.code === "tenant_em_acompanhamento") {
      texto = t("Há um acompanhamento de suporte aberto nesta empresa. Encerre o acompanhamento antes de excluir.");
    } else if (erro.code === "slug_nao_confere") {
      texto = t("O texto digitado não é igual ao slug da empresa. Nada foi apagado.");
    } else if (erro.status === 404) {
      texto = t("Esta empresa não existe mais.");
    }
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      {texto}
    </p>
  );
}

export function ExcluirEmpresaDialog({
  open,
  onClose,
  organizationId,
  slug,
  displayName,
  contagens,
  onExcluida,
}: ExcluirEmpresaDialogProps) {
  const t = useT();
  const [digitado, setDigitado] = useState("");
  const mutation = useExcluirTenant();
  const confere = digitado === slug;

  const linhas: string[] = [];
  if (contagens?.usuarios !== undefined) linhas.push(`${t("Usuários")}: ${contagens.usuarios}`);
  if (contagens?.conversas !== undefined) linhas.push(`${t("Conversas")}: ${contagens.conversas}`);
  if (contagens?.mensagens !== undefined) linhas.push(`${t("Mensagens")}: ${contagens.mensagens}`);
  if (contagens?.leads !== undefined) linhas.push(`Leads: ${contagens.leads}`);

  function fechar() {
    setDigitado("");
    mutation.reset();
    onClose();
  }

  function confirmar() {
    mutation.mutate(
      { id: organizationId, confirmacaoSlug: digitado },
      {
        onSuccess: (resposta) => {
          const falhas = resposta.data?.limpeza?.falhas ?? [];
          if (falhas.length > 0) {
            toast.warning(t("Empresa excluída, mas a limpeza de arquivos ou conexões não terminou."), {
              description: falhas.join(" "),
            });
          } else {
            toast.success(t("Empresa excluída."));
          }
          setDigitado("");
          onClose();
          onExcluida?.();
        },
      },
    );
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(aberto) => {
        if (!aberto) fechar();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Excluir empresa?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("{empresa} será excluída agora, de forma definitiva. Não dá para desfazer.").replace(
              "{empresa}",
              displayName,
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          <p>
            <strong>{t("O que é apagado:")}</strong>{" "}
            {t("conversas, mensagens, contatos, leads, agentes, conexões de WhatsApp e mídias.")}
          </p>
          <p>
            <strong>{t("O que fica:")}</strong>{" "}
            {t("as contas das pessoas (só perdem o vínculo com a empresa) e a auditoria.")}
          </p>
          {linhas.length > 0 && <p className="text-muted-foreground">{linhas.join(" · ")}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="excluir-empresa-confirmacao" className="block text-sm">
            {t("Digite {valor} para confirmar").replace("{valor}", slug)}
          </label>
          <Input
            id="excluir-empresa-confirmacao"
            value={digitado}
            onChange={(e) => setDigitado(e.target.value)}
            autoComplete="off"
          />
        </div>

        {mutation.isError && <MensagemDeBloqueio erro={mutation.error} />}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>{t("Cancelar")}</AlertDialogCancel>
          <Button variant="destructive" onClick={confirmar} disabled={!confere || mutation.isPending}>
            {mutation.isPending ? t("Excluindo...") : t("Excluir empresa")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
