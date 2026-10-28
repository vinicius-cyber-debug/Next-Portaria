/** Autenticação de usuários locais. Nunca confia em cabeçalhos de identidade do navegador. */
export const AUTH_COOKIE = 'porto_session';
export const PASSWORD_ITERATIONS = 310_000;
export const SESSION_HOURS = 8;
const encoder = new TextEncoder();
const hex = (bytes:Uint8Array)=>Array.from(bytes, b=>b.toString(16).padStart(2,'0')).join('');
const fromHex = (value:string)=>new Uint8Array((value.match(/.{2}/g)||[]).map(x=>Number.parseInt(x,16)));
export function validUsername(value:unknown):string {
  if(typeof value!=='string'||!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(value.trim().toLowerCase()))throw Error('Usuário inválido: use 3 a 40 letras, números, ponto, hífen ou sublinhado.');
  return value.trim().toLowerCase();
}
export function validPassword(value:unknown):string {
  if(typeof value!=='string'||value.length<12||value.length>128)throw Error('A senha deve ter de 12 a 128 caracteres.');
  return value;
}
export async function hashPassword(password:string,salt?:string) {
  validPassword(password);
  const randomSalt = salt??hex(crypto.getRandomValues(new Uint8Array(16)));
  if(!/^[a-f0-9]{32}$/.test(randomSalt))throw Error('Salt inválido.');
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:fromHex(randomSalt),iterations:PASSWORD_ITERATIONS,hash:'SHA-256'},key,256);
  return {salt:randomSalt,hash:hex(new Uint8Array(bits)),iterations:PASSWORD_ITERATIONS};
}
export async function verifyPassword(password:string,salt:string,storedHash:string) {
  if(typeof password!=='string'||password.length>128||! /^[a-f0-9]{64}$/.test(storedHash))return false;
  const result=await hashPassword(password,salt).catch(()=>null);
  if(!result)return false;
  const expected=fromHex(storedHash),actual=fromHex(result.hash);let diff=0;
  for(let i=0;i<32;i++)diff|=expected[i]^actual[i];
  return diff===0;
}
export function sessionToken() {return hex(crypto.getRandomValues(new Uint8Array(32)));}
export async function tokenHash(token:string){const digest=await crypto.subtle.digest('SHA-256',encoder.encode(token));return hex(new Uint8Array(digest));}
export function cookieToken(request:Request):string|null {
  const parts=(request.headers.get('cookie')||'').split(';').map(p=>p.trim()).filter(p=>p.startsWith(`${AUTH_COOKIE}=`));
  if(parts.length!==1)return null;
  const token=parts[0].slice(AUTH_COOKIE.length+1);
  return /^[a-f0-9]{64}$/.test(token)?token:null;
}
export function sessionCookie(request:Request,token:string|null) {
  const secure = new URL(request.url).protocol==='https:'?'; Secure':'';
  return `${AUTH_COOKIE}=${token??''}; Path=/; HttpOnly; SameSite=Lax${secure}; ${token?`Max-Age=${SESSION_HOURS*3600}`:'Max-Age=0'}`;
}
