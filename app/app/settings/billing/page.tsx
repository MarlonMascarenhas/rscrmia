import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { emailDeSuporte } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerPainelDoCliente } from "@/lib/planos/painel";
import { credenciaisDoStripe, stripePronto } from "@/lib/planos/stripe/cliente";
import { createAdminClient } from "@/lib/supabase/admin";

import { BotaoAssinar, BotoesDaAssinatura } from "./_acoes";

export const dynamic = "force-dynamic";

/**
 * A TELA DE COBRANÇA DO CLIENTE.
 *
 * O endereço de contato é o de quem OPERA a instalação (`SUPPORT_EMAIL`), nunca o
 * nosso: esta tela tem porta de 1ª classe no menu e, num produto white-label,
 * entregar o nosso contato ao cliente do revendedor é ativamente errado — quem
 * cobra é o revendedor, e escrever para nós não desbloqueia nada. Sem o endereço
 * configurado, nenhum aparece.
 *
 * Mora em `app/app/`, cujo layout redireciona a organização vencida para
 * `/assinatura-vencida`. Isso não é problema: quem está bloqueado paga por LÁ, e
 * esta tela é a de quem está em dia e quer ver plano, uso e trocar.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  // spec 13 §4: billing é admin-only (viewer/agent/manager = none).
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { checkout } = await searchParams;

  const db = createAdminClient();
  const [painel, suporte, cred] = await Promise.all([
    lerPainelDoCliente(db, activeOrg.orgId),
    emailDeSuporte(),
    credenciaisDoStripe(),
  ]);
  const { estado } = painel;
  const online = stripePronto(cred);

  const dinheiro = (cents: number, moeda: string) =>
    new Intl.NumberFormat(user.idioma === "es" ? "es" : "pt-BR", { style: "currency", currency: moeda }).format(cents / 100);
  const dia = (d: Date | null) => (d ? d.toLocaleDateString(user.idioma === "es" ? "es" : "pt-BR") : null);

  const contato = suporte ? (
    <a className="underline" href={`mailto:${suporte}`}>
      {suporte}
    </a>
  ) : null;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Cobrança")}</h1>
        <p className="text-sm text-muted-foreground">{t("Planos, faturas e cobrança.")}</p>
      </header>

      {checkout === "ok" ? (
        <Card className="max-w-2xl border-emerald-500/40 p-4 text-sm" role="status">
          {t("Pagamento recebido. O acesso é liberado assim que o provedor confirma, o que costuma levar alguns segundos.")}
        </Card>
      ) : null}
      {checkout === "cancelado" ? (
        <Card className="max-w-2xl p-4 text-sm" role="status">
          {t("Você saiu do pagamento sem concluir. Nada foi cobrado.")}
        </Card>
      ) : null}

      {/* ── ONDE VOCÊ ESTÁ ──────────────────────────────────────────────── */}
      <Card className="max-w-2xl space-y-3 p-6">
        <h2 className="text-sm font-semibold">{t("Sua assinatura")}</h2>
        {!estado.cobrancaLigada ? (
          <p className="text-sm text-muted-foreground">
            {t("Esta instalação não cobra por assinatura: todos os recursos estão liberados.")}
          </p>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t("Plano")}</dt>
              <dd className="font-medium">{painel.planoAtual?.nome ?? t("Teste com tudo liberado")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("Acesso")}</dt>
              <dd className="font-medium">
                {estado.acesso.motivo === "em_teste"
                  ? `${t("Em teste")} · ${estado.acesso.diasRestantes ?? 0} ${t("dias restantes")}`
                  : estado.acesso.motivo === "em_carencia"
                    ? t("Pagamento pendente — atualize o cartão")
                    : estado.acesso.motivo === "sem_prazo"
                      ? t("Sem prazo de vencimento")
                      : estado.acesso.liberado
                        ? t("Ativo")
                        : t("Bloqueado")}
              </dd>
            </div>
            {estado.acesso.expiraEm && estado.acesso.motivo !== "sem_prazo" ? (
              <div>
                <dt className="text-xs text-muted-foreground">{t("Renova / vence em")}</dt>
                <dd className="font-medium">{dia(estado.acesso.expiraEm)}</dd>
              </div>
            ) : null}
          </dl>
        )}

        {estado.cobrancaLigada && painel.temAssinaturaNoProvedor && online ? (
          <BotoesDaAssinatura podeCancelar={painel.situacao === "ativa" || painel.situacao === "inadimplente"} />
        ) : null}
        {estado.cobrancaLigada && !painel.temAssinaturaNoProvedor && painel.situacao !== null ? (
          <p className="text-xs text-muted-foreground">
            {t("Seu acesso foi liberado por quem administra o sistema. Para mudar ou cancelar, fale com essa pessoa.")}{" "}
            {contato}
          </p>
        ) : null}
      </Card>

      {/* ── O QUE O PLANO INCLUI E QUANTO VOCÊ USA ──────────────────────── */}
      {estado.cobrancaLigada && !estado.liberaTudo && (painel.uso.length > 0 || painel.incluidas.length > 0) ? (
        <Card className="max-w-2xl space-y-4 p-6">
          {painel.uso.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">{t("Uso do plano")}</h2>
              {painel.uso.map((u) => {
                const pct = u.uso === null ? 0 : Math.min(100, Math.round((u.uso / u.teto) * 100));
                return (
                  <div key={u.limite} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{t(u.rotulo)}</span>
                      <span className="tabular-nums">
                        {/* Não medido diz que não mediu — nunca mostra zero. */}
                        {u.uso === null ? t("não foi possível medir agora") : `${u.uso} / ${u.teto}`}
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-md bg-muted"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={t(u.rotulo)}
                    >
                      <div className={pct >= 90 ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          {painel.incluidas.length > 0 ? (
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">{t("O que o seu plano inclui")}</h2>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {painel.incluidas.map((r) => (
                  <li key={r}>{t(r)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ── PLANOS DISPONÍVEIS ──────────────────────────────────────────── */}
      {estado.cobrancaLigada && painel.vitrine.length > 0 ? (
        <section className="max-w-2xl space-y-3">
          <h2 className="text-sm font-semibold">{t("Planos disponíveis")}</h2>
          <ul className="space-y-3">
            {painel.vitrine.map((p) => (
              <li key={p.id}>
                <Card className="space-y-2 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium">
                      {p.nome} {p.atual ? <span className="text-xs text-muted-foreground">({t("seu plano")})</span> : null}
                    </p>
                    {p.liberaTudo ? <span className="text-xs text-muted-foreground">{t("Tudo liberado")}</span> : null}
                  </div>
                  {p.descricao ? <p className="text-sm text-muted-foreground">{p.descricao}</p> : null}
                  <div className="flex flex-wrap gap-4">
                    {(["mensal", "anual"] as const).map((iv) => {
                      const preco = p.precos[iv];
                      if (!preco) return null;
                      const rotulo = `${dinheiro(preco.valorCents, preco.moeda)} ${iv === "anual" ? t("/ano") : t("/mês")}`;
                      return online && !p.atual ? (
                        <BotaoAssinar key={iv} planoId={p.id} intervalo={iv} rotulo={`${t("Assinar")} · ${rotulo}`} />
                      ) : (
                        <span key={iv} className="text-sm">
                          {rotulo}
                        </span>
                      );
                    })}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          {!online ? (
            <p className="text-sm text-muted-foreground">
              {t("O pagamento online ainda não está ligado nesta instalação. Para assinar, fale com quem administra o sistema.")}{" "}
              {contato}
            </p>
          ) : null}
        </section>
      ) : null}

      {!suporte && estado.cobrancaLigada ? (
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t("Para questões de pagamento, fale com quem administra este sistema.")}
        </p>
      ) : null}
    </div>
  );
}
