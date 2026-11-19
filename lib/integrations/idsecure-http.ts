import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { IntegrationError } from './contracts.ts';

export type IdSecureConfig = {
  origin: string;
  username: string;
  password: string;
  fingerprint256: string;
  certificatePath: string;
  mode: 'read_only';
  sourceId: string;
};
export function parseDirectoryJson(text: string): unknown {
  return JSON.parse(
    text.replace(
      /"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (whole, number: string | undefined) =>
        number && /^-?\d+$/.test(number) && !Number.isSafeInteger(Number(number))
          ? JSON.stringify(number)
          : whole,
    ),
  );
}
export class IdSecureHttp {
  readonly sourceId: string;
  #config: IdSecureConfig;
  #ca: string;
  #token: string | null = null;
  constructor(config: IdSecureConfig, ca: string) {
    const url = new URL(config.origin),
      parts = url.hostname.split('.').map(Number);
    const privateHost =
      isIP(url.hostname) === 4 &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
    if (
      config.mode !== 'read_only' ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !privateHost ||
      typeof config.username !== 'string' ||
      !config.username ||
      typeof config.password !== 'string' ||
      !config.password ||
      typeof config.sourceId !== 'string' ||
      !/^([\da-f]{2}:){31}[\da-f]{2}$/i.test(config.fingerprint256) ||
      !/^[a-z0-9_-]{2,60}$/.test(config.sourceId)
    )
      throw new IntegrationError('invalid_input');
    // Reject credentials that repeat the username before making any network request.
    if (config.password === config.username) throw new IntegrationError('authentication');
    const cert = new X509Certificate(ca);
    if (
      cert.fingerprint256.toUpperCase() !== config.fingerprint256.toUpperCase() ||
      Date.parse(cert.validFrom) > Date.now() ||
      Date.parse(cert.validTo) <= Date.now()
    )
      throw new IntegrationError('invalid_input');
    this.#config = { ...config, origin: url.origin };
    this.#ca = ca;
    this.sourceId = config.sourceId;
  }
  static async fromFile(path: string) {
    const config = JSON.parse(await readFile(path, 'utf8')) as IdSecureConfig;
    return new IdSecureHttp(config, await readFile(config.certificatePath, 'utf8'));
  }
  async call(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body: unknown,
    timeout = 10000,
  ): Promise<unknown> {
    if (
      !path.startsWith('/api/') ||
      path.includes('://') ||
      path.includes('..') ||
      path.includes('#') ||
      path.includes('\\')
    )
      throw new IntegrationError('invalid_input');
    if (!this.#token) {
      const result = (await this.raw(
        '/api/login/',
        'POST',
        { username: this.#config.username, password: this.#config.password },
        timeout,
        false,
      )) as { accessToken?: unknown };
      if (
        typeof result?.accessToken !== 'string' ||
        !result.accessToken ||
        result.accessToken.length > 16000
      )
        throw new IntegrationError('authentication');
      this.#token = result.accessToken;
    }
    return this.raw(path, method, body, timeout, true);
  }
  private async raw(
    path: string,
    method: string,
    body: unknown,
    timeout: number,
    authenticated: boolean,
  ): Promise<unknown> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        this.#config.origin + path,
        {
          method,
          ca: this.#ca,
          allowPartialTrustChain: true,
          checkServerIdentity: (_host, cert) =>
            cert.fingerprint256.toUpperCase() === this.#config.fingerprint256.toUpperCase()
              ? undefined
              : Error('Certificate mismatch'),
          timeout,
          headers: {
            accept: 'application/json',
            ...(encoded === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(encoded),
                }),
            ...(authenticated ? { authorization: 'Bearer ' + this.#token } : {}),
          },
        },
        (response) => {
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 6 * 1024 * 1024) {
              req.destroy();
              reject(new IntegrationError('invalid_input'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (
              response.statusCode === 401 ||
              response.statusCode === 403 ||
              (!authenticated && response.statusCode === 400)
            ) {
              this.#token = null;
              reject(
                Object.assign(new IntegrationError('authentication'), {
                  httpStatus: response.statusCode,
                  phase: authenticated ? 'api' : 'authentication',
                }),
              );
              return;
            }
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                Object.assign(
                  new IntegrationError(response.statusCode === 404 ? 'unsupported' : 'offline'),
                  {
                    httpStatus: response.statusCode,
                    phase: authenticated ? 'api' : 'authentication',
                  },
                ),
              );
              return;
            }
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve(text ? parseDirectoryJson(text) : null);
            } catch {
              reject(new IntegrationError('invalid_input'));
            }
          });
          response.on('error', () => reject(new IntegrationError('offline')));
        },
      );

      const deadline = setTimeout(() => req.destroy(new IntegrationError('timeout')), timeout);
      deadline.unref();
      req.once('close', () => clearTimeout(deadline));
      req.on('timeout', () => req.destroy(new IntegrationError('timeout')));
      req.on('error', (error) =>
        reject(error instanceof IntegrationError ? error : new IntegrationError('offline')),
      );
      req.end(encoded);
    });
  }
}
