/**
 * OS SCHEMAS DE ENTRADA DO CATÁLOGO DE PLANOS.
 *
 * Moram aqui, e não na rota, por uma razão que tem nome: é o que faz
 * `tests/unit/planos-tela-e-enforcement-leem-o-mesmo-campo.test.ts` poder provar
 * que o campo que a TELA escreve é o campo que o GATE lê.
 *
 * O defeito que isso previne está escrito no cabeçalho de
 * `lib/agent-engine/edge/llm/orcamento.ts:5-16`: a tela editava um campo e o
 * enforcement lia outro, e "quem preenchia a tela acreditava estar protegido e
 * não estava". Com o vocabulário saindo de `capacidades.ts` e `limites.ts` — as
 * MESMAS constantes que a decisão consome — a divergência deixa de ser possível
 * sem quebrar o build.
 */
import { z } from "zod";

import { CAPACIDADES_DE_PLANO } from "@/lib/planos/capacidades";
import { LIMITES_DE_PLANO } from "@/lib/planos/limites";

/** O código é o nome próprio do plano: estável, minúsculo, sem acento. Espelha
 *  o CHECK `planos_codigo_formato` da migration 0393. */
export const codigoDePlanoSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/, "Use minúsculas, números e _, começando por letra.");

export const precoSchema = z.object({
  intervalo: z.enum(["mensal", "anual"]),
  // `bigint` no banco, mas o teto de `Number.MAX_SAFE_INTEGER` é ordens de
  // grandeza acima de qualquer preço real; o limite aqui é de sanidade de
  // digitação, para um zero a mais não virar uma cobrança absurda.
  valor_cents: z.coerce.number().int().min(0).max(100_000_000),
  moeda: z
    .string()
    .regex(/^[A-Z]{3}$/, "Use o código ISO-4217, por exemplo BRL.")
    .default("BRL"),
});

export const criarPlanoSchema = z.object({
  codigo: codigoDePlanoSchema,
  nome: z.string().min(1).max(120),
  descricao: z.string().max(600).nullish(),
  ordem: z.coerce.number().int().min(0).max(999).default(0),
  libera_tudo: z.boolean().default(false),
  // `CAPACIDADES_DE_PLANO` e `LIMITES_DE_PLANO` vêm dos módulos que a DECISÃO
  // consome. Repetir a lista aqui como string literal seria criar a segunda
  // cópia que envelhece — e a tela passaria a oferecer o que o gate não conhece.
  capacidades: z.array(z.enum(CAPACIDADES_DE_PLANO)).default([]),
  // Array e não `Record`, para espelhar a forma da tabela (uma linha por limite)
  // e porque `valor` positivo é uma regra por item — num record ela viveria no
  // valor e a chave ficaria sem dono. `positive()` recusa o `0` pela mesma razão
  // que o CHECK do banco: zero não é "sem limite", é "não pode nada".
  limites: z
    .array(
      z.object({
        limite: z.enum(LIMITES_DE_PLANO),
        valor: z.coerce.number().int().positive(),
      }),
    )
    .max(LIMITES_DE_PLANO.length)
    .default([]),
  precos: z.array(precoSchema).max(4).default([]),
});

/**
 * A edição não aceita `codigo`: ele é o nome próprio do plano, aparece em log e
 * em conversa de suporte, e trocá-lo faria um registro antigo apontar para o que
 * não existe mais. Para trocar, arquive e crie outro.
 */
export const editarPlanoSchema = criarPlanoSchema.omit({ codigo: true }).partial();

/**
 * Atualizar um plano: campos parciais mais as duas AÇÕES de ciclo de vida.
 *
 * `publicado` liga e desliga a oferta (rascunho ⇄ publicado). `arquivar` é lógico
 * e só existe como `true`: desarquivar não é uma operação — se o plano volta a ser
 * vendido, cria-se outro. Quem já tem o plano arquivado continua com ele.
 *
 * `precos` aqui é a lista do que DEVE estar vigente; a rota compara com o vigente
 * e só cria linha nova onde o VALOR mudou (preço é append-only — ver a 0393).
 */
export const atualizarPlanoSchema = editarPlanoSchema.extend({
  publicado: z.boolean().optional(),
  arquivar: z.literal(true).optional(),
});

/**
 * A porta manual: liberar acesso à mão.
 *
 * `motivo` é OBRIGATÓRIO e com tamanho mínimo, de propósito. Liberação sem razão
 * escrita é o tipo de registro que, seis meses depois, ninguém sabe explicar — e
 * esta é a operação que mais precisa de explicação, porque ela contorna a
 * cobrança. O audit log guarda o ator; o motivo guarda a intenção.
 */
export const liberarAcessoSchema = z.object({
  plano_id: z.string().uuid().nullish(),
  /** `null` = SEM PRAZO (não vence nunca). Ver o cabeçalho da migration 0393. */
  liberado_ate: z.string().datetime({ offset: true }).nullable(),
  situacao: z.enum(["ativa", "cortesia", "inadimplente", "cancelada", "expirada"]),
  motivo: z.string().min(10, "Escreva por que este acesso foi liberado à mão.").max(400),
});
