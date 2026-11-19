import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { privateDirectory } from '../lib/full-backup.mjs';
import { withIntegrationConfigLock, replaceIntegrationJson } from './integration-config-files.mjs';

const samePath = (left, right) =>
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
const below = (path, root) => {
  const p = resolve(path),
    r = resolve(root) + sep;
  return process.platform === 'win32'
    ? p.toLowerCase().startsWith(r.toLowerCase())
    : p.startsWith(r);
};
async function regularFile(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isFile()))
    throw Error('A conexão deve usar arquivos regulares, sem links simbólicos.');
  return Boolean(info);
}
async function jsonFile(path) {
  if (!(await regularFile(path))) return null;
  const text = await readFile(path, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error(
      'Configuração privada inválida. Corrija o arquivo sem copiar seu conteúdo para logs.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Configuração privada inválida.');
  return { path, text, value };
}
function credentialIdentity(value) {
  let url;
  try {
    url = new URL(value.origin);
  } catch {
    throw Error('Origem iDSecure inválida na configuração privada.');
  }
  const parts = url.hostname.split('.').map(Number),
    privateHost =
      isIP(url.hostname) === 4 &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (
    !privateHost ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value.mode !== 'read_only' ||
    typeof value.sourceId !== 'string' ||
    !/^[a-z0-9_-]{2,60}$/.test(value.sourceId) ||
    typeof value.username !== 'string' ||
    !value.username ||
    typeof value.password !== 'string' ||
    !value.password ||
    typeof value.certificatePath !== 'string' ||
    !value.certificatePath ||
    typeof value.fingerprint256 !== 'string' ||
    !/^([\da-f]{2}:){31}[\da-f]{2}$/i.test(value.fingerprint256)
  )
    throw Error(
      'Configuração iDSecure incompleta ou inválida. Nenhuma credencial foi substituída.',
    );
  return { origin: url.origin, sourceId: value.sourceId };
}
function referencePaths(reference, configPath, legacyRoot) {
  return [
    ...new Set(
      isAbsolute(reference)
        ? [resolve(reference)]
        : [
            resolve(dirname(configPath), reference),
            ...(legacyRoot ? [resolve(legacyRoot, reference)] : []),
          ],
    ),
  ];
}
async function pinnedCertificate(source, legacyRoot) {
  for (const path of referencePaths(source.value.certificatePath, source.path, legacyRoot)) {
    if (!(await regularFile(path))) continue;
    const bytes = await readFile(path);
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(bytes.toString('utf8')))
      throw Error('O certificado confiável não pode conter chave privada.');
    let cert;
    try {
      cert = new X509Certificate(bytes);
    } catch {
      throw Error('O arquivo de confiança não é um certificado válido.');
    }
    if (cert.fingerprint256.toUpperCase() !== source.value.fingerprint256.toUpperCase())
      throw Error(
        'Certificado e fingerprint iDSecure divergentes. A confiança não será alterada automaticamente.',
      );
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  }
  throw Error(
    'Certificado confiável da conexão anterior não encontrado. Preserve o PEM original antes de atualizar.',
  );
}
async function referenceCredential(exit, legacyRoot, destination, chosen) {
  for (const path of referencePaths(exit.value.credentialFile, exit.path, legacyRoot)) {
    if (samePath(path, destination)) return chosen;
    const file = await jsonFile(path);
    if (file) return file;
  }
  throw Error(
    'Credencial da integração de saída não encontrada. Não é seguro substituir uma conexão desconhecida.',
  );
}

/** Offline migration only: validates pinned trust and preserves the newest persistent settings. */
export async function preserveIdSecureConfig({ dataRoot, previousRoot, releaseRoot }) {
  if (
    typeof dataRoot !== 'string' ||
    typeof releaseRoot !== 'string' ||
    !isAbsolute(dataRoot) ||
    !isAbsolute(releaseRoot) ||
    (previousRoot && (typeof previousRoot !== 'string' || !isAbsolute(previousRoot)))
  )
    throw Error('Use pastas absolutas para preservar as conexões.');
  if (
    samePath(dataRoot, releaseRoot) ||
    below(dataRoot, releaseRoot) ||
    (previousRoot && (samePath(dataRoot, previousRoot) || below(dataRoot, previousRoot)))
  )
    throw Error('As conexões permanentes devem ficar fora das pastas de release.');
  const directory = resolve(dataRoot, 'integrations'),
    destination = resolve(directory, 'idsecure.json'),
    exitPath = resolve(directory, 'exit-access.json');
  const dirInfo = await lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (dirInfo && (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()))
    throw Error('Pasta de integrações inválida.');
  if (!dirInfo) await privateDirectory(directory);
  if (!below(await realpath(directory), await realpath(dataRoot)))
    throw Error('A pasta de integrações saiu da pasta de dados.');
  return withIntegrationConfigLock(destination, () =>
    withIntegrationConfigLock(exitPath, async () => {
      const current = await jsonFile(destination),
        existingExit = await jsonFile(exitPath);
      const legacyRoots = [previousRoot, releaseRoot].filter(Boolean);
      let chosen = current,
        sourceRoot;
      if (!chosen)
        for (const root of legacyRoots) {
          chosen = await jsonFile(resolve(root, '.porto-runtime/idsecure.json'));
          if (chosen) {
            sourceRoot = root;
            break;
          }
        }
      let exit = existingExit,
        exitRoot;
      if (!exit)
        for (const root of legacyRoots) {
          exit = await jsonFile(resolve(root, '.porto-runtime/exit-access.json'));
          if (exit) {
            exitRoot = root;
            break;
          }
        }
      if (
        exit &&
        (exit.value.version !== 1 ||
          typeof exit.value.enabled !== 'boolean' ||
          typeof exit.value.credentialFile !== 'string' ||
          !exit.value.credentialFile ||
          typeof exit.value.target?.sourceId !== 'string')
      )
        throw Error(
          'Configuração da integração de saída inválida. Nenhuma conexão foi substituída.',
        );
      if (!chosen && exit) {
        for (const path of referencePaths(exit.value.credentialFile, exit.path, exitRoot)) {
          chosen = await jsonFile(path);
          if (chosen) {
            sourceRoot = exitRoot;
            break;
          }
        }
      }
      if (!chosen) {
        if (exit)
          throw Error('A conexão da integração de saída não está disponível para preservação.');
        return { idsecure: 'not_configured', exitAccess: 'not_configured' };
      }
      const identity = credentialIdentity(chosen.value),
        certificate = await pinnedCertificate(chosen, sourceRoot ?? previousRoot),
        certificatePath = resolve(directory, 'idsecure-trust-' + certificate.digest + '.pem');
      let exitValue;
      if (exit) {
        const prior = await referenceCredential(
            exit,
            exitRoot ?? previousRoot,
            destination,
            chosen,
          ),
          priorIdentity = credentialIdentity(prior.value);
        if (
          identity.origin !== priorIdentity.origin ||
          identity.sourceId !== priorIdentity.sourceId ||
          exit.value.target.sourceId !== identity.sourceId
        )
          throw Error(
            'Monitor e integração de saída apontam para origens diferentes. Confira a configuração; nenhuma conexão foi redirecionada.',
          );
        // Only an already persistent configuration can retain its explicitly enabled state.
        exitValue = {
          ...exit.value,
          credentialFile: destination,
          ...(!existingExit ? { enabled: false } : {}),
        };
      }
      if (await regularFile(certificatePath)) {
        if (!certificate.bytes.equals(await readFile(certificatePath)))
          throw Error(
            'Certificado permanente divergente. Nenhum arquivo confiável foi sobrescrito.',
          );
      } else await writeFile(certificatePath, certificate.bytes, { flag: 'wx', mode: 0o600 });
      const value = { ...chosen.value, certificatePath };
      if (!current || chosen.value.certificatePath !== certificatePath)
        await replaceIntegrationJson(destination, value, current?.text ?? null);
      if (exit && (!existingExit || exit.value.credentialFile !== destination))
        await replaceIntegrationJson(exitPath, exitValue, existingExit?.text ?? null);
      return {
        idsecure: current ? 'preserved' : 'migrated',
        exitAccess: exit ? (existingExit ? 'preserved' : 'migrated_disabled') : 'not_configured',
      };
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      get = (name) => {
        const index = args.indexOf(name);
        return index < 0 ? undefined : args[index + 1];
      };
    const result = await preserveIdSecureConfig({
      dataRoot: get('--data-root'),
      previousRoot: get('--previous-root'),
      releaseRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      error instanceof Error && error.message && !error.code
        ? error.message
        : 'Não foi possível preservar a conexão iDSecure. Confira arquivos, permissões e certificado antes de ativar a release.',
    );
    process.exitCode = 1;
  }
}
