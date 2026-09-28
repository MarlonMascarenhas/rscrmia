import { describe, expect, it } from "vitest";

import { autorDaMensagem } from "./autor-da-mensagem";

describe("autorDaMensagem", () => {
  it("com nome, devolve o nome", () => {
    expect(
      autorDaMensagem({ autor: { chat_id: "x@c.us", telefone: "+5511988888888", nome: "Maria" } }),
    ).toBe("Maria");
  });

  it("sem nome, devolve o telefone formatado (nono dígito)", () => {
    expect(
      autorDaMensagem({ autor: { chat_id: "x@c.us", telefone: "+553198966398", nome: null } }),
    ).toBe("+5531998966398");
  });

  it("sem nome e sem telefone, devolve null", () => {
    expect(
      autorDaMensagem({ autor: { chat_id: "x@c.us", telefone: null, nome: null } }),
    ).toBeNull();
  });

  it("metadata sem autor devolve null (conversa 1:1)", () => {
    expect(autorDaMensagem({ raw_type: "text" })).toBeNull();
  });

  it("metadata malformada (autor não é objeto) devolve null", () => {
    expect(autorDaMensagem({ autor: "não é objeto" })).toBeNull();
  });

  it("metadata null/undefined devolve null", () => {
    expect(autorDaMensagem(null)).toBeNull();
    expect(autorDaMensagem(undefined)).toBeNull();
  });

  it("autor null (payload sem autor identificável) devolve null", () => {
    expect(autorDaMensagem({ autor: null })).toBeNull();
  });

  it("nome em branco cai para o telefone", () => {
    expect(
      autorDaMensagem({ autor: { chat_id: null, telefone: "+5511988888888", nome: "   " } }),
    ).toBe("+5511988888888");
  });
});
