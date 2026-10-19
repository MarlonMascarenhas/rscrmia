/**
 * CPF E CNPJ — VALIDAÇÃO PELO DÍGITO VERIFICADOR E MÁSCARA. PURO.
 *
 * O Asaas exige `cpfCnpj` para criar o cliente. Este módulo roda nos DOIS lados
 * (o diálogo de assinar e a rota do checkout): o cliente é avisado cedo, e o
 * servidor não confia no aviso. O número vai ao Asaas e a mais lugar nenhum — não
 * é gravado no banco, no log nem no audit.
 */

export const somenteDigitos = (s: string): string => s.replace(/\D/g, "");

function digitoVerificador(base: number[], pesos: number[]): number {
  const soma = base.reduce((acc, d, i) => acc + d * pesos[i]!, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cpfValido(entrada: string): boolean {
  const d = somenteDigitos(entrada);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const n = d.split("").map(Number);
  const d1 = digitoVerificador(n.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(n.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === n[9] && d2 === n[10];
}

export function cnpjValido(entrada: string): boolean {
  const d = somenteDigitos(entrada);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const n = d.split("").map(Number);
  const d1 = digitoVerificador(n.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(n.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === n[12] && d2 === n[13];
}

/** CPF (11 dígitos) ou CNPJ (14), cada um pelo seu dígito verificador. */
export function documentoValido(entrada: string): boolean {
  const d = somenteDigitos(entrada);
  return d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
}

/** Máscara simples enquanto se digita: `000.000.000-00` até 11 dígitos, `00.000.000/0000-00` acima. */
export function mascararDocumento(entrada: string): string {
  const d = somenteDigitos(entrada).slice(0, 14);
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2");
  }
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}
