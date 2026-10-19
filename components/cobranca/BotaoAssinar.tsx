"use client";

import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { documentoValido, mascararDocumento } from "@/lib/planos/asaas/documento";

/**
 * O BOTÃO DE ASSINAR — chama o checkout e SEGUE a URL da fatura que a rota devolve.
 *
 * Extraído de `app/app/settings/billing/_acoes.tsx` (que continua a usá-lo) para
 * ser reutilizado por `app/assinatura-vencida/page.tsx`: quem está bloqueado por
 * teste vencido também precisa poder assinar, sem duplicar a chamada.
 *
 * O Asaas exige o CPF/CNPJ do pagador. Quando a organização AINDA não tem cliente
 * no Asaas (`precisaDocumento`), o clique abre um diálogo pedindo nome e CPF/CNPJ
 * (com dígito verificador); o número vai só à rota do checkout, que o repassa ao
 * Asaas e não o guarda. Quem já tem cliente assina com um clique. A forma de pagar
 * (Pix, boleto ou cartão) o cliente escolhe na fatura do Asaas — nada do que ele
 * digita lá passa por aqui.
 */
export function BotaoAssinar({
  planoId,
  intervalo,
  rotulo,
  precisaDocumento = false,
}: {
  planoId: string;
  intervalo: "mensal" | "anual";
  rotulo: string;
  precisaDocumento?: boolean;
}) {
  const t = useT();
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [documento, setDocumento] = useState("");

  function assinar(pagador: { nome: string; documento: string } | null) {
    startTransition(async () => {
      setErro(null);
      const r = await fetch("/api/v1/cobranca/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plano_id: planoId, intervalo, ...(pagador ?? {}) }),
      });
      const j = (await r.json().catch(() => null)) as
        | { data?: { url?: string }; error?: { message?: string } }
        | null;
      if (r.ok && j?.data?.url) window.location.assign(j.data.url);
      else setErro(j?.error?.message ?? t("Não foi possível iniciar o pagamento agora. Tente de novo em instantes."));
    });
  }

  function enviarDocumento(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (nome.trim() === "") {
      setErro(t("Informe o nome."));
      return;
    }
    if (!documentoValido(documento)) {
      setErro(t("CPF ou CNPJ inválido. Confira os números."));
      return;
    }
    assinar({ nome: nome.trim(), documento });
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        disabled={pendente}
        onClick={() => {
          setErro(null);
          if (precisaDocumento) setAberto(true);
          else assinar(null);
        }}
      >
        {pendente && !aberto ? t("Abrindo…") : rotulo}
      </Button>
      {erro && !aberto ? (
        <p role="alert" className="text-xs text-destructive">
          {erro}
        </p>
      ) : null}

      {precisaDocumento ? (
        <Dialog open={aberto} onOpenChange={(v) => !pendente && setAberto(v)}>
          <DialogContent>
            <form onSubmit={enviarDocumento} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{t("Dados para a cobrança")}</DialogTitle>
                <DialogDescription>
                  {t("O Asaas, que emite a fatura, exige o nome e o CPF ou CNPJ de quem paga. Não guardamos o número: ele vai direto para o Asaas.")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="assinar-nome">{t("Nome ou razão social")}</Label>
                <Input
                  id="assinar-nome"
                  value={nome}
                  maxLength={100}
                  autoComplete="name"
                  onChange={(e) => setNome(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="assinar-documento">{t("CPF ou CNPJ")}</Label>
                <Input
                  id="assinar-documento"
                  value={documento}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="000.000.000-00"
                  onChange={(e) => setDocumento(mascararDocumento(e.target.value))}
                />
              </div>
              {erro ? (
                <p role="alert" className="text-sm text-destructive">
                  {erro}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" disabled={pendente} onClick={() => setAberto(false)}>
                  {t("Voltar")}
                </Button>
                <Button type="submit" disabled={pendente}>
                  {pendente ? t("Abrindo…") : t("Continuar para o pagamento")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
