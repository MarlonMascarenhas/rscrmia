import { describe, expect, it } from "vitest";

import {
  autorDaMensagemDeGrupo,
  chatDeGrupoDoPayload,
  idCruDeMensagemDeGrupo,
} from "@/lib/waha/grupo";
import type { WahaPayload } from "@/lib/waha/envelope";

describe("chatDeGrupoDoPayload", () => {
  it("prefere `to` quando é um @g.us válido", () => {
    const p: WahaPayload = { to: "120363000000000000@g.us", from: "5511999999999@c.us" };
    expect(chatDeGrupoDoPayload(p)).toBe("120363000000000000@g.us");
  });

  it("cai para `from` quando `to` não é grupo", () => {
    const p: WahaPayload = { to: "5511999999999@c.us", from: "120363000000000000@g.us" };
    expect(chatDeGrupoDoPayload(p)).toBe("120363000000000000@g.us");
  });

  it("cai para o segmento do id composto quando `to`/`from` não bastam", () => {
    const p: WahaPayload = {
      id: "true_120363000000000000@g.us_2A1B890FB8AA87730CBC",
      from: undefined,
    };
    expect(chatDeGrupoDoPayload(p)).toBe("120363000000000000@g.us");
  });

  it("null quando nada é grupo", () => {
    expect(chatDeGrupoDoPayload({ to: "5511999999999@c.us", from: "5511999999999@c.us" })).toBeNull();
    expect(chatDeGrupoDoPayload({ id: "true_5511999999999@c.us_3EB0ABC" })).toBeNull();
    expect(chatDeGrupoDoPayload({})).toBeNull();
  });

  it("hostil: string absurda de `@` não trava e não casa", () => {
    const bomba = "@".repeat(10_000);
    const p: WahaPayload = { to: bomba, from: bomba };
    const inicio = Date.now();
    expect(chatDeGrupoDoPayload(p)).toBeNull();
    expect(Date.now() - inicio).toBeLessThan(200);
  });

  it("respeita o teto de 128 em `to`/`from` — string maior que isso não casa por esses campos", () => {
    const longo = "1".repeat(200) + "@g.us";
    const p: WahaPayload = { to: longo, from: undefined, id: undefined };
    expect(chatDeGrupoDoPayload(p)).toBeNull();
  });

  it("respeita o teto de 512 no id — id maior que isso não é varrido", () => {
    const idEnorme = "true_" + "x".repeat(600) + "@g.us_3EB0ABC";
    const p: WahaPayload = { id: idEnorme };
    expect(chatDeGrupoDoPayload(p)).toBeNull();
  });

  it("`@lid` não é grupo", () => {
    expect(chatDeGrupoDoPayload({ to: "250302204792918@lid" })).toBeNull();
  });
});

describe("idCruDeMensagemDeGrupo", () => {
  it("extrai o 3º segmento quando o 2º é um chat de grupo e há 4+ segmentos", () => {
    expect(
      idCruDeMensagemDeGrupo("true_120363000000000000@g.us_4CC5EDD64BC22EBA6D639F2AF571346C_9999@lid"),
    ).toBe("4CC5EDD64BC22EBA6D639F2AF571346C");
  });

  it("null com só 3 segmentos (formato 1:1, não grupo)", () => {
    expect(idCruDeMensagemDeGrupo("true_5511999999999@c.us_3EB0ABCDEF")).toBeNull();
  });

  it("null quando o 2º segmento não termina em @g.us mesmo com 4+ partes", () => {
    expect(idCruDeMensagemDeGrupo("a_b@c.us_c_d")).toBeNull();
  });

  it("null sem `_` nenhum (id bare)", () => {
    expect(idCruDeMensagemDeGrupo("3EB0ABCDEF")).toBeNull();
  });

  it("null acima do teto de 512 caracteres, mesmo com forma válida por dentro", () => {
    const gigante = "true_x@g.us_" + "y".repeat(600) + "_z";
    expect(idCruDeMensagemDeGrupo(gigante)).toBeNull();
  });
});

describe("autorDaMensagemDeGrupo", () => {
  it("chat_id vem de `participant`, telefone de `participantAlt`, nome de `notifyName`", () => {
    const p: WahaPayload = {
      participant: "5511999999999@s.whatsapp.net",
      _data: {
        notifyName: "Fulano",
        key: { participantAlt: "5511988888888@s.whatsapp.net" },
      },
    };
    expect(autorDaMensagemDeGrupo(p)).toEqual({
      chat_id: "5511999999999@s.whatsapp.net",
      telefone: "+5511988888888",
      nome: "Fulano",
    });
  });

  it("cai para `author` quando não há `participant`", () => {
    const p: WahaPayload = { author: "5511999999999@c.us" };
    expect(autorDaMensagemDeGrupo(p)!.chat_id).toBe("5511999999999@c.us");
  });

  it("cai para `_data.key.participant` quando `participant`/`author` faltam", () => {
    const p: WahaPayload = { _data: { key: { participant: "5511999999999@c.us" } } };
    expect(autorDaMensagemDeGrupo(p)!.chat_id).toBe("5511999999999@c.us");
  });

  it("telefone cai para o chat_id quando não há participantAlt", () => {
    const p: WahaPayload = { participant: "5511999999999@c.us" };
    expect(autorDaMensagemDeGrupo(p)).toEqual({
      chat_id: "5511999999999@c.us",
      telefone: "+5511999999999",
      nome: null,
    });
  });

  it("nome usa pushName quando não há notifyName, cortado em 120 e sem espaço nas pontas", () => {
    const p: WahaPayload = { _data: { pushName: "  " + "a".repeat(200) + "  " } };
    const autor = autorDaMensagemDeGrupo(p)!;
    expect(autor.nome).toHaveLength(120);
    expect(autor.nome).toBe("a".repeat(120));
  });

  it("null quando chat_id/telefone/nome são todos indisponíveis", () => {
    expect(autorDaMensagemDeGrupo({})).toBeNull();
  });

  it("hostil: chat_id maior que 128 não casa por nenhum candidato", () => {
    const longo = "1".repeat(200) + "@c.us";
    const p: WahaPayload = { participant: longo, author: longo };
    expect(autorDaMensagemDeGrupo(p)).toBeNull();
  });

  it("hostil: participantAlt sem sufixo de número não vira telefone", () => {
    const p: WahaPayload = {
      participant: "250302204792918@lid",
      _data: { key: { participantAlt: "250302204792918@lid" } },
    };
    expect(autorDaMensagemDeGrupo(p)).toEqual({
      chat_id: "250302204792918@lid",
      telefone: null,
      nome: null,
    });
  });

  it("hostil: dígitos fora da faixa 8-15 não viram telefone", () => {
    const p: WahaPayload = {
      participant: "5511999999999@c.us",
      _data: { key: { participantAlt: "123@s.whatsapp.net" } },
    };
    // participantAlt tem poucos dígitos (inválido) — cai para o chat_id, que
    // tem um telefone válido.
    expect(autorDaMensagemDeGrupo(p)!.telefone).toBe("+5511999999999");
  });
});
