import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { IdSecureHttp } from '../lib/integrations/idsecure-http.ts';
import { terminalSecret } from './terminal-secret.mjs';
import { configuredIdSecurePath } from './postgres-config.mjs';
import { withIntegrationConfigLock, replaceIntegrationJson } from './integration-config-files.mjs';
try {
  const path = configuredIdSecurePath({ explicitPath: process.argv[2] });
  const original = await readFile(path, 'utf8');
  let config;
  try {
    config = JSON.parse(original);
  } catch {
    throw Error(
      'Configuração iDSecure inválida. Revise o arquivo privado sem copiar seu conteúdo para o chat ou os logs.',
    );
  }
  if (!isAbsolute(config.certificatePath))
    throw Error('Use o caminho absoluto do certificado confiável.');
  console.log(
    'ATUALIZAR CONEXÃO iDSecure\nInforme a credencial que você JÁ alterou na central. Este procedimento não muda a senha da central.\nA senha será digitada de forma oculta, sem aparecer na tela.',
  );
  console.log('Destino: ' + new URL(config.origin).origin + ' (central Control iD/iDSecure).');
  const readline = createInterface({ input: stdin, output: stdout });
  let username;
  try {
    username =
      (await readline.question('Usuário atual (Enter mantém o configurado): ')).trim() ||
      config.username;
  } finally {
    readline.close();
  }
  const password = await terminalSecret('Senha atual da central: '),
    confirmation = await terminalSecret('Confirme a senha: ');
  if (!password)
    throw Error(
      'O primeiro campo de senha ficou vazio. Digite a senha no terminal antes de pressionar Enter.',
    );
  if (!confirmation)
    throw Error('O campo de confirmação ficou vazio. Repita a senha no segundo campo.');
  if (password !== confirmation)
    throw Error(
      'A confirmação não coincide com a primeira digitação. Nenhum arquivo foi alterado.',
    );
  if (password === username)
    throw Error(
      'A senha informada é igual ao nome de usuário. Essa credencial insegura não será aceita; altere-a na central.',
    );
  const updated = { ...config, username, password };
  const connection = new IdSecureHttp(updated, await readFile(config.certificatePath, 'utf8'));
  await connection.call('/api/util/configUI', 'GET', undefined, 10000);
  await withIntegrationConfigLock(path, () => replaceIntegrationJson(path, updated, original));
  console.log(
    'Conexão validada. Configuração atualizada com sucesso. Reinicie a aplicação para descartar a sessão antiga.',
  );
} catch (error) {
  console.error(
    error?.kind
      ? 'Não foi possível validar a conexão: ' +
          error.kind +
          (error.httpStatus ? ' · HTTP ' + error.httpStatus + ' · etapa ' + error.phase : '')
      : error.message,
  );
  process.exitCode = 1;
}
