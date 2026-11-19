import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { handleApi } from '../../lib/server.ts';
import { ExitAccessRuntime } from '../../lib/exit-access/runtime.ts';
import { IntegrationError } from '../../lib/integrations/contracts.ts';

// This adapter exists only in isolated QA. The application cannot select it by configuration.
export class SyntheticExitGateway {
  mode = 'simulation';
  sourceId = 'qa-central';
  deviceId = '2';
  targetHash = 'qa-scoped-exit-target';
  events = [];
  calls = [];
  offline = false;
  ambiguous = false;
  confirmed = true;
  rules = new Map();
  async inspect() {
    if (this.offline) throw new IntegrationError('offline');
  }
  async verifyBinding(binding) {
    await this.inspect();
    assert.equal(binding.target_hash, this.targetHash);
    assert.equal(this.rules.get(binding.native_user_id), binding.manual_rule_id);
  }
  async provision(binding) {
    await this.inspect();
    this.calls.push(['provision', binding.native_user_id]);
    const id = this.rules.get(binding.native_user_id) || String(20 + this.rules.size);
    this.rules.set(binding.native_user_id, id);
    return id;
  }
  async remove(binding) {
    await this.inspect();
    this.calls.push(['remove', binding.native_user_id]);
    this.rules.delete(binding.native_user_id);
  }
  async readEvents() {
    await this.inspect();
    return structuredClone(this.events);
  }
  async authorize(event, expiresAt) {
    await this.inspect();
    assert.ok(Date.parse(expiresAt) > Date.now());
    this.calls.push(['authorize', event.eventId, event.nativeUserId]);
    if (this.ambiguous) throw new IntegrationError('offline');
    if (this.confirmed)
      this.events = this.events.map((row) =>
        row.eventId === event.eventId ? { ...row, state: 'authorized' } : row,
      );
  }
  async confirm(event) {
    return this.events.some((row) => row.eventId === event.eventId && row.state === 'authorized');
  }
  pending(nativeUserId = '101', extra = {}) {
    const event = {
      eventId: String(1000 + this.events.length),
      recordId: 'mutable-' + nativeUserId,
      nativeUserId,
      deviceId: this.deviceId,
      areaId: '4',
      occurredAt: new Date().toISOString(),
      state: 'pending',
      ...extra,
    };
    this.events.push(event);
    return event;
  }
}
export async function exitFixture({ db, owner }) {
  const gateway = new SyntheticExitGateway(),
    runtime = new ExitAccessRuntime(db, gateway),
    origin = 'http://127.0.0.1:5199',
    cookies = {};
  const call = async (path, actor = 'admin', method = 'GET', body, headers = {}) => {
    const response = await handleApi(
      new Request(origin + '/api' + path, {
        method,
        headers: {
          cookie: cookies[actor] || '',
          ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      db,
      { exitAccess: runtime },
    );
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  await call('/session');
  const now = new Date().toISOString();
  for (const [id, role] of [
    ['admin', 'admin'],
    ['director', 'director'],
    ['operations', 'operations'],
    ['other', 'operations'],
    ['gate', 'gate'],
    ['reader', 'reader'],
    ['finance', 'finance'],
  ]) {
    await owner.query(
      "INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',$5,$5)",
      [id, id + '@example.test', 'QA ' + id, role, now],
    );
    await owner.query(
      'INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES($1,$1,$2,$3,310000,$4,0)',
      [id, '0'.repeat(32), '0'.repeat(64), now],
    );
    const token = randomBytes(32).toString('hex');
    cookies[id] = 'porto_session=' + token;
    await owner.query(
      'INSERT INTO operational_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',
      [
        createHash('sha256').update(token).digest('hex'),
        id,
        now,
        new Date(Date.now() + 3600000).toISOString(),
      ],
    );
  }
  for (const [id, nativeId] of [
    ['employee-a', '101'],
    ['employee-b', '102'],
    ['employee-c', '103'],
  ])
    await owner.query(
      "INSERT INTO operational_records(collection,id,body) VALUES('people',$1,$2)",
      [
        id,
        JSON.stringify({
          id,
          name: 'Funcionário fictício ' + id,
          company: 'Empresa QA',
          active: true,
          category: 'employee',
          securityStatus: 'cleared',
          directory: {
            sourceId: gateway.sourceId,
            nativeId,
            inactive: false,
            blocked: false,
            missing: false,
          },
          createdAt: now,
          updatedAt: now,
        }),
      ],
    );
  const cmd = (type, payload, actor = 'admin', key = randomUUID(), headers) =>
    call('/exit-access/commands', actor, 'POST', { type, payload, idempotencyKey: key }, headers);
  const state = (actor = 'admin', query = '') => call('/exit-access/state' + query, actor);
  async function leaders(sectorId = 'sec_ti', leaderId = 'director', substituteId = 'operations') {
    const sector = (await state()).body.sectors.find((row) => row.id === sectorId);
    const result = await cmd('SET_LEADERS', {
      sectorId,
      leaderId,
      substituteId,
      version: sector.version,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result;
  }
  async function assign(personId = 'employee-a', sectorId = 'sec_ti') {
    const person = (await state()).body.people.find((row) => row.id === personId);
    const result = await cmd('ASSIGN_SECTOR', {
      personId,
      sectorId,
      version: person.member_version,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result;
  }
  async function prepare(personId = 'employee-a') {
    assert.equal(
      (await cmd('PREPARE_CONTROL', { personId, reason: 'Preparo isolado de QA' })).status,
      200,
    );
    await runtime.worker.tick();
    assert.equal(
      (await state()).body.people.find((row) => row.id === personId).provisioning_status,
      'prepared',
    );
  }
  async function confirm(personId = 'employee-a') {
    const result = await cmd('CONFIRM_CONTROL', {
      personId,
      reason: 'Testes físicos simulados em ambiente isolado',
      entryNormal: true,
      exitPending: true,
      offlineDenied: true,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  const grant = (personId = 'employee-a', actor = 'director', key = randomUUID()) =>
    cmd(
      'GRANT',
      { personId, sectorId: 'sec_ti', reason: 'Saída particular autorizada em QA' },
      actor,
      key,
    );
  return {
    db,
    owner,
    gateway,
    runtime,
    call,
    cmd,
    state,
    leaders,
    assign,
    prepare,
    confirm,
    grant,
    cookies,
  };
}
