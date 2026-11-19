import { open, readFile, writeFile, rename, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function withIntegrationConfigLock(path, action) {
  const lockPath = path + '.lock';
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error(
        'Configuração em atualização ou bloqueio residual. Confira o processo antes de remover o arquivo .lock.',
      );
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
export async function replaceIntegrationJson(path, value, expected) {
  const actual = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (actual !== expected)
    throw Error(
      'A configuração mudou durante a preparação. Nenhum arquivo mais recente foi substituído.',
    );
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (expected === null) {
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code === 'EEXIST')
          throw Error(
            'Uma configuração foi criada durante a preparação. Nenhum arquivo foi substituído.',
          );
        throw error;
      }
    } else {
      if ((await readFile(path, 'utf8')) !== expected)
        throw Error(
          'A configuração mudou durante a preparação. Nenhum arquivo mais recente foi substituído.',
        );
      await rename(temporary, path);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
