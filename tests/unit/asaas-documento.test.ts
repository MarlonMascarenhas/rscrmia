/**
 * CPF/CNPJ — dígito verificador e máscara. Puro.
 */
import { describe, expect, it } from "vitest";

import { cnpjValido, cpfValido, documentoValido, mascararDocumento, somenteDigitos } from "@/lib/planos/asaas/documento";

describe("documento", () => {
  it("CPF válido pelo dígito verificador, com ou sem máscara", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224725")).toBe(true);
  });

  it("CPF com dígito errado, sequência repetida ou tamanho errado é recusado", () => {
    expect(cpfValido("529.982.247-24")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cpfValido("5299822472")).toBe(false);
  });

  it("CNPJ válido pelo dígito verificador", () => {
    expect(cnpjValido("11.222.333/0001-81")).toBe(true);
    expect(cnpjValido("11222333000181")).toBe(true);
  });

  it("CNPJ com dígito errado ou sequência repetida é recusado", () => {
    expect(cnpjValido("11.222.333/0001-82")).toBe(false);
    expect(cnpjValido("00000000000000")).toBe(false);
  });

  it("documentoValido escolhe CPF ou CNPJ pelo tamanho; qualquer outro tamanho é recusado", () => {
    expect(documentoValido("529.982.247-25")).toBe(true);
    expect(documentoValido("11.222.333/0001-81")).toBe(true);
    expect(documentoValido("123")).toBe(false);
    expect(documentoValido("")).toBe(false);
  });

  it("máscara enquanto se digita: CPF até 11 dígitos, CNPJ acima", () => {
    expect(mascararDocumento("5")).toBe("5");
    expect(mascararDocumento("5299")).toBe("529.9");
    expect(mascararDocumento("5299822")).toBe("529.982.2");
    expect(mascararDocumento("52998224725")).toBe("529.982.247-25");
    expect(mascararDocumento("112223330001")).toBe("11.222.333/0001");
    expect(mascararDocumento("11222333000181")).toBe("11.222.333/0001-81");
    expect(mascararDocumento("11222333000181999")).toBe("11.222.333/0001-81");
    expect(mascararDocumento("abc 529.982")).toBe("529.982");
  });

  it("somenteDigitos tira tudo que não é dígito", () => {
    expect(somenteDigitos("529.982.247-25")).toBe("52998224725");
  });
});
