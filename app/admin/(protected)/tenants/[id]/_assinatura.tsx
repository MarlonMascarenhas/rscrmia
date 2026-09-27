import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerEstadoDeCobranca } from "@/lib/planos/estado";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDeAssinatura } from "./_assinatura-form";

/**
 * A ASSINATURA DE UMA ORGANIZAÇÃO, VISTA POR QUEM ADMINISTRA A INSTALAÇÃO.
 *
 * É a porta manual do dono: Pix por fora, cortesia, acordo, webhook que falhou.
 * Sem ela, o desfecho nesses casos é mexer no banco à mão — sem validação, sem
 * auditoria e sem o gatilho que mantém `organizations.acesso_liberado_ate` em
 * sincronia com `assinaturas`.
 *
 * Mostra o estado que o GATE enxerga (`lerEstadoDeCobranca`, o mesmo código que
 * decide se a organização trabalha) e não uma releitura da tabela: duas leituras
 * do mesmo fato é como a tela diz "ativa" enquanto a rota responde 402.
 */
export async function PainelDaAssinatura({ organizationId }: { organizationId: string }) {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) return null;
  const t = (texto: string) => traduzir(texto, usuario.idioma);

  const db = createAdminClient();
  const [estado, assinRes, planosRes, orgRes] = await Promise.all([
    lerEstadoDeCobranca(db, organizationId),
    db
      .from("assinaturas")
      .select("situacao, liberado_ate, plano_id, motivo, liberado_por, updated_at")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    db
      .from("planos")
      .select("id, nome, codigo")
      .is("arquivado_em", null)
      .order("ordem", { ascending: true }),
    db.from("organizations").select("acesso_liberado_ate").eq("id", organizationId).maybeSingle(),
  ]);

  const assin = assinRes.data as {
    situacao: string; liberado_ate: string | null; plano_id: string | null;
    motivo: string | null; liberado_por: string | null; updated_at: string;
  } | null;
  const planos = (planosRes.data ?? []) as Array<{ id: string; nome: string; codigo: string }>;
  const prazoDaOrg = (orgRes.data as { acesso_liberado_ate: string | null } | null)?.acesso_liberado_ate ?? null;
  const planoAtual = planos.find((p) => p.id === (assin?.plano_id ?? null));

  const data = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(usuario.idioma === "es" ? "es" : "pt-BR") : null;

  const situacaoDoAcesso = estado.acesso.naoMedido
    ? t("Não foi possível medir agora")
    : estado.acesso.liberado
      ? t("Liberado")
      : t("Bloqueado");

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{t("Assinatura")}</CardTitle>
        <CardDescription>
          {t("Liberar acesso à mão: Pix por fora, cortesia ou acordo. Toda liberação grava quem fez e por quê.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!estado.cobrancaLigada ? (
          <p className="rounded-md border border-amber-500/40 p-3 text-sm">
            <strong>{t("Cobrança desligada.")}</strong>{" "}
            {t("Nada disto tranca a organização até você ligar COBRANCA_LIGADA em Comportamento.")}
          </p>
        ) : null}

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t("Acesso agora")}</dt>
            <dd className="font-medium">{situacaoDoAcesso}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("Vence em")}</dt>
            <dd className="font-medium">
              {prazoDaOrg ? data(prazoDaOrg) : t("Sem prazo (não vence nunca)")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("Plano")}</dt>
            <dd className="font-medium">{planoAtual?.nome ?? t("Nenhum (produto inteiro)")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t("Situação")}</dt>
            <dd className="font-medium">{assin?.situacao ?? t("Em teste grátis / sem assinatura")}</dd>
          </div>
          {assin?.motivo ? (
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">{t("Última liberação manual")}</dt>
              <dd>
                {assin.motivo}{" "}
                <span className="text-xs text-muted-foreground">({data(assin.updated_at)})</span>
              </dd>
            </div>
          ) : null}
        </dl>

        <FormularioDeAssinatura
          organizationId={organizationId}
          planos={planos}
          situacaoInicial={assin?.situacao ?? "ativa"}
          planoInicial={assin?.plano_id ?? ""}
          liberadoAteInicial={prazoDaOrg ? prazoDaOrg.slice(0, 10) : ""}
        />
      </CardContent>
    </Card>
  );
}
