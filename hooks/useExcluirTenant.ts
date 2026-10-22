"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** O que a rota devolve ao excluir uma empresa (dentro de `data`). */
export interface ExclusaoDeTenant {
  id: string;
  deleted: true;
  slug: string | null;
  display_name: string | null;
  contagens: Record<string, number>;
  limpeza: {
    midias_removidas: number;
    sessoes_encerradas: number;
    falhas: string[];
  };
}

/**
 * Exclui a empresa inteira. Só platform admin; a confirmação (slug digitado) é conferida de novo
 * no servidor — esconder o botão na tela é conforto, quem garante é a rota.
 */
export function useExcluirTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmacaoSlug }: { id: string; confirmacaoSlug: string }) =>
      apiClient.delete<{ data: ExclusaoDeTenant }>(`/api/v1/admin/tenants/${id}`, {
        confirmacao_slug: confirmacaoSlug,
      }),
    onSuccess: (_data, variables) => {
      queryClient.removeQueries({ queryKey: ["admin", "tenant", variables.id] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
    },
  });
}
