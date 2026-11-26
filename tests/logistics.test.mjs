import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, execute, validateState } from '../lib/domain.mjs';
import { canWithCapabilities, defaultCapabilities, redactValue } from '../lib/access.mjs';
const at = '2026-11-19T12:00:00.000Z',
  later = '2026-11-19T13:00:00.000Z';
const actor = { id: 'qa-admin', role: 'admin', name: 'Operador fictício' };
function fixture() {
  let state = createInitialState();
  const apply = (type, payload, by = actor, when = at) => {
    const result = execute(state, { type, payload, at: when }, by);
    validateState(result.state);
    state = result.state;
    return result.result;
  };
  const vehicle = apply('FLEET_VEHICLE_SAVE', {
    plate: 'QAT1A23',
    name: 'Utilitário fictício',
    initialOdometerKm: 42000,
  });
  const depart = (extra = {}, when = at) =>
    apply(
      'FLEET_DEPART',
      {
        fleetId: vehicle.id,
        driver: 'Motorista QA',
        destination: 'Fornecedor fictício',
        purpose: 'Coleta de material',
        odometerOut: 42000,
        conditionOut: 'Sem danos aparentes',
        ...extra,
      },
      actor,
      when,
    );
  return {
    apply,
    vehicle,
    depart,
    get state() {
      return state;
    },
  };
}
test('frota registra saída/retorno e quilômetros; auditoria mantém operador e snapshot de placa', () => {
  const f = fixture(),
    before = structuredClone(f.state),
    trip = f.depart();
  assert.equal(trip.status, 'out');
  assert.equal(trip.createdBy, actor.name);
  assert.equal(before.fleetTrips.length, 0);
  const returned = f.apply(
    'FLEET_RETURN',
    { id: trip.id, odometerIn: 42038, conditionIn: 'Retornou sem avarias' },
    actor,
    later,
  );
  assert.equal(returned.distanceKm, 38);
  assert.equal(returned.status, 'returned');
  assert.equal(returned.returnedAt, later);
  assert.equal(f.state.fleet[0].currentOdometerKm, 42038);
  f.apply(
    'FLEET_VEHICLE_SAVE',
    { id: f.vehicle.id, plate: 'QAT1A24', name: 'Utilitário renomeado', initialOdometerKm: 42000 },
    actor,
    later,
  );
  assert.equal(f.state.fleetTrips[0].plate, 'QAT1A23');
  assert.equal(f.state.audit[1].actorId, actor.id);
  assert.equal(f.state.audit[1].action, 'FLEET_RETURN');
});
test('frota recusa dupla saída, km regressivo, leitura fracionária e retorno repetido', () => {
  const f = fixture();
  for (const odometerOut of [41999, -1, 1.5, '42000'])
    assert.throws(() => f.depart({ odometerOut }), { code: 'VALIDATION' });
  const trip = f.depart();
  assert.throws(() => f.depart(), { code: 'DUPLICATE' });
  assert.throws(() => f.apply('FLEET_RETURN', { id: trip.id, odometerIn: 41999 }), {
    code: 'VALIDATION',
  });
  f.apply('FLEET_RETURN', { id: trip.id, odometerIn: 42010 }, actor, later);
  assert.throws(() => f.apply('FLEET_RETURN', { id: trip.id, odometerIn: 42011 }, actor, later), {
    code: 'INVALID_TRANSITION',
  });
  assert.throws(() => f.depart({ odometerOut: 42000 }, later), { code: 'VALIDATION' });
  assert.equal(f.depart({ odometerOut: 42010 }, later).odometerOut, 42010);
});
test('veículo de terceiro não é reclassificado e placa duplicada/inativa é recusada', () => {
  const f = fixture(),
    third = f.apply('MASTER_SAVE', {
      kind: 'fleet',
      record: { plate: 'QAT1B23', name: 'Terceiro fictício' },
    });
  assert.throws(
    () =>
      f.apply('FLEET_VEHICLE_SAVE', {
        id: third.id,
        plate: third.plate,
        name: 'Tentativa',
        initialOdometerKm: 1,
      }),
    { code: 'NOT_FOUND' },
  );
  assert.throws(
    () =>
      f.apply('FLEET_VEHICLE_SAVE', {
        plate: third.plate,
        name: 'Tentativa',
        initialOdometerKm: 1,
      }),
    { code: 'DUPLICATE' },
  );
  assert.throws(() => f.depart({ fleetId: third.id }), { code: 'NOT_FOUND' });
  f.state.fleet.find((vehicle) => vehicle.id === f.vehicle.id).active = false;
  validateState(f.state);
  assert.throws(() => f.depart(), { code: 'INACTIVE_MASTER' });
});
test('cadastro genérico não altera frota própria nem contorna viagem aberta', () => {
  const f = fixture();
  for (const record of [
    { id: f.vehicle.id, name: '' },
    { id: f.vehicle.id, plate: 'QAT9Z99' },
    { id: f.vehicle.id, active: false },
  ]) {
    const before = structuredClone(f.state);
    assert.throws(() => f.apply('MASTER_SAVE', { kind: 'fleet', record }), {
      code: 'INVALID_TRANSITION',
    });
    assert.deepEqual(f.state, before);
    validateState(f.state);
  }
  f.depart();
  const beforeTrip = structuredClone(f.state);
  assert.throws(
    () =>
      f.apply('MASTER_SAVE', { kind: 'fleet', record: { id: f.vehicle.id, name: 'Outro nome' } }),
    { code: 'INVALID_TRANSITION' },
  );
  assert.deepEqual(f.state, beforeTrip);
  assert.throws(() => f.apply('FLEET_VEHICLE_SAVE', { id: f.vehicle.id, name: 'Outro nome' }), {
    code: 'INVALID_TRANSITION',
  });
  const third = f.apply('MASTER_SAVE', {
    kind: 'fleet',
    record: { plate: 'QAT2C23', name: 'Terceiro QA' },
  });
  assert.equal(
    f.apply('MASTER_SAVE', { kind: 'fleet', record: { id: third.id, name: 'Terceiro atualizado' } })
      .name,
    'Terceiro atualizado',
  );
});
test('materiais guardam nota fiscal opcional, quantidade e operador sem aceitar metadados forjados', () => {
  const f = fixture(),
    payload = {
      description: 'Caixas térmicas fictícias',
      quantity: '3 unidades',
      destination: 'Empresa QA',
      responsible: 'Responsável QA',
      invoiceNumber: ' NF-2026/001 ',
      vehiclePlate: 'qat-1a23',
      createdBy: 'Forjado',
      createdAt: later,
    };
  const record = f.apply('MATERIAL_EXIT_CREATE', payload);
  assert.equal(record.invoiceNumber, 'NF-2026/001');
  assert.equal(record.vehiclePlate, 'QAT1A23');
  assert.equal(record.createdBy, actor.name);
  assert.equal(record.createdAt, at);
  assert.equal(
    f.apply('MATERIAL_EXIT_CREATE', { ...payload, invoiceNumber: '' }).invoiceNumber,
    '',
  );
  assert.throws(() => f.apply('MATERIAL_EXIT_CREATE', { ...payload, description: '' }), {
    code: 'VALIDATION',
  });
  assert.throws(
    () => f.apply('MATERIAL_EXIT_CREATE', { ...payload, invoiceNumber: '1'.repeat(81) }),
    { code: 'VALIDATION' },
  );
  assert.equal(redactValue(record, { documentView: false }).invoiceNumber, undefined);
});
test('perfis de operação são permitidos; leitor/financeiro e capability removida são recusados', () => {
  const f = fixture();
  for (const role of ['admin', 'gate', 'operations', 'director']) {
    const user = { ...actor, role, status: 'active', capabilities: defaultCapabilities(role) };
    assert.equal(canWithCapabilities(user, 'FLEET_DEPART'), true);
    if (role !== 'admin')
      assert.equal(
        canWithCapabilities(
          { ...user, capabilities: { ...user.capabilities, incidentManage: false } },
          'FLEET_DEPART',
        ),
        false,
      );
  }
  for (const role of ['reader', 'finance'])
    assert.throws(() => f.apply('FLEET_DEPART', {}, { ...actor, role }), { code: 'FORBIDDEN' });
});
test('backups anteriores ganham coleções vazias; backups novos recusam km, vínculos e cronologia corrompidos', () => {
  const old = createInitialState();
  delete old.fleetTrips;
  delete old.materialExits;
  assert.deepEqual(validateState(old).fleetTrips, []);
  const f = fixture(),
    trip = f.depart();
  f.apply('FLEET_RETURN', { id: trip.id, odometerIn: 42020 }, actor, later);
  for (const alter of [
    (state) => {
      state.fleetTrips[0].distanceKm = 999;
    },
    (state) => {
      state.fleetTrips[0].fleetId = 'missing';
    },
    (state) => {
      state.fleet[0].currentOdometerKm = 1;
    },
    (state) => {
      state.fleetTrips[0].returnedAt = '2026-11-19T11:00:00.000Z';
    },
    (state) => {
      state.fleetTrips.push({
        ...state.fleetTrips[0],
        id: 'trip_other',
        departedAt: '2026-11-19T12:30:00.000Z',
        createdAt: '2026-11-19T12:30:00.000Z',
      });
    },
  ]) {
    const invalid = structuredClone(f.state);
    alter(invalid);
    assert.throws(() => validateState(invalid));
  }
  assert.equal(validateState(f.state).fleetTrips[0].distanceKm, 20);
});
