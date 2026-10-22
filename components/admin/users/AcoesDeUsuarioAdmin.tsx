"use client";

import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/types";
import {
  useApagarContaDeUsuario,
  useRemoverUsuarioDaEmpresa,
} from "@/hooks/useAdminUserMutations";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Bloqueios devolvidos pela rota (409), em texto legível
// ---------------------------------------------------------------------------

type UltimoAdmin = { organization_id: string; nome: string };
type RegistroObrigatorio = { tabela: string; coluna: string; quantidade: number };

function Bloqueios({ erro }: { erro: unknown }) {
  const t = useT();
  if (!(erro instanceof ApiError)) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("Não foi possível concluir agora. Tente de novo.")}
      </p>
    );
  }
  const ultimos = (erro.details?.ultimos_admins as UltimoAdmin[] | undefined) ?? [];
  const registros = (erro.details?.registros_obrigatorios as RegistroObrigatorio[] | undefined) ?? [];

  if (erro.status === 502) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("Não foi possível apagar a conta agora. O usuário já foi removido das empresas; tente apagar a conta de novo.")}
      </p>
    );
  }
  if (registros.length > 0) {
    return (
      <div role="alert" className="space-y-1 text-sm text-destructive">
        <p>{t("Este usuário tem registros que dependem dele. Remova-o das empresas em vez de apagar a conta.")}</p>
        <ul className="list-disc pl-5">
          {registros.map((r) => (
            <li key={`${r.tabela}.${r.coluna}`}>
              {r.tabela === "commissions" ? t("comissões") : r.tabela}: {r.quantidade}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (ultimos.length > 0 || erro.code === "ultimo_admin") {
    return (
      <div role="alert" className="space-y-1 text-sm text-destructive">
        <p>{t("Este usuário é o único admin ativo das empresas abaixo. Promova outra pessoa a admin antes de continuar.")}</p>
        {ultimos.length > 0 && (
          <ul className="list-disc pl-5">
            {ultimos.map((o) => (
              <li key={o.organization_id}>
                {o.nome} <span className="font-mono text-xs">({o.organization_id})</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      {t("Não foi possível concluir agora. Tente de novo.")}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Remover da empresa
// ---------------------------------------------------------------------------

export function RemoverDaEmpresaButton({
  userId,
  organizationId,
  tenantName,
}: {
  userId: string;
  organizationId: string;
  tenantName: string;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const mutation = useRemoverUsuarioDaEmpresa();

  const confirmar = () => {
    mutation.mutate(
      { userId, organizationId },
      {
        onSuccess: () => {
          setAberto(false);
          toast.success(t("Usuário removido da empresa."));
        },
      },
    );
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          mutation.reset();
          setAberto(true);
        }}
      >
        {t("Remover da empresa")}
      </Button>
      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remover da empresa?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O usuário perde o acesso a {empresa}. A conta e as outras empresas dele continuam.").replace(
                "{empresa}",
                tenantName,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.isError && <Bloqueios erro={mutation.error} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>{t("Cancelar")}</AlertDialogCancel>
            <Button variant="destructive" onClick={confirmar} disabled={mutation.isPending}>
              {mutation.isPending ? t("Removendo...") : t("Remover da empresa")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Apagar conta
// ---------------------------------------------------------------------------

export function ApagarContaButton({
  userId,
  email,
  onApagada,
}: {
  userId: string;
  email: string | null;
  onApagada?: () => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [digitado, setDigitado] = useState("");
  const mutation = useApagarContaDeUsuario();

  // Sem e-mail (conta só com telefone), o que se digita é o id do usuário.
  const esperado = (email ?? userId).trim().toLowerCase();
  const confere = digitado.trim().toLowerCase() === esperado;

  const confirmar = () => {
    mutation.mutate(
      { userId },
      {
        onSuccess: () => {
          setAberto(false);
          toast.success(t("Conta apagada."));
          onApagada?.();
        },
      },
    );
  };

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          mutation.reset();
          setDigitado("");
          setAberto(true);
        }}
      >
        {t("Apagar conta")}
      </Button>
      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Apagar esta conta?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O usuário perde o login e sai de todas as empresas. O histórico dele fica, sem o vínculo. Não dá para desfazer.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <label htmlFor="apagar-conta-confirmacao" className="block text-sm">
              {t("Digite {valor} para confirmar").replace("{valor}", email ?? userId)}
            </label>
            <Input
              id="apagar-conta-confirmacao"
              value={digitado}
              onChange={(e) => setDigitado(e.target.value)}
              autoComplete="off"
            />
          </div>
          {mutation.isError && <Bloqueios erro={mutation.error} />}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>{t("Cancelar")}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={confirmar}
              disabled={!confere || mutation.isPending}
            >
              {mutation.isPending ? t("Apagando...") : t("Apagar conta")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
