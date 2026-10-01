"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

export interface EventoCaktoDaTela {
  chave: string;
  evento: string;
  pedido_id: string | null;
  recebido_em: string;
  resultado: string | null;
  erro: string | null;
}

/**
 * O FORMULÁRIO QUE LIGA UM EVENTO ÓRFÃO A UMA ORGANIZAÇÃO.
 *
 * Um evento chega sem dono (`resultado: "sem_organizacao"`) quando o pagador da
 * Cakto não casa com nenhum e-mail de admin da organização — o pagamento
 * aconteceu, mas o sistema não sabe para quem liberar. Aqui o dono da instalação
 * resolve isso à mão, pelo slug da organização certa.
 */
function FormularioDeVinculo({ chave }: { chave: string }) {
  const t = useT();
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [slug, setSlug] = useState("");
  const [resultado, setResultado] = useState<{ ok: boolean; mensagem: string } | null>(null);

  function vincular() {
    setResultado(null);
    startTransition(async () => {
      const r = await fetch("/api/v1/admin/cobranca/eventos/vincular", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chave, organization_slug: slug }),
      });
      const j = (await r.json().catch(() => null)) as
        | { data?: { resultado?: string }; error?: { message?: string } }
        | null;
      if (r.ok && j?.data) {
        setResultado({ ok: true, mensagem: j.data.resultado ?? t("Vinculado.") });
        router.refresh();
      } else {
        setResultado({ ok: false, mensagem: j?.error?.message ?? t("Não foi possível vincular agora. Tente de novo em instantes.") });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={t("slug da organização")}
          className="h-8 w-48 text-sm"
        />
      </div>
      <Button type="button" size="sm" variant="outline" disabled={pendente || !slug.trim()} onClick={vincular}>
        {pendente ? t("Vinculando…") : t("Vincular à organização")}
      </Button>
      {resultado ? (
        <span role={resultado.ok ? "status" : "alert"} className={resultado.ok ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
          {resultado.mensagem}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A LISTA DE PAGAMENTOS DA CAKTO QUE AINDA PRECISAM DE ATENÇÃO.
 *
 * Só os eventos PENDENTES aparecem aqui (`processado_em is null`, ou processados
 * sem organização/sem período/com assinatura antiga) — o resto já teve efeito e
 * não precisa de olho. Sem dado pessoal do pagador: a tabela não guarda nome nem
 * e-mail, só identificadores.
 */
export function EventosCakto({ eventos }: { eventos: EventoCaktoDaTela[] }) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Pagamentos da Cakto pendentes de ligação")}</CardTitle>
        <CardDescription>
          {t("Eventos que a Cakto avisou e o sistema não conseguiu ligar sozinho a uma organização, ou que ainda não foram processados.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {eventos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum pagamento pendente de ligação.")}</p>
        ) : (
          <ul className="space-y-3">
            {eventos.map((e) => (
              <li key={e.chave} className="space-y-2 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {e.evento}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{e.chave}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(e.recebido_em).toLocaleString(tagDeIdioma)}
                  </p>
                </div>
                {e.pedido_id ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Pedido")}: <span className="font-mono">{e.pedido_id}</span>
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {e.resultado ? e.resultado : t("não processado")}
                  {e.erro ? ` — ${t("com erro")}: ${e.erro}` : ""}
                </p>
                <FormularioDeVinculo chave={e.chave} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
