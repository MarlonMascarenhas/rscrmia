"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SuspendDialog } from "./SuspendDialog";
import { ReactivateDialog } from "./ReactivateDialog";
import { ExcluirEmpresaDialog, type ContagensDaEmpresa } from "./ExcluirEmpresaDialog";
import { ImpersonateButton } from "@/components/admin/ImpersonateButton";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantActionsProps {
  organizationId: string;
  status: "active" | "suspended" | "redacted";
  displayName: string;
  slug: string;
  contagens?: ContagensDaEmpresa;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantActions({
  organizationId,
  status,
  displayName,
  slug,
  contagens,
}: TenantActionsProps) {
  const t = useT();
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);

  const canSuspend = status === "active";
  const isSuspended = status === "suspended";
  const isRedacted = status === "redacted";

  return (
    <>
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t("Ações")}
        </h2>

        {/* Impersonate (S-11.07) */}
        <ImpersonateButton
          organizationId={organizationId}
          displayName={displayName}
          disabled={isRedacted}
          disabledReason={
            isRedacted ? t("Tenant redigido — ação não disponível") : undefined
          }
        />

        {/* Suspend */}
        {canSuspend && (
          <Button
            className="w-full"
            variant="destructive"
            onClick={() => setSuspendOpen(true)}
            aria-label={t("Suspender tenant")}
          >
            {t("Suspender tenant")}
          </Button>
        )}

        {/* Reactivate */}
        {isSuspended && (
          <Button
            className="w-full"
            variant="outline"
            onClick={() => setReactivateOpen(true)}
            aria-label={t("Reativar tenant")}
          >
            {t("Reativar tenant")}
          </Button>
        )}

        {isRedacted && (
          <p className="text-xs text-muted-foreground text-center py-2">
            {t("Tenant redigido — ações de gestão não disponíveis.")}
          </p>
        )}
      </div>

      {/* Zona de perigo: exclusão definitiva da empresa */}
      <div className="rounded-lg border border-destructive/40 bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-destructive uppercase tracking-wider">
          {t("Zona de perigo")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("Excluir a empresa apaga tudo dela de uma vez. As contas das pessoas continuam.")}
        </p>
        <Button
          className="w-full"
          variant="destructive"
          onClick={() => setDeleteOpen(true)}
          aria-label={t("Excluir empresa")}
        >
          {t("Excluir empresa")}
        </Button>
      </div>

      <ExcluirEmpresaDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        organizationId={organizationId}
        slug={slug}
        displayName={displayName}
        contagens={contagens}
        onExcluida={() => router.push("/admin/tenants")}
      />

      <SuspendDialog
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        organizationId={organizationId}
      />

      <ReactivateDialog
        open={reactivateOpen}
        onClose={() => setReactivateOpen(false)}
        organizationId={organizationId}
      />
    </>
  );
}
