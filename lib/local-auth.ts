/** Autenticação de usuários locais. Nunca confia em cabeçalhos de identidade do navegador. */
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from './password-policy.mjs';
export const AUTH_COOKIE = 'porto_session';
export const PASSWORD_ITERATIONS = 600_000;
export const LEGACY_PASSWORD_ITERATIONS = 310_000;
export const SESSION_HOURS = 8;
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (value: string) =>
  new Uint8Array((value.match(/.{2}/g) || []).map((x) => Number.parseInt(x, 16)));
export function validUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,39}$/.test(value.trim().toLowerCase()))
    throw Error('Usuário inválido: use 3 a 40 letras, números, ponto, hífen ou sublinhado.');
  return value.trim().toLowerCase();
}
export function validPassword(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH
  )
    throw Error(`A senha deve ter de ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres.`);
  return value;
}
function supportedIterations(value: unknown): value is number {
  return value === PASSWORD_ITERATIONS || value === LEGACY_PASSWORD_ITERATIONS;
}
async function derivePassword(password: string, salt: string, iterations: number) {
  validPassword(password);
  if (typeof salt !== 'string' || !/^[a-f0-9]{32}$/.test(salt)) throw Error('Salt inválido.');
  if (!supportedIterations(iterations)) throw Error('Custo de senha não suportado.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(salt), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return { salt, hash: hex(new Uint8Array(bits)), iterations };
}
export async function hashPassword(password: string, salt?: string) {
  return derivePassword(
    password,
    salt ?? hex(crypto.getRandomValues(new Uint8Array(16))),
    PASSWORD_ITERATIONS,
  );
}
export async function verifyPassword(
  password: string,
  salt: string,
  storedHash: string,
  iterations: number = PASSWORD_ITERATIONS,
) {
  if (
    typeof password !== 'string' ||
    password.length > PASSWORD_MAX_LENGTH ||
    typeof storedHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(storedHash) ||
    !supportedIterations(iterations)
  )
    return false;
  const result = await derivePassword(password, salt, iterations).catch(() => null);
  if (!result) return false;
  const expected = fromHex(storedHash),
    actual = fromHex(result.hash);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= expected[i] ^ actual[i];
  return diff === 0;
}
export function sessionToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
export async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return hex(new Uint8Array(digest));
}
export function cookieToken(request: Request): string | null {
  const parts = (request.headers.get('cookie') || '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${AUTH_COOKIE}=`));
  if (parts.length !== 1) return null;
  const token = parts[0].slice(AUTH_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function sessionCookie(request: Request, token: string | null) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${AUTH_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax${secure}; ${token ? `Max-Age=${SESSION_HOURS * 3600}` : 'Max-Age=0'}`;
}
