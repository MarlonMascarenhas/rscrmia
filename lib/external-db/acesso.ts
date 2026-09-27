/**
 * Abre o acesso ao banco externo para uma leitura: carrega a conexão (com a
 * organização no filtro), revalida o destino contra a guarda de rede e devolve o
 * pool da conexão.
 *
 * ─── Por que a guarda roda AQUI, e não só no cadastro ───────────────────────
 *
 * Um host pode ter sido cadastrado quando resolvia para um IP público e, depois,
 * passar a resolver para `127.0.0.1` (DNS rebinding) — ou o dono pode ter
 * apontado para um nome que só existe dentro da rede. Validar apenas no POST
 * deixaria a janela aberta entre o cadastro e o primeiro SELECT. Toda leitura
 * passa por aqui, então a guarda é sempre reavaliada no momento de abrir o pool.
 */
import { negacaoDeCapacidade } from "@/lib/planos/guarda";
import { estadoDeCobrancaDoPedido } from "@/lib/planos/pedido";
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { moduloLigado } from "@/lib/instalacao/modulos";

import { carregarConexao, type MotivoSemConexao } from "./credenciais";
import { obterPool } from "./conexao";
import { validarHostDeBanco } from "./guardas";
import type { ConexaoExterna } from "./types";

export type MotivoAcesso =
  | MotivoSemConexao
  | "host_bloqueado"
  | "dns_falhou"
  | "modulo_desligado"
  // O PLANO da organização não inclui o banco externo (migration 0393). É outra
  // causa que `modulo_desligado`: aquela é da INSTALAÇÃO (quem administra a VPS), esta é
  // da CONTRATAÇÃO (a organização troca de plano) — e a tela diz frases diferentes.
  | "plano_nao_inclui"
  // A leitura do plano não voltou. Recusa, mas NÃO afirma `plano_nao_inclui`.
  | "plano_indeterminado";

export type Acesso =
  | { ok: true; conexao: ConexaoExterna; pool: pg.Pool }
  | { ok: false; motivo: MotivoAcesso };

export async function abrirAcesso(
  admin: SupabaseClient,
  organizationId: string,
  connectionId: string,
): Promise<Acesso> {
  // A porta de saída que o doc 37 manda fechar é ESTA: abrir conexão com o
  // banco de outro sistema. Toda leitura passa por aqui — as rotas e as
  // ferramentas do agente —, então o módulo desligado recusa aqui também, e
  // nenhum caminho novo precisa lembrar de perguntar.
  if (!(await moduloLigado(admin, "banco_externo"))) return { ok: false, motivo: "modulo_desligado" };

  // O plano contratado (migration 0393). Aqui, e não nas rotas: este é o ÚNICO ponto
  // por onde toda leitura passa — as rotas e as ferramentas do agente —, então uma
  // rota nova não precisa lembrar de perguntar.
  const negadaPeloPlano = negacaoDeCapacidade(
    await estadoDeCobrancaDoPedido(organizationId),
    "banco_externo",
    (texto) => texto,
  );
  if (negadaPeloPlano) {
    return {
      ok: false,
      motivo: negadaPeloPlano.code === "plano_nao_inclui" ? "plano_nao_inclui" : "plano_indeterminado",
    };
  }

  const leitura = await carregarConexao(admin, organizationId, connectionId);
  if (!leitura.ok) return { ok: false, motivo: leitura.motivo };

  const alvo = await validarHostDeBanco(leitura.conexao.host);
  // "Bloqueado" e "não resolveu" são coisas diferentes para quem lê: a primeira
  // pede trocar o host, a segunda pode ser DNS indisponível agora. O código da
  // resposta carrega essa diferença.
  if (!alvo.ok) {
    return {
      ok: false,
      motivo: alvo.motivo === "dns_falhou" || alvo.motivo === "dns_vazio" ? "dns_falhou" : "host_bloqueado",
    };
  }

  return { ok: true, conexao: leitura.conexao, pool: obterPool(leitura.conexao) };
}
