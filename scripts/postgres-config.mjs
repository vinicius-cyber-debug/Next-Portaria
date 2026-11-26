import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  explicitDatabaseEnvironment,
  hasDatabaseEnvironmentOverride,
  integrationConfigPaths,
} from '../lib/integrations/config-paths.mjs';
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const configPath = resolve(projectRoot, '.porto-runtime/postgres.json');
export function postgresConfig({ root = projectRoot } = {}) {
  const path = resolve(root, '.porto-runtime/postgres.json');
  if (!existsSync(path)) throw Error('PostgreSQL nao configurado. Execute a preparacao primeiro.');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (
    config.version !== 1 ||
    config.provider !== 'postgres' ||
    !config.database ||
    !config.mediaRoot
  )
    throw Error('Configuracao PostgreSQL invalida.');
  return config;
}
export function configuredIdSecurePath({
  root = projectRoot,
  env = process.env,
  explicitPath,
} = {}) {
  const override = explicitPath !== undefined || env.PORTO_IDSECURE_CONFIG !== undefined;
  const config =
    !override &&
    !hasDatabaseEnvironmentOverride(env) &&
    !explicitDatabaseEnvironment(env) &&
    existsSync(resolve(root, '.porto-runtime/postgres.json'))
      ? postgresConfig({ root })
      : undefined;
  const path = integrationConfigPaths({
    projectRoot: root,
    config,
    env,
    explicitIdSecurePath: explicitPath,
  }).idsecure;
  if (!path)
    throw Error(
      'A conexão iDSecure não foi configurada neste ambiente. Informe um arquivo explícito de teste ou de servidor.',
    );
  return path;
}
export function loadApplicationEnvironment({ root = projectRoot, env = process.env } = {}) {
  if (env.PORTO_DB_PROVIDER === 'sqlite') return 'sqlite';
  if (explicitDatabaseEnvironment(env)) return 'postgres';
  if (hasDatabaseEnvironmentOverride(env))
    throw Error(
      'Ambiente explícito incompleto. Informe PORTO_DB_PROVIDER=postgres, PORTO_PG_CONFIG e PORTO_MEDIA_ROOT sem herdar dados da instalação.',
    );
  if (!existsSync(resolve(root, '.porto-runtime/postgres.json'))) {
    if (env.PORTO_DB_PROVIDER === 'postgres') throw Error('Configuracao PostgreSQL ausente.');
    return 'sqlite';
  }
  const config = postgresConfig({ root }),
    paths = integrationConfigPaths({ projectRoot: root, config, env });
  env.PORTO_DB_PROVIDER = 'postgres';
  env.PORTO_PG_CONFIG ??= JSON.stringify(config.database);
  env.PORTO_MEDIA_ROOT ??= config.mediaRoot;
  if (paths.idsecure) env.PORTO_IDSECURE_CONFIG ??= paths.idsecure;
  if (paths.exitAccess && existsSync(paths.exitAccess)) env.PORTO_EXIT_CONFIG ??= paths.exitAccess;
  return 'postgres';
}
