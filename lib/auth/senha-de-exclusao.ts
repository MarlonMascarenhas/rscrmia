/**
 * Senha da organização para excluir conversa. Guardada como
 * `scrypt$<salt base64>$<hash base64>` em `organization_conversation_delete_secret`.
 *
 * scrypt (KDF lento, com salt por senha) e não SHA256 puro: o hash é um segredo
 * de baixa entropia e precisa resistir a força bruta caso vaze.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PREFIXO = "scrypt";
const SALT_BYTES = 16;
const KEYLEN = 64;

function derivar(senha: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(senha, salt, KEYLEN, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function gerarHashDeSenha(senha: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derivar(senha, salt);
  return `${PREFIXO}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Nunca lança: formato inválido ou erro de derivação = false. */
export async function verificarSenha(senha: string, armazenado: string): Promise<boolean> {
  try {
    const partes = armazenado.split("$");
    if (partes.length !== 3 || partes[0] !== PREFIXO) return false;
    const salt = Buffer.from(partes[1] ?? "", "base64");
    const esperado = Buffer.from(partes[2] ?? "", "base64");
    if (salt.length === 0 || esperado.length !== KEYLEN) return false;
    const obtido = await derivar(senha, salt);
    return timingSafeEqual(obtido, esperado);
  } catch {
    return false;
  }
}
