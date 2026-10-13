"use client";
import { useContext, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import Link from "next/link";
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
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chamado após a exclusão: quem usa tira a conversa da tela e da lista. */
  onDeleted: () => void;
}

/**
 * EXCLUIR CONVERSA — pede a senha da organização (Configurações › Atendimento).
 *
 * `fetch` direto e não `apiClient`: o cliente repete 429 dormindo o `Retry-After`
 * (15 min aqui), o que penduraria o botão; e a senha vai no CORPO, nunca na URL.
 */
export function ExcluirConversaDialog({ conversationId, open, onOpenChange, onDeleted }: Props) {
  const t = useT();
  // Contexto direto (não `useQueryClient`): sem provider devolve undefined em vez de lançar.
  const qc = useContext(QueryClientContext);
  const [senha, setSenha] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<"incorreta" | "sem_senha" | "muitas" | "outro" | null>(null);

  function fechar(aberto: boolean) {
    if (enviando) return;
    if (!aberto) {
      setSenha("");
      setErro(null);
    }
    onOpenChange(aberto);
  }

  async function excluir(e: React.FormEvent) {
    e.preventDefault();
    if (enviando || senha.length === 0) return;
    setEnviando(true);
    setErro(null);
    try {
      const res = await fetch(`/api/v1/conversations/${conversationId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password: senha }),
      });
      if (res.ok) {
        toast.success(t("Conversa excluída."));
        qc?.removeQueries({ queryKey: ["conversation", conversationId] });
        void qc?.invalidateQueries({ queryKey: ["conversations"] });
        setSenha("");
        onOpenChange(false);
        onDeleted();
        return;
      }
      if (res.status === 403) setErro("incorreta");
      else if (res.status === 409) setErro("sem_senha");
      else if (res.status === 429) setErro("muitas");
      else if (res.status === 404) {
        // Já não existe (outra pessoa excluiu): a tela só precisa se acertar.
        toast.error(t("Conversa não encontrada."));
        void qc?.invalidateQueries({ queryKey: ["conversations"] });
        onOpenChange(false);
        onDeleted();
        return;
      } else setErro("outro");
    } catch {
      setErro("outro");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={fechar}>
      <AlertDialogContent>
        <form onSubmit={excluir} className="space-y-4">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Excluir esta conversa?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "As mensagens e os arquivos desta conversa serão apagados e não tem como desfazer. Digite a senha de exclusão da organização para confirmar.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor="senha_excluir_conversa">{t("Senha de exclusão")}</Label>
            <Input
              id="senha_excluir_conversa"
              type="password"
              autoComplete="off"
              autoFocus
              value={senha}
              disabled={enviando}
              onChange={(ev) => setSenha(ev.target.value)}
            />
            {erro === "incorreta" && (
              <p role="alert" className="text-xs text-destructive">{t("Senha incorreta.")}</p>
            )}
            {erro === "sem_senha" && (
              <p role="alert" className="text-xs text-destructive">
                {t(
                  "Nenhuma senha configurada. Peça ao administrador para definir em Configurações › Atendimento.",
                )}{" "}
                <Link href="/app/settings/atendimento" className="underline">
                  {t("Abrir Configurações › Atendimento")}
                </Link>
              </p>
            )}
            {erro === "muitas" && (
              <p role="alert" className="text-xs text-destructive">
                {t("Muitas tentativas. Aguarde alguns minutos.")}
              </p>
            )}
            {erro === "outro" && (
              <p role="alert" className="text-xs text-destructive">
                {t("Não consegui excluir agora. Tente de novo.")}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enviando}>{t("Cancelar")}</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={enviando || senha.length === 0}>
              {enviando ? t("Excluindo...") : t("Excluir conversa")}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
