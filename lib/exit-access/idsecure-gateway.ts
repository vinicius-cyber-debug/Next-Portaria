import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { IdSecureHttp } from '../integrations/idsecure-http.ts';
import { monitorTime } from '../integrations/monitor.ts';
import { IntegrationError } from '../integrations/contracts.ts';
import type { ExitGateway, ExitTarget, ExitBinding, PendingExit } from './types.ts';

type Row = Record<string, unknown>;
export type ExitGatewayConfig = {
  version: 1;
  enabled: boolean;
  credentialFile: string;
  target: ExitTarget;
};
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IntegrationError('invalid_input');
  return value as Row;
}
function array(value: unknown): Row[] {
  const result = Array.isArray(value) ? value : row(value).data;
  if (!Array.isArray(result) || result.length > 1000) throw new IntegrationError('invalid_input');
  return result.map(row);
}
function identifier(value: unknown): string {
  const valueAsText = String(value ?? '');
  if (
    !/^[1-9]\d{0,19}$/.test(valueAsText) ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  )
    throw new IntegrationError('invalid_input');
  return valueAsText;
}
const items = (value: unknown) =>
  (Array.isArray(value) ? value : []).map((item) => identifier(row(item).id)).sort();
export function targetHash(target: ExitTarget) {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(target).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
}
export function validateExitGatewayConfig(value: unknown): ExitGatewayConfig {
  const config = row(value),
    target = row(config.target);
  if (
    config.version !== 1 ||
    typeof config.enabled !== 'boolean' ||
    typeof config.credentialFile !== 'string' ||
    !config.credentialFile ||
    typeof target.sourceId !== 'string' ||
    !/^[a-z0-9_-]{2,60}$/.test(target.sourceId) ||
    typeof target.deviceName !== 'string' ||
    !target.deviceName ||
    !Number.isInteger(target.model) ||
    typeof target.firmware !== 'string' ||
    !target.firmware ||
    typeof target.serial !== 'string' ||
    !target.serial ||
    !['clockwise', 'anticlockwise'].includes(String(target.exitRotation)) ||
    typeof target.exitAreaName !== 'string' ||
    !target.exitAreaName
  )
    throw new IntegrationError('invalid_input');
  for (const key of ['deviceId', 'entryReaderId', 'exitReaderId', 'entryAreaId', 'exitAreaId']) {
    if (typeof target[key] !== 'string') throw new IntegrationError('invalid_input');
    identifier(target[key]);
  }
  if (target.entryReaderId === target.exitReaderId || target.entryAreaId === target.exitAreaId)
    throw new IntegrationError('invalid_input');
  return value as ExitGatewayConfig;
}
export class DisabledExitGateway implements ExitGateway {
  readonly configurationError?: string;
  constructor(configurationError?: string) {
    this.configurationError = configurationError;
  }
  readonly mode = 'disabled' as const;
  readonly targetHash = '';
  readonly sourceId = '';
  readonly deviceId = '';
  async inspect() {
    throw new IntegrationError('unsupported');
  }
  async verifyBinding() {
    throw new IntegrationError('unsupported');
  }
  async provision(): Promise<string> {
    throw new IntegrationError('unsupported');
  }
  async remove() {
    throw new IntegrationError('unsupported');
  }
  async readEvents(): Promise<PendingExit[]> {
    return [];
  }
  async authorize() {
    throw new IntegrationError('unsupported');
  }
  async confirm(): Promise<boolean> {
    return false;
  }
}
/** No weekly grants, no user edits and no unconditional relay action. */
export class IdSecureExitGateway implements ExitGateway {
  readonly mode = 'live' as const;
  readonly targetHash: string;
  readonly sourceId: string;
  readonly deviceId: string;
  readonly config: ExitGatewayConfig;
  #http: IdSecureHttp;
  #lastInspection = 0;
  constructor(config: ExitGatewayConfig, http: IdSecureHttp) {
    this.config = structuredClone(validateExitGatewayConfig(config));
    Object.freeze(this.config.target);
    Object.freeze(this.config);
    if (!config.enabled || config.target.sourceId !== http.sourceId)
      throw new IntegrationError('invalid_input');
    this.#http = http;
    this.targetHash = targetHash(config.target);
    this.sourceId = config.target.sourceId;
    this.deviceId = config.target.deviceId;
  }
  static async fromFile(path: string): Promise<ExitGateway> {
    if (!path) return new DisabledExitGateway();
    const config = validateExitGatewayConfig(JSON.parse(await readFile(path, 'utf8')));
    return config.enabled
      ? new IdSecureExitGateway(config, await IdSecureHttp.fromFile(config.credentialFile))
      : new DisabledExitGateway();
  }
  private async get(path: string) {
    return this.#http.call(path, 'GET', undefined, 3000);
  }
  private async device() {
    return row(await this.get('/api/device/' + this.deviceId));
  }
  async inspect() {
    const target = this.config.target;
    const [configValue, device, statusValue, areaValue] = await Promise.all([
      this.get('/api/util/configUI'),
      this.device(),
      this.get('/api/util/DevicesSyncStatus'),
      this.get('/api/area/'),
    ]);
    const settings = row(configValue),
      status = array(statusValue).filter((item) => identifier(item.id) === this.deviceId);
    if (
      settings.Mode !== 2 ||
      settings.ManualAuthorization !== true ||
      settings.DefaultContingency !== false ||
      status.length !== 1 ||
      status[0].syncStatus !== 0
    )
      throw new IntegrationError('unsupported');
    if (
      identifier(device.id) !== this.deviceId ||
      device.name !== target.deviceName ||
      device.model !== target.model ||
      device.versao !== target.firmware ||
      device.serial !== target.serial
    )
      throw new IntegrationError('invalid_input');
    const readers = array(device.readers);
    if (
      !readers.some(
        (item) =>
          identifier(item.id) === target.exitReaderId &&
          identifier(item.idAreaFrom) === target.entryAreaId &&
          identifier(item.idAreaTo) === target.exitAreaId,
      ) ||
      !readers.some(
        (item) =>
          identifier(item.id) === target.entryReaderId &&
          identifier(item.idAreaFrom) === target.exitAreaId &&
          identifier(item.idAreaTo) === target.entryAreaId,
      )
    )
      throw new IntegrationError('invalid_input');
    const exitArea = array(areaValue).filter((item) => item.name === target.exitAreaName);
    if (exitArea.length !== 1 || identifier(exitArea[0].id) !== target.exitAreaId)
      throw new IntegrationError('invalid_input');
    const expectedExit =
      device.entranceSpinDirection === 'clockwise'
        ? 'anticlockwise'
        : device.entranceSpinDirection === 'anticlockwise'
          ? 'clockwise'
          : null;
    if (expectedExit !== target.exitRotation) throw new IntegrationError('invalid_input');
    const probe = row(await this.#http.call('/api/util/connect', 'POST', device, 3000));
    if (
      probe.success !== true ||
      probe.serial !== target.serial ||
      probe.version !== target.firmware
    )
      throw new IntegrationError('offline');
    this.#lastInspection = Date.now();
  }
  private async subject(binding: ExitBinding) {
    if (binding.source_id !== this.sourceId || binding.target_hash !== this.targetHash)
      throw new IntegrationError('invalid_input');
    // Resolve the mutable row again; never use a stale local recordId to change permissions.
    let found: Row | null = null;
    for (let offset = 0; offset < 100000; offset += 100) {
      const query = new URLSearchParams({
        idType: '0',
        deleted: 'false',
        draw: '1',
        start: String(offset),
        length: '100',
        'columns[0][data]': 'idDevice',
        'columns[0][name]': 'idDevice',
        'order[0][column]': '0',
        'order[0][dir]': 'asc',
      });
      const result = row(await this.#http.call('/api/user/list?' + query, 'POST', null, 3000));
      const people = array(result);
      const total = Number(result.recordsFiltered);
      if (
        result.error ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        total > 100000 ||
        people.length > 100
      )
        throw new IntegrationError('invalid_input');
      for (const person of people) {
        if (identifier(person.idDevice) === binding.native_user_id) {
          if (found) throw new IntegrationError('invalid_input');
          found = person;
        }
      }
      if (!people.length || offset + people.length >= total) break;
    }
    if (!found) throw new IntegrationError('invalid_input');
    const detail = row(await this.get('/api/user/' + identifier(found.id)));
    if (
      identifier(detail.idDevice) !== binding.native_user_id ||
      detail.idType !== 0 ||
      detail.inativo !== false ||
      detail.blackList !== false ||
      detail.deleted === true
    )
      throw new IntegrationError('invalid_input');
    return identifier(detail.id);
  }
  private ruleName(binding: ExitBinding) {
    return (
      'NP EXIT ' +
      createHash('sha256')
        .update(this.sourceId + '|' + binding.native_user_id + '|' + this.targetHash)
        .digest('hex')
        .slice(0, 24)
    );
  }
  private async checkedRule(binding: ExitBinding, ruleId: string, recordId: string) {
    const rule = row(await this.get('/api/rule/' + identifier(ruleId)));
    if (
      rule.name !== this.ruleName(binding) ||
      rule.idType !== 1 ||
      rule.ManualAuthorizationOption !== 1 ||
      rule.ReEntryLockEnabled ||
      rule.EscortEnabled ||
      rule.IsBiometryDisabled ||
      rule.IsCardDisabled ||
      rule.IsPasswordDisabled ||
      JSON.stringify(items(rule.usersList)) !== JSON.stringify([recordId]) ||
      JSON.stringify(items(rule.devicesList)) !== JSON.stringify([this.deviceId]) ||
      JSON.stringify(items(rule.areasList)) !== JSON.stringify([this.config.target.exitAreaId]) ||
      JSON.stringify(items(rule.schedulesList)) !== '["1"]' ||
      items(rule.groupsList).length ||
      items(rule.typesList).length ||
      items(rule.visitorsList).length
    )
      throw new IntegrationError('invalid_input');
    return rule;
  }
  async verifyBinding(binding: ExitBinding) {
    if (!binding.manual_rule_id) throw new IntegrationError('invalid_input');
    await this.inspect();
    const recordId = await this.subject(binding);
    await this.checkedRule(binding, binding.manual_rule_id, recordId);
  }
  async provision(binding: ExitBinding) {
    await this.inspect();
    const recordId = await this.subject(binding),
      name = this.ruleName(binding);
    const matches = array(await this.get('/api/rule/')).filter((item) => item.name === name);
    if (matches.length > 1) throw new IntegrationError('invalid_input');
    if (!matches.length) {
      const payload = {
        name,
        idType: 1,
        users: [recordId],
        groups: [],
        types: [],
        visitors: [],
        devices: [this.deviceId],
        areas: [this.config.target.exitAreaId],
        schedules: [1],
        creditTypes: [],
        ManualAuthorizationOption: 1,
        ReEntryLockEnabled: 0,
        ReEntryLockPeriod: 0,
        EscortEnabled: 0,
        EscortPeriod: 8,
        IsBiometryDisabled: false,
        IsCardDisabled: false,
        IsPasswordDisabled: false,
        RandomInspectPercent: 0,
        RandomInspectOnExit: null,
        selectedEscorted: [],
        selectedEscortUsers: [],
      };
      // An ambiguous create is reconciled by its deterministic owned name, never retried blindly.
      try {
        const result = await this.#http.call('/api/rule/', 'POST', payload, 3000);
        if (result && row(result).success === false) throw new IntegrationError('offline');
      } catch (error) {
        if (error instanceof IntegrationError && error.kind === 'authentication') throw error;
      }
    }
    const after = array(await this.get('/api/rule/')).filter((item) => item.name === name);
    if (after.length !== 1) throw new IntegrationError('offline');
    const ruleId = identifier(after[0].id);
    await this.checkedRule(binding, ruleId, recordId);
    return ruleId;
  }
  async remove(binding: ExitBinding) {
    const matches = array(await this.get('/api/rule/')).filter(
      (item) => item.name === this.ruleName(binding),
    );
    if (!matches.length) return;
    if (matches.length !== 1) throw new IntegrationError('invalid_input');
    const recordId = await this.subject(binding),
      ruleId = identifier(matches[0].id);
    await this.checkedRule(binding, ruleId, recordId);
    try {
      await this.#http.call('/api/rule/' + ruleId, 'DELETE', undefined, 3000);
    } catch (error) {
      if (error instanceof IntegrationError && error.kind === 'authentication') throw error;
    }
    if (array(await this.get('/api/rule/')).some((item) => identifier(item.id) === ruleId))
      throw new IntegrationError('offline');
  }
  async readEvents(): Promise<PendingExit[]> {
    const query = new URLSearchParams({
      mode: 'loop',
      modevalue: '',
      areas: this.config.target.exitAreaId,
      limite: '50',
      events: '',
      parkings: '',
      time: '',
    });
    const response = await this.get('/api/access/monitor?' + query),
      records = array(response),
      events: PendingExit[] = [];
    const identities = new Map<string, string>();
    for (const record of records) {
      if (String(record.idDevice) !== this.deviceId) continue;
      const area =
        record.idArea == null
          ? record.area === this.config.target.exitAreaName
            ? this.config.target.exitAreaId
            : null
          : identifier(record.idArea);
      if (
        area !== this.config.target.exitAreaId ||
        (record.idReader != null && String(record.idReader) !== this.config.target.exitReaderId)
      )
        continue;
      const code = Number(record.eventCode);
      if (code === 8 && Number(record.functionDetail) !== 1) continue;
      if (record.idUser == null || String(record.idUser) === '0') continue;
      const recordId = identifier(record.idUser);
      let native = identities.get(recordId);
      if (!native) {
        const person = row(await this.get('/api/user/' + recordId));
        if (
          person.idType !== 0 ||
          person.inativo !== false ||
          person.blackList !== false ||
          person.deleted === true
        )
          continue;
        native = identifier(person.idDevice);
        identities.set(recordId, native);
      }
      events.push({
        eventId: identifier(record.idLog),
        recordId,
        nativeUserId: native,
        deviceId: this.deviceId,
        areaId: area,
        occurredAt: monitorTime(record.time),
        state: code === 8 ? 'pending' : code === 7 ? 'authorized' : code === 6 ? 'denied' : 'other',
      });
    }
    return events;
  }
  async authorize(event: PendingExit, expiresAt: string) {
    if (Date.now() + 3500 >= Date.parse(expiresAt)) throw new IntegrationError('invalid_input');
    if (
      Date.now() - this.#lastInspection > 10000 ||
      event.state !== 'pending' ||
      event.deviceId !== this.deviceId ||
      event.areaId !== this.config.target.exitAreaId ||
      Date.now() - Date.parse(event.occurredAt) > 10000 ||
      Date.parse(event.occurredAt) > Date.now() + 1000
    )
      throw new IntegrationError('invalid_input');
    // A positive event id is mandatory. '0', 'both', generic door/open and arbitrary paths are never exposed.
    const logId = identifier(event.eventId);
    const current = (await this.readEvents()).find((item) => item.eventId === logId);
    if (
      !current ||
      current.state !== 'pending' ||
      current.recordId !== event.recordId ||
      current.nativeUserId !== event.nativeUserId
    )
      throw new IntegrationError('invalid_input');
    if (Date.now() + 2500 >= Date.parse(expiresAt)) throw new IntegrationError('invalid_input');
    const result = await this.#http.call(
      '/api/util/action/' +
        this.deviceId +
        '/catra/allow=' +
        this.config.target.exitRotation +
        ',reason=3/' +
        logId,
      'GET',
      undefined,
      2000,
    );
    if (result && row(result).success === false) throw new IntegrationError('offline');
  }
  async confirm(event: PendingExit) {
    const current = (await this.readEvents()).find((item) => item.eventId === event.eventId);
    return Boolean(
      current &&
      current.state === 'authorized' &&
      current.nativeUserId === event.nativeUserId &&
      current.deviceId === this.deviceId &&
      current.areaId === this.config.target.exitAreaId,
    );
  }
}
