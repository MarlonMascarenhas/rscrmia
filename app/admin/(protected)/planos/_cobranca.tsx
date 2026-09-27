"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigDeCobranca } from "@/lib/planos/config";

/**
 * O CARTÃO QUE LIGA E AJUSTA A COBRANÇA.
 *
 * ═══ LIGAR MOSTRA O PREÇO ANTES ═══
 *
 * Ligar a cobrança é a decisão que muda quem trabalha. O cartão diz, antes do
 * clique, quantas organizações estão com o prazo já vencido e seriam trancadas na
 * hora — e exige a confirmação por escrito quando o número não é zero. O valor
 * fica inerte até alguém declarar a intenção, sabendo o que ela custa.
 */
export function CartaoDeCobranca({
  inicial,
  vencidas,
  stripe,
  urlDoWebhook,
}: {
  inicial: ConfigDeCobranca;
  /** `null` = não foi possível medir. */
  vencidas: number | null;
  stripe: { pronto: boolean; modo: string; temChave: boolean; temWebhook: boolean };
  urlDoWebhook: string;
}) {
  const t = useT();
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState(false);
  const [ligada, setLigada] = useState(inicial.ligada);
  const [confirmou, setConfirmou] = useState(false);

  const ligandoAgora = ligada && !inicial.ligada;
  const precisaConfirmar = ligandoAgora && (vencidas === null || vencidas > 0);

  function salvar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);
    setFeito(false);
    if (precisaConfirmar && !confirmou) {
      setErro(t("Confirme que você entende quantas organizações serão bloqueadas."));
      return;
    }
    const d = new FormData(e.currentTarget);
    const patch: Record<string, unknown> = {};
    if (ligada !== inicial.ligada) patch.ligada = ligada;
    const dias = Number(d.get("diasDeTeste"));
    if (dias !== inicial.diasDeTeste) patch.diasDeTeste = dias;
    const car = Number(d.get("carenciaDias"));
    if (car !== inicial.carenciaDias) patch.carenciaDias = car;
    const modo = String(d.get("modoDeLimite"));
    if (modo !== inicial.modoDeLimite) patch.modoDeLimite = modo;
    if (Object.keys(patch).length === 0) {
      setErro(t("Nada mudou."));
      return;
    }

    startTransition(async () => {
      const r = await fetch("/api/v1/admin/cobranca", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (r.ok) {
        setFeito(true);
        setConfirmou(false);
        router.refresh();
        return;
      }
      const j = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
      setErro(j?.error?.message ?? t("Não deu para salvar. Tente de novo em instantes."));
    });
  }

  return (
    <Card className={ligada ? "border-emerald-500/40" : "border-amber-500/40"}>
      <CardHeader>
        <CardTitle>{t("Cobrança")}</CardTitle>
        <CardDescription>
          {t("Liga o teste grátis, o bloqueio por vencimento e os limites dos planos. Desligada, nada é bloqueado, mesmo com plano criado.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={salvar} className="space-y-5">
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor="cobranca-ligada" className="text-base">
                {t("Cobrança ligada")}
              </Label>
              <p className="text-sm text-muted-foreground">
                {ligada
                  ? t("Organizações novas nascem com teste grátis, e quem vence vai para a tela de assinatura vencida.")
                  : t("Organizações criadas agora nascem sem prazo. O teste grátis só começa depois que você ligar.")}
              </p>
            </div>
            <Switch id="cobranca-ligada" checked={ligada} onCheckedChange={(v) => { setLigada(v); setConfirmou(false); }} />
          </div>

          {ligandoAgora ? (
            <div role="alert" className="space-y-2 rounded-lg border border-amber-500/50 p-4 text-sm">
              <p>
                <strong>
                  {vencidas === null
                    ? t("Não foi possível contar quantas organizações seriam bloqueadas.")
                    : vencidas === 0
                      ? t("Nenhuma organização será bloqueada agora.")
                      : `${vencidas} ${t("organização(ões) já estão com o prazo vencido e seriam bloqueadas agora.")}`}
                </strong>
              </p>
              {precisaConfirmar ? (
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={confirmou} onChange={(e) => setConfirmou(e.target.checked)} className="mt-1" />
                  {t("Entendo, e já avisei quem será afetado.")}
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="diasDeTeste">{t("Dias de teste grátis")}</Label>
              <Input id="diasDeTeste" name="diasDeTeste" type="number" min={1} max={365} defaultValue={inicial.diasDeTeste} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="carenciaDias">{t("Dias de carência")}</Label>
              <Input id="carenciaDias" name="carenciaDias" type="number" min={0} max={90} defaultValue={inicial.carenciaDias} />
              <p className="text-xs text-muted-foreground">{t("Quanto tempo o acesso segue depois de um pagamento falhar.")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="modoDeLimite">{t("Quando um limite é atingido")}</Label>
              <select
                id="modoDeLimite"
                name="modoDeLimite"
                defaultValue={inicial.modoDeLimite}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="off">{t("Ignorar")}</option>
                <option value="avisar">{t("Só avisar")}</option>
                <option value="bloquear">{t("Bloquear")}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t("Suba um degrau por vez: primeiro avisar, depois bloquear.")}</p>
            </div>
          </div>

          {erro ? (
            <p role="alert" className="text-sm text-destructive">
              {erro}
            </p>
          ) : null}
          {feito ? (
            <p role="status" className="text-sm text-emerald-600">
              {t("Configuração salva.")}
            </p>
          ) : null}
          <Button type="submit" disabled={pendente}>
            {pendente ? t("Salvando…") : t("Salvar")}
          </Button>
        </form>

        {/* ── O PAGAMENTO ONLINE ─────────────────────────────────────────── */}
        <div className="space-y-2 border-t pt-4 text-sm">
          <p className="font-medium">
            {t("Pagamento online (Stripe)")}:{" "}
            {stripe.pronto ? (
              <span className="text-emerald-600">
                {t("pronto")} · {stripe.modo === "teste" ? t("modo de TESTE — nenhum dinheiro de verdade") : t("modo de PRODUÇÃO")}
              </span>
            ) : (
              <span className="text-amber-600">{t("não configurado")}</span>
            )}
          </p>
          {!stripe.pronto ? (
            <p className="text-muted-foreground">
              {!stripe.temChave ? t("Falta a chave secreta. ") : ""}
              {!stripe.temWebhook ? t("Falta o segredo do webhook. ") : ""}
              {t("Cadastre em Credenciais › Cobrança (Stripe). Sem isso o cliente não assina sozinho, mas você segue liberando à mão.")}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {t("No painel do Stripe, o webhook deve apontar para")}{" "}
            <code className="rounded-md bg-muted px-1 py-0.5 text-xs">{urlDoWebhook}</code>{" "}
            {t("e enviar os eventos de checkout, assinatura e fatura.")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
