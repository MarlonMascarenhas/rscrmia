"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/**
 * Mutações do super admin sobre um usuário. As duas rotas são só de platform admin;
 * esconder o botão na tela é conforto, quem garante é a rota.
 */

function useInvalidarUsuarios() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "user"] });
  };
}

/** Tira o usuário de UMA empresa (revogação lógica do vínculo). */
export function useRemoverUsuarioDaEmpresa() {
  const invalidar = useInvalidarUsuarios();
  return useMutation({
    mutationFn: ({ userId, organizationId }: { userId: string; organizationId: string }) =>
      apiClient.post<unknown>(
        `/api/v1/admin/users/${userId}/organizations/${organizationId}/revoke`,
        {},
      ),
    onSuccess: invalidar,
  });
}

/** Apaga a conta do Auth: perde o login e sai de todas as empresas. */
export function useApagarContaDeUsuario() {
  const invalidar = useInvalidarUsuarios();
  return useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      apiClient.delete<unknown>(`/api/v1/admin/users/${userId}`),
    onSuccess: invalidar,
  });
}
