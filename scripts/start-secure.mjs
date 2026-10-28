/** Servidor compilado em HTTPS LOCAL; não publica nem utiliza vínculos remotos. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function stop(message) { console.error(`ERRO: ${message}`); process.exit(1); }
const certPath = process.env.PORTO_TLS_CERT_PATH;
const keyPath = process.env.PORTO_TLS_KEY_PATH;
if (!certPath || !keyPath || !isAbsolute(certPath) || !isAbsolute(keyPath)) {
  stop('Defina PORTO_TLS_CERT_PATH e PORTO_TLS_KEY_PATH com caminhos absolutos de um certificado PEM e sua chave privada. Veja docs/OPERACAO-V4.md.');
}
const bindHost = process.env.PORTO_BIND_HOST || '127.0.0.1';
const publicHost = process.env.PORTO_PUBLIC_HOST || bindHost;
const port = Number(process.env.PORTO_PORT || 8443);
if (bindHost !== 'localhost' && !isIP(bindHost)) stop('PORTO_BIND_HOST deve ser localhost ou um endereço IP da máquina.');
if (!Number.isInteger(port) || port < 1024 || port > 65535) stop('PORTO_PORT deve ser um inteiro de 1024 a 65535.');
if (['0.0.0.0','::'].includes(publicHost)) stop('Defina PORTO_PUBLIC_HOST com o nome ou IP presente no certificado.');
if (!isIP(publicHost) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(publicHost)) stop('PORTO_PUBLIC_HOST inválido.');
try {
  const certificate = new X509Certificate(readFileSync(certPath));
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (!certificate.checkPrivateKey(privateKey)) stop('O certificado e a chave privada não formam um par.');
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) stop('O certificado está fora da validade.');
  if (!(isIP(publicHost) ? certificate.checkIP(publicHost) : certificate.checkHost(publicHost))) stop('O certificado não cobre PORTO_PUBLIC_HOST.');
} catch { stop('Não foi possível validar o certificado PEM e a chave privada. Confira os arquivos e as permissões da conta do servidor.'); }
if (!existsSync(resolve(root, 'dist/server/wrangler.json'))) stop('Compile primeiro com npm run build e prepare o banco com node scripts/setup-local.mjs.');
console.log(`Porto Gestão · HTTPS local em https://${isIP(publicHost)===6?'['+publicHost+']':publicHost}:${port}`);
console.log('Banco e arquivos locais em .wrangler/state. O certificado precisa ser confiável nos computadores clientes.');
const child = spawn(process.execPath, [
  '--import', './scripts/runtime-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'dev',
  '--config', 'dist/server/wrangler.json', '--local', '--persist-to', '.wrangler/state',
  '--ip', bindHost, '--port', String(port), '--inspector-port', '0',
  '--local-protocol', 'https', '--https-cert-path', certPath, '--https-key-path', keyPath,
  '--show-interactive-dev-session=false',
], { cwd: root, stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => stop('Não foi possível iniciar o servidor HTTPS local.'));
child.on('exit', code => process.exit(code ?? 1));
