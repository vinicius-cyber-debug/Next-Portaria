import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { IntegrationError } from './contracts.ts';

import { IdSecureHttp } from './idsecure-http.ts';
import type { IdSecureConfig } from './idsecure-http.ts';
export type { IdSecureConfig } from './idsecure-http.ts';
export { parseDirectoryJson } from './idsecure-http.ts';
export type DirectoryPerson = {
  recordId: string;
  nativeId: string;
  name: string;
  registration: string;
  documentLast4: string;
  inactive: boolean;
  blocked: boolean;
  visitor: boolean;
};
export type DirectoryPhoto = {
  bytes: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  sha256: string;
};
type ExternalRow = Record<string, unknown>;
type DeviceSynchronization =
  'synchronized' | 'synchronizing' | 'failed' | 'collecting_logs' | 'unknown';
const MAX_RESPONSE = 6 * 1024 * 1024;
function nativeId(value: unknown) {
  const text = String(value ?? '');
  if (
    !/^\d{1,20}$/.test(text) ||
    BigInt(text) < BigInt(1) ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  )
    throw new IntegrationError('invalid_input');
  return BigInt(text).toString();
}
function flag(value: unknown) {
  if (value === 'Sim') return true;
  if (value === 'Não') return false;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value == null)
    return false;
  throw new IntegrationError('invalid_input');
}
export function directoryPerson(row: ExternalRow, { list = false } = {}): DirectoryPerson {
  if (
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name.length > 150 ||
    row.inativo == null ||
    row.blackList == null ||
    row.idType == null ||
    !Number.isSafeInteger(Number(row.idType))
  )
    throw new IntegrationError('invalid_input');
  const registration =
      typeof row.registration === 'string' ? row.registration.trim().slice(0, 80) : '',
    document = String(row.cpf ?? '').replace(/\D/g, '');
  return {
    recordId: nativeId(row.id),
    nativeId: nativeId(row.idDevice),
    name: row.name.trim(),
    registration: /^\d{11,14}$/.test(registration) ? '' : registration,
    documentLast4: document.length === 11 ? document.slice(-4) : '',
    inactive:
      (list && ['Sim', 'Não'].includes(String(row.inativo))
        ? !flag(row.inativo)
        : flag(row.inativo)) || flag(row.deleted),
    blocked: flag(row.blackList),
    visitor: Number(row.idType ?? 0) !== 0,
  };
}
export function directoryPhoto(value: unknown): DirectoryPhoto | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_RESPONSE)
    throw new IntegrationError('invalid_input');
  const encoded = value.replace(/^data:image\/(?:jpeg|png|webp);base64,/, ''),
    bytes = Buffer.from(encoded, 'base64');
  if (
    !bytes.length ||
    bytes.length > 4 * 1024 * 1024 ||
    bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/\s|=+$/g, '')
  )
    throw new IntegrationError('invalid_input');
  const contentType = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    ? 'image/jpeg'
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : null;
  if (!contentType) throw new IntegrationError('invalid_input');
  return { bytes, contentType, sha256: createHash('sha256').update(bytes).digest('hex') };
}
/** Central iDSecure directory, not a turnstile driver. No device writes or biometric-template methods. */
export class IdSecureReader {
  readonly mode = 'read_only';
  #connection: IdSecureHttp;
  constructor(config: IdSecureConfig, ca: string) {
    this.#connection = new IdSecureHttp(config, ca, { readOnly: true });
  }
  get sourceId() {
    return this.#connection.sourceId;
  }
  static async fromFile(path: string) {
    const config = JSON.parse(await readFile(path, 'utf8')) as IdSecureConfig;
    return new IdSecureReader(config, await readFile(config.certificatePath, 'utf8'));
  }
  private async call(path: string, method: 'GET' | 'POST', body: unknown): Promise<unknown> {
    if (!(
      (method === 'POST' && path.startsWith('/api/user/list?')) ||
      (method === 'GET' &&
        (/^\/api\/user\/\d+$/.test(path) ||
          path.startsWith('/api/access/monitor?') ||
          path === '/api/device/' ||
          path === '/api/util/DevicesSyncStatus'))
    ))
      throw new IntegrationError('unsupported');
    return this.#connection.call(path, method, body);
  }
  async readPage(offset = 0, limit = 50) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new IntegrationError('invalid_input');
    const query = new URLSearchParams({
      idType: '0',
      deleted: 'false',
      draw: '1',
      start: String(offset),
      length: String(limit),
      'columns[0][data]': 'idDevice',
      'columns[0][name]': 'idDevice',
      'order[0][column]': '0',
      'order[0][dir]': 'asc',
    });
    const result = (await this.call('/api/user/list?' + query, 'POST', null)) as ExternalRow;
    if (
      !Array.isArray(result?.data) ||
      result.data.length > limit ||
      !Number.isSafeInteger(Number(result.recordsFiltered)) ||
      Number(result.recordsFiltered) < 0 ||
      Number(result.recordsFiltered) > 100000 ||
      result.error
    )
      throw new IntegrationError('invalid_input');
    return {
      items: result.data.map((row) => directoryPerson(row as ExternalRow, { list: true })),
      total: Number(result.recordsFiltered),
    };
  }
  async readPhoto(person: DirectoryPerson) {
    const record = (await this.call(
      '/api/user/' + nativeId(person.recordId),
      'GET',
      undefined,
    )) as ExternalRow;
    if (nativeId(record.idDevice) !== person.nativeId || nativeId(record.id) !== person.recordId)
      throw new IntegrationError('invalid_input');
    const fresh = directoryPerson(record);
    person.inactive = fresh.inactive;
    person.blocked = fresh.blocked;
    person.visitor = fresh.visitor;
    return directoryPhoto(record.foto);
  }
  async readDevices() {
    const response = (await this.call('/api/device/', 'GET', undefined)) as ExternalRow,
      rows = Array.isArray(response) ? response : response.data;
    if (!Array.isArray(rows) || rows.length > 500) throw new IntegrationError('invalid_input');
    // The device record's isCurrentlyOnline may be historical. The vendor UI
    // polls this separate endpoint for synchronization; neither is a live probe.
    const statuses = await this.call('/api/util/DevicesSyncStatus', 'GET', undefined);
    if (!Array.isArray(statuses) || statuses.length > 500)
      throw new IntegrationError('invalid_input');
    const synchronization = new Map<string, DeviceSynchronization>();
    const kinds: DeviceSynchronization[] = [
      'synchronized',
      'synchronizing',
      'failed',
      'collecting_logs',
    ];
    for (const status of statuses as ExternalRow[]) {
      if (!status || typeof status !== 'object' || Array.isArray(status))
        throw new IntegrationError('invalid_input');
      const id = nativeId(status.id);
      if (synchronization.has(id)) throw new IntegrationError('invalid_input');
      synchronization.set(
        id,
        typeof status.syncStatus === 'number' && Number.isInteger(status.syncStatus)
          ? (kinds[status.syncStatus] ?? 'unknown')
          : 'unknown',
      );
    }
    return rows.map((row: ExternalRow) => ({
      id: nativeId(row.id),
      name: String(row.name ?? '').slice(0, 150),
      model: Number(row.model),
      firmware: String(row.versao ?? '').slice(0, 60),
      faceReaders: Number(row.idfaceCount ?? 0),
      online: row.isCurrentlyOnline === true,
      synchronization: synchronization.get(nativeId(row.id)) ?? 'unknown',
    }));
  }
  async readMonitor() {
    // The central returns its configured window (currently 15), regardless of limite.
    const query = new URLSearchParams({
      mode: 'logs',
      modevalue: '',
      areas: '',
      limite: '50',
      events: '',
      parkings: '',
    });
    const result = (await this.call(
      '/api/access/monitor?' + query,
      'GET',
      undefined,
    )) as ExternalRow;
    if (!Array.isArray(result?.data) || result.data.length > 500 || result.error)
      throw new IntegrationError('invalid_input');
    return result.data as ExternalRow[];
  }
}
