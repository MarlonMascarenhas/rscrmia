"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

const SITUACOES = ["ativa", "cortesia", "inadimplente", "cancelada", "expirada"] as const;

/** Soma `dias` a hoje e devolve `AAAA-MM-DD` — para os atalhos "+30 dias" e "+1 ano". */
function emDias(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * O formulário da porta manual.
 *
 * ═══ SEM PRAZO É UMA ESCOLHA EXPLÍCITA, NÃO UM CAMPO VAZIO ═══
 *
 * `liberado_ate = null` significa "não vence nunca", e é a decisão mais forte que
 * esta tela toma. Por isso é uma caixa de marcar com nome próprio, e não "deixe em
 * branco": um campo de data esquecido em branco virando "vitalício" seria o pior
 * erro possível para quem só queria liberar por um mês.
 *
 * ═══ O MOTIVO É OBRIGATÓRIO ═══
 *
 * Liberação sem razão escrita é o registro que, seis meses depois, ninguém sabe
 * explicar — e esta é a operação que mais precisa de explicação, porque contorna a
 * cobrança. O servidor recusa menos de 10 caracteres; a tela avisa antes.
 */
export function FormularioDeAssinatura({
  organizationId,
  planos,
  situacaoInicial,
  planoInicial,
  liberadoAteInicial,
}: {
  organizationId: string;
  planos: Array<{ id: string; nome: string; codigo: string }>;
  situacaoInicial: string;
  planoInicial: string;
  liberadoAteInicial: string;
}) {
  const t = useT();
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState(false);
  const [semPrazo, setSemPrazo] = useState(false);
  const [data, setData] = useState(liberadoAteInicial);

  const rotuloDaSituacao: Record<string, string> = {
    ativa: t("Ativa (pago)"),
    cortesia: t("Cortesia"),
    inadimplente: t("Inadimplente"),
    cancelada: t("Cancelada"),
    expirada: t("Expirada"),
  };

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);
    setFeito(false);
    const dados = new FormData(e.currentTarget);
    const motivo = String(dados.get("motivo") ?? "").trim();
    if (motivo.length < 10) {
      setErro(t("Escreva por que este acesso foi liberado à mão (pelo menos 10 letras)."));
      return;
    }
    if (!semPrazo && !data) {
      setErro(t("Escolha até quando, ou marque que não vence nunca."));
      return;
    }

    startTransition(async () => {
      const r = await fetch(`/api/v1/admin/tenants/${organizationId}/assinatura`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plano_id: String(dados.get("plano_id") ?? "") || null,
          situacao: String(dados.get("situacao") ?? "ativa"),
          // Fim do dia no fuso do navegador de quem libera: "até 30/09" tem de
          // valer o dia 30 inteiro, não parar à meia-noite do dia 29.
          liberado_ate: semPrazo ? null : new Date(`${data}T23:59:59`).toISOString(),
          motivo,
        }),
      });
      if (r.ok) {
        setFeito(true);
        router.refresh();
        return;
      }
      const j = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
      setErro(j?.error?.message ?? t("Não deu para salvar. Tente de novo em instantes."));
    });
  }

  return (
    <form onSubmit={enviar} className="space-y-4 border-t pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="plano_id">{t("Plano")}</Label>
          <select
            id="plano_id"
            name="plano_id"
            defaultValue={planoInicial}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t("Nenhum (produto inteiro, sem teto)")}</option>
            {planos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome} ({p.codigo})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="situacao">{t("Situação")}</Label>
          <select
            id="situacao"
            name="situacao"
            defaultValue={SITUACOES.includes(situacaoInicial as (typeof SITUACOES)[number]) ? situacaoInicial : "ativa"}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            {SITUACOES.map((s) => (
              <option key={s} value={s}>
                {rotuloDaSituacao[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="liberado_ate">{t("Liberado até")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="liberado_ate"
            type="date"
            value={data}
            disabled={semPrazo}
            onChange={(ev) => setData(ev.target.value)}
            className="w-44"
          />
          <Button type="button" size="sm" variant="outline" disabled={semPrazo} onClick={() => setData(emDias(30))}>
            {t("+30 dias")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={semPrazo} onClick={() => setData(emDias(365))}>
            {t("+1 ano")}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={semPrazo} onChange={(ev) => setSemPrazo(ev.target.checked)} />
          {t("Sem prazo: esta organização não vence nunca")}
        </label>
      </div>

      <div className="space-y-2">
        <Label htmlFor="motivo">{t("Motivo (obrigatório)")}</Label>
        <Input
          id="motivo"
          name="motivo"
          required
          minLength={10}
          maxLength={400}
          placeholder={t("Ex.: pagou R$ 197 por Pix em 25/09, comprovante no WhatsApp")}
        />
      </div>

      {erro ? (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      ) : null}
      {feito ? (
        <p role="status" className="text-sm text-emerald-600">
          {t("Acesso atualizado.")}
        </p>
      ) : null}

      <Button type="submit" disabled={pendente}>
        {pendente ? t("Salvando…") : t("Salvar liberação")}
      </Button>
    </form>
  );
}
