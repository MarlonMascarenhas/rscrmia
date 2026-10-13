"use client";
/**
 * Seção "Senha para excluir conversas".
 *
 * Excluir conversa apaga as mensagens e a mídia — não tem volta. A senha é da
 * ORGANIZAÇÃO: o admin define, e quem atende (agent+) precisa dela para excluir.
 * Sem senha definida, a exclusão fica bloqueada. Só o admin vê o formulário; os
 * demais veem o estado.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { definirSenhaDeExclusaoDeConversa } from "@/app/actions/settings/senhaDeExclusaoDeConversa";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

export function SenhaDeExclusaoDeConversa({
  configuradaInicial,
  podeEditar,
}: {
  configuradaInicial: boolean;
  podeEditar: boolean;
}) {
  const t = useT();
  const [configurada, setConfigurada] = useState(configuradaInicial);
  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [isPending, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await definirSenhaDeExclusaoDeConversa({ senha, confirmacao });
      if (r.ok) {
        setConfigurada(true);
        setSenha("");
        setConfirmacao("");
        toast.success(t("Senha para excluir conversas salva."));
      } else {
        toast.error(t(r.erro));
      }
    });
  }

  return (
    <Card className="max-w-3xl space-y-4 p-4" data-testid="senha-de-exclusao">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("Senha para excluir conversas")}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "Excluir uma conversa apaga as mensagens e os arquivos dela, e não tem volta. Quem atende só consegue excluir sabendo esta senha. Sem senha definida, ninguém exclui.",
            )}
          </p>
        </div>
        <Badge variant={configurada ? "success" : "outline"} data-testid="senha-de-exclusao-status">
          {configurada ? t("Configurada") : t("Não configurada")}
        </Badge>
      </div>

      {podeEditar ? (
        <form onSubmit={salvar} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="senha_exclusao">{t("Nova senha")}</Label>
            <Input
              id="senha_exclusao"
              type="password"
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
              value={senha}
              disabled={isPending}
              onChange={(e) => setSenha(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="senha_exclusao_confirmacao">{t("Confirmar senha")}</Label>
            <Input
              id="senha_exclusao_confirmacao"
              type="password"
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
              value={confirmacao}
              disabled={isPending}
              onChange={(e) => setConfirmacao(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={isPending || senha.length === 0}>
              {isPending ? t("Salvando...") : t("Salvar")}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("Entre 6 e 128 caracteres. Salvar de novo troca a senha atual.")}
            </p>
          </div>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("Só um administrador pode definir ou trocar esta senha.")}
        </p>
      )}
    </Card>
  );
}
