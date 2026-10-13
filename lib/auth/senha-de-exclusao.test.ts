import { describe, expect, it } from "vitest";

import { gerarHashDeSenha, verificarSenha } from "./senha-de-exclusao";

describe("senha de exclusão", () => {
  it("gera no formato scrypt$salt$hash e verifica a senha certa", async () => {
    const h = await gerarHashDeSenha("segredo-123");
    expect(h).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verificarSenha("segredo-123", h)).toBe(true);
  });

  it("rejeita senha errada", async () => {
    const h = await gerarHashDeSenha("segredo-123");
    expect(await verificarSenha("segredo-124", h)).toBe(false);
  });

  it("o salt é aleatório: o mesmo texto gera hashes diferentes", async () => {
    expect(await gerarHashDeSenha("x")).not.toBe(await gerarHashDeSenha("x"));
  });

  it("formato inválido devolve false e nunca lança", async () => {
    const ruins = ["", "abc", "scrypt$a", "md5$a$b", "scrypt$$", "scrypt$AAAA$AAAA", "a$b$c$d"];
    for (const ruim of ruins) {
      expect(await verificarSenha("x", ruim)).toBe(false);
    }
  });
});
