"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { CAPACIDADES_DE_PLANO, PORTA_DA_CAPACIDADE } from "@/lib/planos/capacidades";
import { FORMA_DO_LIMITE, LIMITES_DE_PLANO } from "@/lib/planos/limites";

/** O que a tela sabe de um plano que já existe, para pré-preencher a edição. */
export interface PlanoParaEditar {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  libera_tudo: boolean;
  capacidades: string[];
  limites: Array<{ limite: string; valor: number }>;
  /** Preço vigente, se houver. */
  preco: { intervalo: string; valor_cents: number } | null;
}

/**
 * A lista de capacidades e a de limites saem das MESMAS constantes que o gate
 * consome (`lib/planos/capacidades.ts`, `limites.ts`) — nunca de uma cópia aqui.
 *
 * É a defesa contra o defeito do cabeçalho de `orcamento.ts`: a tela oferecer o
 * que o enforcement não conhece. Capacidade acrescentada lá aparece aqui sozinha;
 * capacidade removida lá some daqui no mesmo build.
 *
 * O MESMO formulário cria e edita: dois formulários divergiriam, e o de edição
 * esqueceria o campo que o de criação ganhou.
 */
export function FormularioDePlano({
  plano,
  aoSalvar,
}: {
  plano?: PlanoParaEditar;
  aoSalvar?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const editando = plano !== undefined;
  const [pendente, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [feito, setFeito] = useState(false);

  const [liberaTudo, setLiberaTudo] = useState(plano?.libera_tudo ?? false);
  const [capacidades, setCapacidades] = useState<Set<string>>(new Set(plano?.capacidades ?? []));
  const limiteAtual = (l: string) => plano?.limites.find((x) => x.limite === l)?.valor;

  function alternar(cap: string, ligado: boolean) {
    setCapacidades((atual) => {
      const novo = new Set(atual);
      if (ligado) novo.add(cap);
      else novo.delete(cap);
      return novo;
    });
  }

  function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null);
    setFeito(false);
    const formulario = e.currentTarget;
    const dados = new FormData(formulario);

    // Limite em branco = SEM LIMITE (nenhuma linha). Zero é recusado pelo schema e
    // pelo CHECK do banco: zero não é "sem limite", é "não pode nada", e um zero
    // digitado por engano travaria a organização inteira.
    const limites = LIMITES_DE_PLANO.flatMap((limite) => {
      const bruto = String(dados.get(`limite_${limite}`) ?? "").trim();
      return bruto === "" ? [] : [{ limite, valor: Number(bruto) }];
    });

    const reais = String(dados.get("preco") ?? "").trim().replace(",", ".");
    const precos =
      reais === ""
        ? []
        : [
            {
              intervalo: String(dados.get("intervalo") ?? "mensal"),
              // Centavos inteiros: nunca float. `Math.round` porque 19,9 * 100
              // é 1989.9999999999998 em ponto flutuante.
              valor_cents: Math.round(Number(reais) * 100),
              moeda: "BRL",
            },
          ];

    const corpo = {
      ...(editando ? {} : { codigo: String(dados.get("codigo") ?? "").trim() }),
      nome: String(dados.get("nome") ?? "").trim(),
      descricao: String(dados.get("descricao") ?? "").trim() || null,
      libera_tudo: liberaTudo,
      capacidades: liberaTudo ? [] : [...capacidades],
      limites: liberaTudo ? [] : limites,
      precos,
    };

    startTransition(async () => {
      const r = await fetch(editando ? `/api/v1/admin/planos/${plano.id}` : "/api/v1/admin/planos", {
        method: editando ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      if (r.ok) {
        setFeito(true);
        if (!editando) {
          formulario.reset();
          setLiberaTudo(false);
          setCapacidades(new Set());
        }
        router.refresh();
        aoSalvar?.();
        return;
      }
      const resposta = (await r.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      setErro(
        resposta?.error?.code === "state_conflict" && !editando
          ? t("Já existe um plano com este código. Escolha outro.")
          : (resposta?.error?.message ?? t("Não deu para salvar. Tente de novo em instantes.")),
      );
    });
  }

  const corpoDoFormulario = (
    <form onSubmit={enviar} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`nome-${plano?.id ?? "novo"}`}>{t("Nome")}</Label>
          <Input
            id={`nome-${plano?.id ?? "novo"}`}
            name="nome"
            required
            maxLength={120}
            defaultValue={plano?.nome}
            placeholder="Profissional"
          />
        </div>
        {editando ? null : (
          <div className="space-y-2">
            <Label htmlFor="codigo">{t("Código")}</Label>
            <Input
              id="codigo"
              name="codigo"
              required
              pattern="[a-z][a-z0-9_]{1,31}"
              placeholder="profissional"
              aria-describedby="codigo-ajuda"
            />
            <p id="codigo-ajuda" className="text-xs text-muted-foreground">
              {t("Minúsculas, números e _. Não muda depois de criado.")}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`descricao-${plano?.id ?? "novo"}`}>{t("Descrição")}</Label>
        <Input
          id={`descricao-${plano?.id ?? "novo"}`}
          name="descricao"
          maxLength={600}
          defaultValue={plano?.descricao ?? ""}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`preco-${plano?.id ?? "novo"}`}>{t("Preço (R$)")}</Label>
          <Input
            id={`preco-${plano?.id ?? "novo"}`}
            name="preco"
            inputMode="decimal"
            placeholder="197,00"
            defaultValue={plano?.preco ? (plano.preco.valor_cents / 100).toFixed(2).replace(".", ",") : ""}
          />
          {editando ? (
            <p className="text-xs text-muted-foreground">
              {t("Mudar o valor cria um preço novo. Quem já assinou continua no preço que assinou.")}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`intervalo-${plano?.id ?? "novo"}`}>{t("Cobrado")}</Label>
          <select
            id={`intervalo-${plano?.id ?? "novo"}`}
            name="intervalo"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            defaultValue={plano?.preco?.intervalo ?? "mensal"}
          >
            <option value="mensal">{t("por mês")}</option>
            <option value="anual">{t("por ano")}</option>
          </select>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor={`libera-tudo-${plano?.id ?? "novo"}`} className="text-base">
            {t("Libera tudo")}
          </Label>
          <p className="text-sm text-muted-foreground">
            {t("Inclui toda capacidade, inclusive as que forem criadas depois, e não tem teto nenhum.")}
          </p>
        </div>
        <Switch id={`libera-tudo-${plano?.id ?? "novo"}`} checked={liberaTudo} onCheckedChange={setLiberaTudo} />
      </div>

      {liberaTudo ? null : (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("O que o plano inclui")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CAPACIDADES_DE_PLANO.map((cap) => (
                <label key={cap} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={capacidades.has(cap)}
                    onChange={(ev) => alternar(cap, ev.target.checked)}
                  />
                  {t(PORTA_DA_CAPACIDADE[cap].rotulo)}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Tetos")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("Deixe em branco para não ter teto. Zero não vale: use o teto que você quer.")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {LIMITES_DE_PLANO.map((limite) => (
                <div key={limite} className="space-y-1">
                  <Label htmlFor={`limite_${limite}-${plano?.id ?? "novo"}`} className="text-xs">
                    {t(FORMA_DO_LIMITE[limite].rotulo)}
                  </Label>
                  <Input
                    id={`limite_${limite}-${plano?.id ?? "novo"}`}
                    name={`limite_${limite}`}
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    defaultValue={limiteAtual(limite) ?? ""}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        </>
      )}

      {erro ? (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      ) : null}
      {feito ? (
        <p role="status" className="text-sm text-emerald-600">
          {editando ? t("Plano atualizado.") : t("Plano criado como rascunho.")}
        </p>
      ) : null}

      <Button type="submit" disabled={pendente}>
        {pendente ? t("Salvando…") : editando ? t("Salvar alterações") : t("Criar plano")}
      </Button>
    </form>
  );

  // Editando, o formulário vive dentro do item da lista, sem cartão próprio.
  if (editando) return corpoDoFormulario;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Novo plano")}</CardTitle>
        <CardDescription>{t("Nasce como rascunho: o cliente só o vê depois de publicado.")}</CardDescription>
      </CardHeader>
      <CardContent>{corpoDoFormulario}</CardContent>
    </Card>
  );
}
