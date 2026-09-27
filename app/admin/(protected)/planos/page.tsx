import { notFound } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { env } from "@/lib/env";
import { contarOrganizacoesVencidas, lerConfigDeCobranca } from "@/lib/planos/config";
import { credenciaisDoStripe, stripePronto } from "@/lib/planos/stripe/cliente";
import { createAdminClient } from "@/lib/supabase/admin";

import { AcoesDoPlano } from "./_acoes";
import { CartaoDeCobranca } from "./_cobranca";
import { FormularioDePlano } from "./_form";

export const metadata = { title: "Planos" };
export const dynamic = "force-dynamic";

interface PlanoDaTela {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  libera_tudo: boolean;
  publicado_em: string | null;
  plano_capacidades: Array<{ capacidade: string }>;
  plano_limites: Array<{ limite: string; valor: number }>;
  plano_precos: Array<{
    intervalo: string;
    valor_cents: number;
    moeda: string;
    arquivado_em: string | null;
  }>;
}

/**
 * O CATÁLOGO DE PLANOS DA INSTALAÇÃO.
 *
 * Mora em `/admin`, e não em `/app/settings`, pela mesma razão de `/admin/marca`
 * e `/admin/cadastro`: o objeto é a INSTALAÇÃO. Um plano é oferecido a todas as
 * organizações, e deixar o admin de UMA empresa editar o que outra paga seria
 * dar a um cliente o controle sobre o preço de todos.
 *
 * `notFound()` e não `redirect('/403')`: para quem não administra a instalação,
 * esta tela não faz parte do produto (mesma decisão de `/admin/cadastro`). O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo é
 * redundante HOJE; fica porque a garantia precisa ser local, e um layout pode ser
 * movido.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const idioma = usuario.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const db = createAdminClient();
  const [config, vencidas, cred] = await Promise.all([
    lerConfigDeCobranca(db),
    contarOrganizacoesVencidas(db),
    credenciaisDoStripe(),
  ]);

  const { data } = await db
    .from("planos")
    .select(
      "id, codigo, nome, descricao, libera_tudo, publicado_em, " +
        "plano_capacidades(capacidade), plano_limites(limite, valor), " +
        "plano_precos(intervalo, valor_cents, moeda, arquivado_em)",
    )
    .is("arquivado_em", null)
    .order("ordem", { ascending: true })
    .order("created_at", { ascending: true });

  const planos = (data ?? []) as unknown as PlanoDaTela[];

  // Quantas organizações estão em cada plano — a confirmação de arquivar diz isso,
  // porque "vai sumir da vitrine" soa inofensivo até alguém descobrir que 40
  // clientes estão nele.
  const { data: emUso } = await db.from("assinaturas").select("plano_id");
  const contagem = new Map<string, number>();
  for (const a of (emUso ?? []) as Array<{ plano_id: string | null }>) {
    if (a.plano_id) contagem.set(a.plano_id, (contagem.get(a.plano_id) ?? 0) + 1);
  }
  const brl = (cents: number, moeda: string) =>
    new Intl.NumberFormat(idioma === "es" ? "es" : "pt-BR", {
      style: "currency",
      currency: moeda,
    }).format(cents / 100);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Planos")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O que a sua instalação vende. Cada organização escolhe entre os planos publicados.")}
        </p>
      </header>

      {/* Ligar, desligar e ajustar a cobrança mora AQUI, na cara de quem edita o
          catálogo: sem isso o dono cria planos, os vê na lista e conclui que já está
          vendendo — e a chave que decide isso morava só no banco. */}
      <CartaoDeCobranca
        inicial={config}
        vencidas={vencidas}
        stripe={{ pronto: stripePronto(cred), modo: cred.modo, temChave: cred.chave !== null, temWebhook: cred.segredoDoWebhook !== null }}
        urlDoWebhook={`${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/v1/webhooks/stripe`}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("Planos criados")}</CardTitle>
          <CardDescription>
            {t("Um plano nasce como rascunho e só aparece para o cliente depois de publicado.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {planos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Nenhum plano ainda. Crie o primeiro logo abaixo.")}
            </p>
          ) : (
            <ul className="space-y-3">
              {planos.map((p) => {
                const preco = p.plano_precos.find((x) => x.arquivado_em === null);
                return (
                  <li key={p.id} className="space-y-1 rounded-md border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium">
                        {p.nome}{" "}
                        <span className="font-mono text-xs text-muted-foreground">{p.codigo}</span>
                      </p>
                      <p className="text-sm">
                        {preco
                          ? `${brl(preco.valor_cents, preco.moeda)} / ${
                              preco.intervalo === "anual" ? t("ano") : t("mês")
                            }`
                          : t("sem preço")}
                        {" · "}
                        {p.publicado_em ? t("publicado") : t("rascunho")}
                      </p>
                    </div>
                    {p.descricao ? (
                      <p className="text-sm text-muted-foreground">{p.descricao}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {p.libera_tudo
                        ? t("Libera tudo, inclusive o que for criado depois.")
                        : `${p.plano_capacidades.length} ${t("capacidades")} · ${p.plano_limites.length} ${t("limites")}`}
                    </p>
                    <AcoesDoPlano
                      publicado={!!p.publicado_em}
                      organizacoes={contagem.get(p.id) ?? 0}
                      plano={{
                        id: p.id,
                        codigo: p.codigo,
                        nome: p.nome,
                        descricao: p.descricao,
                        libera_tudo: p.libera_tudo,
                        capacidades: p.plano_capacidades.map((c) => c.capacidade),
                        limites: p.plano_limites.map((l) => ({ limite: l.limite, valor: Number(l.valor) })),
                        preco: preco ? { intervalo: preco.intervalo, valor_cents: Number(preco.valor_cents) } : null,
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <FormularioDePlano />
    </div>
  );
}
