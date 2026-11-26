import { isAbsolute, resolve } from 'node:path';

export function explicitDatabaseEnvironment(env) {
  return (
    env.PORTO_DB_PROVIDER === 'postgres' && Boolean(env.PORTO_PG_CONFIG && env.PORTO_MEDIA_ROOT)
  );
}

export function hasDatabaseEnvironmentOverride(env) {
  return env.PORTO_PG_CONFIG !== undefined || env.PORTO_MEDIA_ROOT !== undefined;
}

/** Explicit settings win; isolated database environments never inherit installed connections. */
export function integrationConfigPaths({ projectRoot, config, env = {}, explicitIdSecurePath }) {
  const explicit = (value) => (value ? resolve(value) : null);
  const isolated = explicitDatabaseEnvironment(env) || hasDatabaseEnvironmentOverride(env);
  const server = config?.runtimeProfile === 'server';
  if (server && (!config.dataRoot || !isAbsolute(config.dataRoot)))
    throw Error('O perfil de servidor exige uma pasta de dados absoluta.');
  const base = server
    ? resolve(config.dataRoot, 'integrations')
    : resolve(projectRoot, '.porto-runtime');
  return {
    idsecure:
      explicitIdSecurePath !== undefined
        ? explicit(explicitIdSecurePath)
        : env.PORTO_IDSECURE_CONFIG !== undefined
          ? explicit(env.PORTO_IDSECURE_CONFIG)
          : isolated
            ? null
            : resolve(base, 'idsecure.json'),
    exitAccess:
      env.PORTO_EXIT_CONFIG !== undefined
        ? explicit(env.PORTO_EXIT_CONFIG)
        : isolated
          ? null
          : resolve(base, 'exit-access.json'),
  };
}
