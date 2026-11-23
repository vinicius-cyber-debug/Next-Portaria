import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import type { PostgresDatabase } from '../persistence/postgres.ts';
import type { MediaContext, MediaUser } from '../persistence/contracts.ts';
import { IdSecureHttp, type IdSecureConfig } from './idsecure-http.ts';
import { IntegrationError } from './contracts.ts';
import {
  withIntegrationConfigLock,
  replaceIntegrationJson,
} from '../../scripts/integration-config-files.mjs';

type Connection = {
  call: (path: string, method: 'GET', body: undefined, timeout: number) => Promise<unknown>;
};
type Options = {
  onChanged?: () => void | Promise<void>;
  canEdit?: () => boolean;
  createConnection?: (config: IdSecureConfig, certificate: string) => Connection;
  minimumIntervalMs?: number;
  now?: () => number;
};
type Stored = {
  original: string | null;
  config: IdSecureConfig | null;
  certificate: string | null;
};
type Candidate = {
  config: IdSecureConfig;
  certificate: string;
  publicCertificate: X509Certificate;
};
class ConfigError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(code: string, message: string, status = 400, retryAfterSeconds?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const deny = () => {
  throw new ConfigError(
    'FORBIDDEN',
    'Somente administradores ativos podem configurar a central.',
    403,
  );
};
function administrator(user: MediaUser) {
  if (user.status !== 'active' || user.role !== 'admin') deny();
}
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
}
function value(input: unknown, label: string, max = 200) {
  if (typeof input !== 'string' || !input.trim() || input.length > max)
    throw new ConfigError('CONTROLID_INVALID', `${label} inválido.`);
  return input.trim();
}
function failure(error: unknown): Response {
  if (error instanceof ConfigError)
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        },
      },
      error.status,
      error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : {},
    );
  if (error instanceof IntegrationError) {
    const messages = {
      authentication: 'A central recusou o usuário ou a senha. Confira a credencial na central.',
      offline: 'Não foi possível comunicar com a central pelo endereço e certificado informados.',
      timeout: 'A central não respondeu dentro do prazo.',
      unsupported: 'O endereço não oferece o recurso de leitura esperado do iDSecure.',
      invalid_input: 'Confira o endereço HTTPS privado, a credencial e o certificado da central.',
      aborted: 'O teste de conexão foi cancelado.',
    };
    const diagnostic = error as IntegrationError & { httpStatus?: unknown; phase?: unknown };
    return json(
      {
        error: {
          code: 'CONTROLID_' + error.kind.toUpperCase(),
          message: messages[error.kind],
          ...(typeof diagnostic.httpStatus === 'number'
            ? { httpStatus: diagnostic.httpStatus }
            : {}),
          ...(['authentication', 'api'].includes(String(diagnostic.phase))
            ? { phase: diagnostic.phase }
            : {}),
        },
      },
      ['offline', 'timeout'].includes(error.kind) ? 503 : 422,
    );
  }
  const authorization = error as { status?: unknown; code?: unknown } | null;
  if (authorization && (authorization.status === 401 || authorization.status === 403))
    return json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Sua sessão ou permissão mudou. Entre novamente para continuar.',
        },
      },
      Number(authorization.status),
    );
  return json(
    {
      error: {
        code: 'CONTROLID_STORAGE',
        message:
          'Não foi possível acessar ou salvar a configuração protegida. Confira as permissões do serviço.',
      },
    },
    500,
  );
}
function privateOrigin(input: string) {
  try {
    const url = new URL(input),
      parts = url.hostname.split('.').map(Number);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      isIP(url.hostname) !== 4 ||
      !(
        parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      )
    )
      throw Error();
    return url.origin;
  } catch {
    throw new ConfigError(
      'CONTROLID_INVALID',
      'Informe um endereço HTTPS com IPv4 privado, sem caminhos ou credenciais na URL.',
    );
  }
}
async function requestBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body)
    throw new ConfigError('CONTROLID_INVALID', 'Envie a configuração em JSON.', 415);
  const reader = request.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    body = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 80 * 1024) {
      await reader.cancel();
      throw new ConfigError('CONTROLID_INVALID', 'Configuração excede o tamanho permitido.', 413);
    }
    body += decoder.decode(part.value, { stream: true });
  }
  try {
    const parsed = JSON.parse(body + decoder.decode());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    const allowed = ['origin', 'username', 'password', 'certificatePem', 'sourceId', 'version'];
    if (Object.keys(parsed).some((key) => !allowed.includes(key))) throw Error();
    return parsed;
  } catch {
    throw new ConfigError('CONTROLID_INVALID', 'Campos de configuração inválidos.');
  }
}

/** The web editor only establishes a pinned, read-only connection to iDSecure. */
export class IdSecureAdminConfig {
  private readonly db: PostgresDatabase;
  private readonly options: Options;
  private readonly path: string | null;
  private readonly secret = randomBytes(32);
  private busy = false;
  private nextAttempt = 0;
  private readonly clock: () => number;
  constructor(db: PostgresDatabase, configPath: string | null, options: Options = {}) {
    this.db = db;
    this.options = options;
    this.path = configPath ? resolve(configPath) : null;
    this.clock = options.now ?? Date.now;
  }
  private version(original: string | null) {
    return createHmac('sha256', this.secret)
      .update(original === null ? '\0missing' : '\x01' + original)
      .digest('hex');
  }
  private editable() {
    return Boolean(this.path) && (this.options.canEdit?.() ?? true);
  }
  private requireEditable() {
    if (!this.editable())
      throw new ConfigError(
        'CONTROLID_MANAGED_EXTERNALLY',
        'A integração de saída está ativa. Gerencie a conexão no servidor.',
        409,
      );
  }
  private async stored(): Promise<Stored> {
    if (!this.path) return { original: null, config: null, certificate: null };
    let original: string;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw Error();
      original = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { original: null, config: null, certificate: null };
      throw new ConfigError(
        'CONTROLID_CONFIG_INVALID',
        'A configuração existente precisa de revisão antes de ser substituída.',
        409,
      );
    }
    try {
      const config = JSON.parse(original) as IdSecureConfig;
      if (
        config.mode !== 'read_only' ||
        typeof config.certificatePath !== 'string' ||
        !isAbsolute(config.certificatePath) ||
        typeof config.sourceId !== 'string' ||
        !/^[a-z0-9_-]{2,60}$/.test(config.sourceId) ||
        typeof config.origin !== 'string' ||
        typeof config.username !== 'string' ||
        config.username.length > 150 ||
        typeof config.password !== 'string' ||
        config.password.length > 1024 ||
        typeof config.fingerprint256 !== 'string' ||
        !/^([\da-f]{2}:){31}[\da-f]{2}$/i.test(config.fingerprint256)
      )
        throw Error();
      config.origin = privateOrigin(config.origin);
      let certificate: string | null = null;
      try {
        const info = await lstat(config.certificatePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw Error();
        certificate = await readFile(config.certificatePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { original, config, certificate };
    } catch {
      throw new ConfigError(
        'CONTROLID_CONFIG_INVALID',
        'A configuração ou o certificado existente precisa de revisão antes de ser substituído.',
        409,
      );
    }
  }
  private public(stored: Stored) {
    let certificate: X509Certificate | null = null;
    try {
      if (stored.certificate) certificate = new X509Certificate(stored.certificate);
    } catch {
      /* reported without exposing file contents */
    }
    return {
      supported: Boolean(this.path),
      editable: this.editable(),
      configured: Boolean(stored.config),
      origin: stored.config?.origin ?? '',
      username:
        stored.config && stored.config.username !== stored.config.password
          ? stored.config.username
          : '',
      sourceId: stored.config?.sourceId ?? 'idsecure-principal',
      fingerprint256: stored.config?.fingerprint256 ?? '',
      certificateExpiresAt: certificate ? new Date(certificate.validTo).toISOString() : null,
      certificateValid: Boolean(
        certificate &&
        Date.parse(certificate.validFrom) <= this.clock() &&
        Date.parse(certificate.validTo) > this.clock() &&
        certificate.fingerprint256.toUpperCase() === stored.config?.fingerprint256?.toUpperCase(),
      ),
      passwordConfigured: Boolean(stored.config?.password),
      version: this.version(stored.original),
      mode: 'read_only',
      hardwareWritesEnabled: false,
    };
  }
  private candidate(input: Record<string, unknown>, stored: Stored): Candidate {
    if (stored.config && input.sourceId !== undefined && input.sourceId !== stored.config.sourceId)
      throw new ConfigError(
        'CONTROLID_INVALID',
        'A identificação da fonte existente não pode ser alterada.',
      );
    const origin = privateOrigin(value(input.origin, 'Endereço HTTPS', 200)),
      username = value(input.username, 'Usuário', 150);
    if (input.password !== undefined && typeof input.password !== 'string')
      throw new ConfigError('CONTROLID_INVALID', 'Senha inválida.');
    if (
      stored.config &&
      (origin !== stored.config.origin || username !== stored.config.username) &&
      !input.password
    )
      throw new ConfigError(
        'CONTROLID_INVALID',
        'Informe a senha ao alterar o endereço ou o usuário.',
      );
    const password =
      input.password === undefined || input.password === ''
        ? stored.config?.password
        : input.password;
    if (typeof password !== 'string' || !password || password.length > 1024)
      throw new ConfigError('CONTROLID_INVALID', 'Informe a senha atual da central.');
    if (input.certificatePem !== undefined && typeof input.certificatePem !== 'string')
      throw new ConfigError('CONTROLID_INVALID', 'Certificado inválido.');
    const certificate =
      input.certificatePem === undefined || input.certificatePem === ''
        ? stored.certificate
        : input.certificatePem;
    if (
      !certificate ||
      Buffer.byteLength(certificate) > 64 * 1024 ||
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(certificate) ||
      (certificate.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
    )
      throw new ConfigError(
        'CONTROLID_INVALID',
        'Envie somente o certificado público da central em formato PEM, sem chave privada.',
      );
    let publicCertificate: X509Certificate;
    try {
      publicCertificate = new X509Certificate(certificate);
    } catch {
      throw new ConfigError('CONTROLID_INVALID', 'O certificado público PEM não é válido.');
    }
    if (
      !input.certificatePem &&
      stored.config &&
      publicCertificate.fingerprint256.toUpperCase() !== stored.config.fingerprint256.toUpperCase()
    )
      throw new ConfigError(
        'CONTROLID_INVALID',
        'O certificado salvo mudou. Confira e informe o certificado público da central.',
      );
    const pem = publicCertificate.toString();
    const sourceId =
      stored.config?.sourceId ??
      value(input.sourceId ?? 'idsecure-principal', 'Identificação da fonte', 60);
    const config: IdSecureConfig = {
      origin,
      username,
      password,
      mode: 'read_only',
      sourceId,
      fingerprint256: publicCertificate.fingerprint256,
      certificatePath: join(
        dirname(this.path!),
        'idsecure-trust-' + createHash('sha256').update(pem).digest('hex') + '.pem',
      ),
    };
    // Validation occurs before any HTTP request, even when tests inject the client.
    new IdSecureHttp(config, pem, { readOnly: true });
    return {
      config: { ...config, origin: new URL(origin).origin },
      certificate: pem,
      publicCertificate,
    };
  }
  private async check(candidate: Candidate) {
    const connection =
      this.options.createConnection?.(candidate.config, candidate.certificate) ??
      new IdSecureHttp(candidate.config, candidate.certificate, { readOnly: true });
    await connection.call('/api/util/configUI', 'GET', undefined, 10000);
    return { status: 'connected' as const, checkedAt: new Date(this.clock()).toISOString() };
  }
  private async audit(client: PoolClient, user: MediaUser, candidate: Candidate) {
    const at = new Date(this.clock()).toISOString();
    const event = {
      id: 'audit_' + randomUUID(),
      at,
      actor: user.name,
      actorId: user.id,
      role: user.role,
      action: 'CONTROLID_CONFIG_SAVE',
      entity: 'integration',
      entityId: candidate.config.sourceId,
      detail: 'Conexão de leitura Control iD/iDSecure atualizada.',
      changes: [
        {
          kind: 'integration',
          id: candidate.config.sourceId,
          before: null,
          after: {
            origin: candidate.config.origin,
            sourceId: candidate.config.sourceId,
            fingerprint256: candidate.config.fingerprint256,
            mode: 'read_only',
          },
        },
      ],
    };
    await client.query('INSERT INTO operational_audit(id,at,body) VALUES($1,$2,$3)', [
      event.id,
      at,
      JSON.stringify(event),
    ]);
    const revision = (
      await client.query(
        'UPDATE operational_meta SET revision=revision+1 WHERE id=1 RETURNING revision',
      )
    ).rows[0].revision;
    await client.query(
      'INSERT INTO operational_changes(revision,created_at,body) VALUES($1,$2,$3)',
      [
        revision,
        at,
        JSON.stringify({ collections: { audit: { upsert: [event], remove: [] } }, values: {} }),
      ],
    );
  }
  private async restore(original: string | null, expected: string) {
    if ((await readFile(this.path!, 'utf8')) !== expected) throw Error();
    if (original === null) {
      await rm(this.path!);
      return;
    }
    const temporary = this.path + '.' + randomUUID() + '.restore';
    try {
      await writeFile(temporary, original, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path!);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async handle(request: Request, context: MediaContext): Promise<Response> {
    try {
      administrator(context.user);
      const path = new URL(request.url).pathname;
      if (path === '/api/admin/controlid' && request.method === 'GET') {
        const stored = await this.stored();
        administrator(await context.authorize());
        return json(this.public(stored));
      }
      const saving = path === '/api/admin/controlid' && request.method === 'PUT';
      if (!saving && !(path === '/api/admin/controlid/test' && request.method === 'POST'))
        return json(
          { error: { code: 'METHOD_NOT_ALLOWED', message: 'Operação não disponível.' } },
          405,
        );
      if (!this.path)
        throw new ConfigError(
          'CONTROLID_UNAVAILABLE',
          'Esta instalação não permite configurar a central pelo portal.',
          503,
        );
      this.requireEditable();
      if (this.busy)
        throw new ConfigError(
          'CONTROLID_BUSY',
          'Já existe uma conexão em teste ou atualização. Aguarde.',
          409,
        );
      if (this.clock() < this.nextAttempt)
        throw new ConfigError(
          'CONTROLID_WAIT',
          'Aguarde alguns segundos antes de testar ou salvar novamente.',
          429,
          Math.max(1, Math.ceil((this.nextAttempt - this.clock()) / 1000)),
        );
      this.busy = true;
      try {
        const input = await requestBody(request),
          stored = await this.stored();
        if (
          (saving || input.version !== undefined) &&
          input.version !== this.version(stored.original)
        )
          throw new ConfigError(
            'CONTROLID_CONFIG_CHANGED',
            'A configuração mudou. Recarregue os dados antes de salvar.',
            409,
          );
        administrator(await context.authorize());
        const candidate = this.candidate(input, stored);
        this.nextAttempt = this.clock() + (this.options.minimumIntervalMs ?? 3000);
        const connection = await this.check(candidate);
        administrator(await context.authorize());
        if (!saving)
          return json({
            ok: true,
            connection,
            configuration: {
              origin: candidate.config.origin,
              username:
                candidate.config.username === candidate.config.password
                  ? ''
                  : candidate.config.username,
              sourceId: candidate.config.sourceId,
              fingerprint256: candidate.config.fingerprint256,
              certificateExpiresAt: new Date(candidate.publicCertificate.validTo).toISOString(),
            },
          });
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await withIntegrationConfigLock(this.path, async () => {
          const current = await this.stored();
          if (current.original !== stored.original)
            throw new ConfigError(
              'CONTROLID_CONFIG_CHANGED',
              'A configuração mudou. Recarregue os dados antes de salvar.',
              409,
            );
          let written = false;
          const expected = JSON.stringify(candidate.config, null, 2) + '\n';
          try {
            await this.db.transaction(async (client, scoped) => {
              await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
              const user = await context.authorize(scoped);
              administrator(user);
              this.requireEditable();
              await this.audit(client, user, candidate);
              try {
                await writeFile(candidate.config.certificatePath, candidate.certificate, {
                  flag: 'wx',
                  mode: 0o600,
                });
              } catch (error) {
                if (
                  (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
                  (await readFile(candidate.config.certificatePath, 'utf8')) !==
                    candidate.certificate
                )
                  throw error;
              }
              await replaceIntegrationJson(this.path, candidate.config, stored.original);
              written = true;
            });
          } catch (error) {
            if (written) {
              try {
                await this.restore(stored.original, expected);
              } catch {
                throw new ConfigError(
                  'CONTROLID_SAVE_UNCERTAIN',
                  'Não foi possível confirmar a recuperação da configuração. Solicite a revisão do serviço antes de tentar novamente.',
                  500,
                );
              }
            }
            throw error;
          }
        });
        let reloadPending = false;
        try {
          await this.options.onChanged?.();
        } catch {
          reloadPending = true;
        }
        return json({
          ...this.public({
            original: JSON.stringify(candidate.config, null, 2) + '\n',
            config: candidate.config,
            certificate: candidate.certificate,
          }),
          saved: true,
          connection,
          reloadPending,
        });
      } finally {
        this.busy = false;
      }
    } catch (error) {
      return failure(error);
    }
  }
}
