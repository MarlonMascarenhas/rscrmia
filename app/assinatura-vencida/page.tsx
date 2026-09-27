import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { emailDeSuporte } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { estadoDeCobrancaDoPedido } from "@/lib/planos/pedido";
import { createAdminClient } from "@/lib/supabase/admin";

import { trocarDeOrganizacao } from "./_actions";

export const metadata = {
  title: "Assinatura vencida",
};

/**
 * A TELA DE BLOQUEIO, E POR QUE ELA É AUTOSSUFICIENTE.
 *
 * Mora FORA de `app/app/`, como `app/account-suspended/`, e isso não é
 * organização de pastas — é o que faz a porta de saída funcionar.
 *
 * A tentativa óbvia seria mandar quem está bloqueado para `/app/settings/billing`.
 * Ela falha por duas vias: aquela tela vive dentro de `app/app/layout.tsx`, que é
 * justamente quem redireciona para cá (o laço se fecha sobre si mesmo); e se o
 * layout abrisse uma exceção por caminho, o usuário chegaria lá COM a navegação
 * do produto ao lado e, num clique de navegação client-side, o layout não roda de
 * novo — o bloqueio vazaria. Então tudo o que uma conta trancada precisa está
 * AQUI, e nada aqui depende do interruptor que a trancou.
 *
 * É a decisão (b) de `lib/voice/guarda.ts:11-21` — "a porta de saída nunca
 * depende da coisa ligada" — no caso em que ela mais importa: se quem está
 * trancado não consegue pagar, o bloqueio deixa de ser cobrança e passa a ser
 * perda do cliente.
 *
 * Marca: o endereço é o de quem OPERA a instalação (`emailDeSuporte()`), nunca o
 * nosso — quem cobra é o revendedor, e escrever para nós não desbloqueia nada. É
 * a mesma regra que `app/account-suspended/page.tsx:13-20` e
 * `app/app/settings/billing/page.tsx` já registram.
 */
export default async function AssinaturaVencidaPage() {
  const user = await loadAuthUser();
  if (!user) redirect("/login?next=/assinatura-vencida");

  const org = await resolveActiveOrg(user);
  if (!org) redirect("/get-started");

  const estado = await estadoDeCobrancaDoPedido(org.orgId);

  // Quem chegou aqui e já está em dia volta ao produto. Sem isto, alguém que
  // pagou ficaria preso numa tela que afirma uma parada que não existe mais — e
  // o laço de retorno é o invariante 7 do Sistema Vivo.
  if (estado.acesso.liberado) redirect("/app/inbox");

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const suporte = await emailDeSuporte();
  const outras = user.organizations.filter((o) => o.organization_id !== org.orgId);

  // Os planos ofertáveis, para a pessoa saber o que pedir. Cliente admin porque
  // `planos` é tabela da INSTALAÇÃO, sem policy — e o que se mostra é só o que
  // está publicado e não arquivado.
  const { data: planos } = await createAdminClient()
    .from("planos")
    .select("id, nome, descricao, plano_precos(valor_cents, moeda, intervalo, arquivado_em)")
    .not("publicado_em", "is", null)
    .is("arquivado_em", null)
    .order("ordem", { ascending: true });

  const titulo =
    estado.acesso.motivo === "teste_vencido"
      ? t("Seu período de teste terminou")
      : estado.acesso.motivo === "inadimplente"
        ? t("O último pagamento não foi concluído")
        : estado.acesso.motivo === "cancelada"
          ? t("A assinatura foi cancelada")
          : t("A assinatura não está ativa");

  // A frase diz o que FAZER, e cada motivo pede uma coisa diferente. Uma frase
  // só mandaria parte das pessoas resolver o problema errado.
  const explicacao =
    estado.acesso.motivo === "teste_vencido"
      ? t("Escolha um plano para continuar usando o sistema. Seus dados estão salvos e nada foi apagado.")
      : estado.acesso.motivo === "inadimplente"
        ? t("Atualize a forma de pagamento para reativar o acesso. Seus dados estão salvos e nada foi apagado.")
        : t("Reative a assinatura para continuar. Seus dados estão salvos e nada foi apagado.");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-lg space-y-6 p-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{titulo}</h1>
          <p className="text-sm text-muted-foreground">{explicacao}</p>
        </header>

        {planos && planos.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t("Planos disponíveis")}</h2>
            <ul className="space-y-2">
              {planos.map((p) => {
                const preco = (
                  p.plano_precos as Array<{
                    valor_cents: number;
                    moeda: string;
                    intervalo: string;
                    arquivado_em: string | null;
                  }> | null
                )?.find((x) => x.arquivado_em === null);
                return (
                  <li
                    key={p.id as string}
                    className="flex items-baseline justify-between gap-4 rounded-md border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{p.nome as string}</p>
                      {p.descricao ? (
                        <p className="text-xs text-muted-foreground">{p.descricao as string}</p>
                      ) : null}
                    </div>
                    {preco ? (
                      <p className="shrink-0 text-sm font-semibold">
                        {new Intl.NumberFormat(idioma === "es" ? "es" : "pt-BR", {
                          style: "currency",
                          currency: preco.moeda,
                        }).format(preco.valor_cents / 100)}
                        <span className="text-xs font-normal text-muted-foreground">
                          {preco.intervalo === "anual" ? t("/ano") : t("/mês")}
                        </span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {/* O caminho para pagar. Enquanto a cobrança automática não existe, quem
            fecha é quem opera a instalação — e a tela diz isso em vez de
            oferecer um botão que não leva a lugar nenhum. */}
        {suporte ? (
          <p className="text-sm">
            {t("Para regularizar, fale com")}{" "}
            <a
              href={`mailto:${suporte}`}
              className="underline underline-offset-4 transition-colors hover:text-foreground"
            >
              {suporte}
            </a>
            .
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("Fale com quem administra este sistema para regularizar o acesso.")}
          </p>
        )}

        {/* AS PORTAS DE SAÍDA — e só as que FUNCIONAM de verdade.
            Nenhum link para dentro de `app/app/`: aquele layout redireciona para
            cá, então um botão "Minha conta" apontando para lá seria uma porta que
            devolve a pessoa à parede. Porta quebrada é pior que porta ausente,
            porque ela promete. */}
        {outras.length > 0 ? (
          <section className="space-y-2 border-t pt-4">
            <h2 className="text-sm font-semibold">{t("Suas outras organizações")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("O bloqueio é desta organização. As outras seguem funcionando.")}
            </p>
            <ul className="space-y-1">
              {outras.map((o) => (
                <li key={o.organization_id}>
                  <form action={trocarDeOrganizacao}>
                    <input type="hidden" name="organization_id" value={o.organization_id} />
                    <Button type="submit" variant="outline" size="sm" className="w-full justify-start">
                      {o.organization_name}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="flex flex-wrap gap-2 border-t pt-4">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">{t("Sair")}</Link>
          </Button>
        </footer>
      </Card>
    </main>
  );
}
