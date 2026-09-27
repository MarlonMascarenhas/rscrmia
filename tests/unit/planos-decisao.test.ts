/**
 * A ESCADA DE `decidirAcesso`, DEGRAU POR DEGRAU.
 *
 * O que estes casos protegem, em ordem de gravidade se quebrarem:
 *
 *   1. Instalação que não vende NUNCA tranca ninguém (o degrau 1). Se isto
 *      quebrar, quem só atualizou o produto perde acesso — e é o modo de falha
 *      mais caro que este trabalho pode ter.
 *   2. `liberadoAte === null` é SEM PRAZO, nunca "vencido". Se invertesse, toda
 *      organização anterior à cobrança seria trancada no `update.sh`.
 *   3. Leitura que não voltou LIBERA, e diz que não mediu (`naoMedido`). Um gate
 *      que falha aberto calado é um interruptor invisível.
 *   4. O `motivo` nomeia quem sobrou — é o que decide a frase da tela, e uma
 *      recusa que afirma a causa errada manda a pessoa procurar o botão errado.
 */
import { describe, expect, it } from "vitest";

import {
  decidirAcesso,
  estadoDeAcessoIndeterminado,
  precisaAvisar,
  type EntradaDeAcesso,
} from "@/lib/planos/decisao";

const AGORA = new Date("2026-09-25T12:00:00.000Z");
const DIA = 86_400_000;
const emDias = (n: number) => new Date(AGORA.getTime() + n * DIA);

/** O caso base é uma organização PAGANTE e em dia — para que cada teste mude uma
 *  coisa só e a causa do vermelho seja o que o nome do teste diz. */
function entrada(patch: Partial<EntradaDeAcesso> = {}): EntradaDeAcesso {
  return {
    cobrancaLigada: true,
    liberadoAte: emDias(30),
    situacao: "ativa",
    carenciaAte: null,
    agora: AGORA,
    ...patch,
  };
}

describe("degrau 1 — a instalação que não vende nunca tranca", () => {
  it("libera mesmo com tudo vencido e cancelado", () => {
    const e = decidirAcesso(
      entrada({
        cobrancaLigada: false,
        liberadoAte: emDias(-90),
        situacao: "cancelada",
      }),
    );
    expect(e.liberado).toBe(true);
    expect(e.motivo).toBe("cobranca_desligada");
    // Nada de prazo a mostrar: não há cobrança, então não há contagem.
    expect(e.diasRestantes).toBeNull();
    expect(e.naoMedido).toBe(false);
  });

  it("é o PRIMEIRO degrau — vence até a ausência de prazo", () => {
    // Sem este teste, uma refatoração poderia trocar a ordem e fazer o motivo
    // virar `sem_prazo`, que diz outra coisa a quem lê o log.
    expect(
      decidirAcesso(entrada({ cobrancaLigada: false, liberadoAte: null })).motivo,
    ).toBe("cobranca_desligada");
  });
});

describe("degrau 3 — `null` é SEM PRAZO, nunca vencido", () => {
  it("libera a organização que existia antes de a cobrança entrar", () => {
    const e = decidirAcesso(entrada({ liberadoAte: null, situacao: null }));
    expect(e.liberado).toBe(true);
    expect(e.motivo).toBe("sem_prazo");
    expect(e.expiraEm).toBeNull();
  });

  it("libera também quando há assinatura sem prazo gravado", () => {
    expect(decidirAcesso(entrada({ liberadoAte: null })).liberado).toBe(true);
  });
});

describe("teste grátis — ausência de linha é o que o define", () => {
  it("sem assinatura e dentro do prazo é `em_teste`, com os dias", () => {
    const e = decidirAcesso(entrada({ situacao: null, liberadoAte: emDias(5) }));
    expect(e.liberado).toBe(true);
    expect(e.motivo).toBe("em_teste");
    expect(e.diasRestantes).toBe(5);
  });

  it("sem assinatura e fora do prazo é `teste_vencido` — não `assinatura_vencida`", () => {
    // A frase da tela é outra: quem nunca assinou precisa de "escolha um plano",
    // não de "atualize seu pagamento".
    const e = decidirAcesso(entrada({ situacao: null, liberadoAte: emDias(-1) }));
    expect(e.liberado).toBe(false);
    expect(e.motivo).toBe("teste_vencido");
  });

  it("COM assinatura e dentro do prazo é `assinatura_ativa`, não `em_teste`", () => {
    expect(decidirAcesso(entrada({ liberadoAte: emDias(5) })).motivo).toBe(
      "assinatura_ativa",
    );
  });
});

describe("cortesia — decisão humana vence o relógio", () => {
  it("libera mesmo com o prazo no passado", () => {
    // Quem liberou à mão sabia o que estava fazendo; o relógio não desfaz isso.
    const e = decidirAcesso(
      entrada({ situacao: "cortesia", liberadoAte: emDias(-10) }),
    );
    expect(e.liberado).toBe(true);
    expect(e.motivo).toBe("cortesia");
  });

  it("libera com prazo nulo", () => {
    expect(
      decidirAcesso(entrada({ situacao: "cortesia", liberadoAte: null })).liberado,
    ).toBe(true);
  });
});

describe("carência — não se corta cliente bom por cartão recusado", () => {
  it("libera o inadimplente dentro da carência", () => {
    const e = decidirAcesso(
      entrada({
        situacao: "inadimplente",
        liberadoAte: emDias(-2),
        carenciaAte: emDias(3),
      }),
    );
    expect(e.liberado).toBe(true);
    expect(e.motivo).toBe("em_carencia");
    // O prazo que a tela mostra é o da CARÊNCIA, não o do período vencido.
    expect(e.expiraEm).toEqual(emDias(3));
    expect(e.diasRestantes).toBe(3);
  });

  it("tranca o inadimplente depois da carência, nomeando a inadimplência", () => {
    const e = decidirAcesso(
      entrada({
        situacao: "inadimplente",
        liberadoAte: emDias(-10),
        carenciaAte: emDias(-1),
      }),
    );
    expect(e.liberado).toBe(false);
    expect(e.motivo).toBe("inadimplente");
  });

  it("inadimplente SEM carência gravada tranca quando o prazo vence", () => {
    const e = decidirAcesso(
      entrada({ situacao: "inadimplente", liberadoAte: emDias(-1), carenciaAte: null }),
    );
    expect(e.liberado).toBe(false);
    expect(e.motivo).toBe("inadimplente");
  });

  it("mas inadimplente com o período ainda no futuro segue liberado", () => {
    // O provedor marca `past_due` assim que uma tentativa falha, e o período
    // pago pode não ter acabado. Trancar aqui cortaria quem ainda tem direito.
    expect(
      decidirAcesso(entrada({ situacao: "inadimplente", liberadoAte: emDias(4) }))
        .liberado,
    ).toBe(true);
  });
});

describe("cancelada e expirada não são resgatadas pelo prazo", () => {
  it("cancelada tranca mesmo dentro do prazo", () => {
    // Quem cancelou pediu para sair. Honrar o prazo aqui seria manter a conta
    // aberta contra a vontade declarada de quem a fechou.
    const e = decidirAcesso(entrada({ situacao: "cancelada", liberadoAte: emDias(20) }));
    expect(e.liberado).toBe(false);
    expect(e.motivo).toBe("cancelada");
  });

  it("expirada tranca dentro do prazo, como `assinatura_vencida`", () => {
    const e = decidirAcesso(entrada({ situacao: "expirada", liberadoAte: emDias(20) }));
    expect(e.liberado).toBe(false);
    expect(e.motivo).toBe("assinatura_vencida");
  });
});

describe("a fronteira do relógio", () => {
  it("o instante exato do vencimento já é vencido", () => {
    const e = decidirAcesso(entrada({ situacao: null, liberadoAte: AGORA }));
    expect(e.liberado).toBe(false);
    expect(e.motivo).toBe("teste_vencido");
  });

  it("um milissegundo antes ainda está dentro", () => {
    expect(
      decidirAcesso(entrada({ liberadoAte: new Date(AGORA.getTime() + 1) })).liberado,
    ).toBe(true);
  });

  it("`diasRestantes` nunca é negativo", () => {
    const e = decidirAcesso(entrada({ liberadoAte: emDias(-40) }));
    expect(e.diasRestantes).toBeGreaterThanOrEqual(0);
  });

  it("não usa relógio próprio: o mesmo `agora` dá sempre a mesma resposta", () => {
    // Se alguém puser `new Date()` dentro da decisão, este teste continua verde —
    // mas o de baixo não: um `agora` no futuro tem de mudar o veredito.
    const base = entrada({ situacao: null, liberadoAte: emDias(2) });
    expect(decidirAcesso(base).liberado).toBe(true);
    expect(decidirAcesso({ ...base, agora: emDias(3) }).liberado).toBe(false);
  });
});

describe("indeterminado — libera, e NÃO finge que mediu", () => {
  it("libera com `naoMedido` ligado", () => {
    const e = estadoDeAcessoIndeterminado();
    expect(e.liberado).toBe(true);
    expect(e.motivo).toBe("indeterminado");
    expect(e.naoMedido).toBe(true);
  });

  it("é o ÚNICO estado que se declara não medido", () => {
    // A garantia que importa: `naoMedido` distingue "está em dia" de "não sei".
    // Sem ela, quem chama não tem como saber que precisa alarmar.
    const casos: EntradaDeAcesso[] = [
      entrada(),
      entrada({ cobrancaLigada: false }),
      entrada({ liberadoAte: null }),
      entrada({ situacao: null, liberadoAte: emDias(-1) }),
      entrada({ situacao: "cortesia" }),
      entrada({ situacao: "cancelada" }),
      entrada({ situacao: "inadimplente", carenciaAte: emDias(2) }),
    ];
    for (const c of casos) expect(decidirAcesso(c).naoMedido).toBe(false);
  });

  it("não vira aviso na faixa: não há o que avisar sobre o que não se mediu", () => {
    expect(precisaAvisar(estadoDeAcessoIndeterminado())).toBe(false);
  });
});

describe("precisaAvisar — separado do gate de propósito", () => {
  it("avisa dentro da janela", () => {
    expect(precisaAvisar(decidirAcesso(entrada({ liberadoAte: emDias(2) })))).toBe(true);
  });

  it("não avisa fora da janela", () => {
    expect(precisaAvisar(decidirAcesso(entrada({ liberadoAte: emDias(10) })))).toBe(
      false,
    );
  });

  it("não avisa quem já está trancado — a tela inteira já é o aviso", () => {
    expect(
      precisaAvisar(decidirAcesso(entrada({ situacao: null, liberadoAte: emDias(-1) }))),
    ).toBe(false);
  });

  it("não avisa onde não há cobrança nem prazo", () => {
    expect(precisaAvisar(decidirAcesso(entrada({ cobrancaLigada: false })))).toBe(false);
    expect(precisaAvisar(decidirAcesso(entrada({ liberadoAte: null })))).toBe(false);
  });
});
