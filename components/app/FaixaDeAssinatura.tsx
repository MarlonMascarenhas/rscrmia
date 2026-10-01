/**
 * O ACESSO ESTÁ PERTO DE ACABAR — E VOCÊ VÊ NA TELA EM QUE JÁ ESTÁ.
 *
 * Mesma razão de `ConexaoCaidaBanner`: um aviso guardado onde ninguém passa repete
 * o defeito que ele existe para evitar. O bloqueio por vencimento é DETERMINISTA
 * (uma comparação de data, sem cron no caminho), então o aviso também não pode
 * depender de um job ter rodado nem de `RESEND_API_KEY` — que é opcional e vazia
 * numa instalação real. A faixa funciona em toda instalação, sem configurar nada.
 *
 * Só aparece para quem PODE agir (admin: billing é admin-only) e só nos dois casos
 * em que há o que fazer — teste acabando e pagamento pendente. Renovação automática
 * chegando não é aviso: é o produto funcionando.
 */
"use client";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";

export function FaixaDeAssinatura({
  motivo,
  dias,
}: {
  motivo: "em_teste" | "em_carencia";
  /** Dias até o fim do teste ou da carência. */
  dias: number;
}) {
  const t = useT();
  const urgente = dias <= 1;

  return (
    <div
      role="status"
      className={
        urgente
          ? "flex flex-wrap items-center justify-between gap-2 bg-destructive px-4 py-2 text-sm text-destructive-foreground"
          : "flex flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-2 text-sm text-black"
      }
    >
      <span>
        {motivo === "em_teste"
          ? `${t("Seu teste grátis termina em")} ${dias} ${dias === 1 ? t("dia") : t("dias")}. ${t("Escolha um plano para não perder o acesso.")}`
          : `${t("O último pagamento não foi concluído.")} ${t("O acesso continua por mais")} ${dias} ${dias === 1 ? t("dia") : t("dias")}. ${t("Regularize o pagamento.")}`}
      </span>
      <Link href="/app/settings/billing" className="font-semibold underline underline-offset-2">
        {motivo === "em_teste" ? t("Ver planos") : t("Regularizar pagamento")}
      </Link>
    </div>
  );
}
