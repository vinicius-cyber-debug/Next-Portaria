/** Company fleet and material exits use the same transactional record journal as the gate. */
export const LOGISTICS_COLLECTIONS = ['fleetTrips', 'materialExits'];
export const LOGISTICS_COMMANDS = [
  'FLEET_VEHICLE_SAVE',
  'FLEET_DEPART',
  'FLEET_RETURN',
  'MATERIAL_EXIT_CREATE',
];
const fail = (message, code = 'VALIDATION') => {
  throw Object.assign(new Error(message), { code });
};
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    fail(`${label} é obrigatório e deve ter até ${max} caracteres.`);
  return value.trim();
};
const optional = (value, label, max = 200) =>
  value == null || value === '' ? '' : text(value, label, max);
const km = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000)
    fail('A quilometragem deve ser um número inteiro entre 0 e 100.000.000.');
  return value;
};
const plate = (value) => {
  const normalized = text(value, 'Placa', 15).replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{5,10}$/.test(normalized)) fail('Placa inválida.');
  return normalized;
};
const timestamp = (value, label) => {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(`${label} inválido.`, 'INVALID_BACKUP');
  return Date.parse(value);
};
const vehicleById = (state, id) => {
  const vehicle = state.fleet.find((item) => item.id === text(id, 'Veículo', 150));
  if (!vehicle || vehicle.ownership !== 'company')
    fail('Selecione um veículo cadastrado na frota própria.', 'NOT_FOUND');
  return vehicle;
};
const lastReading = (state, vehicle) =>
  Math.max(
    vehicle.initialOdometerKm,
    vehicle.currentOdometerKm,
    ...state.fleetTrips
      .filter((trip) => trip.fleetId === vehicle.id)
      .map((trip) => trip.odometerIn ?? trip.odometerOut),
  );

export function executeLogistics(state, type, payload, at, actor) {
  const metadata = { createdAt: at, createdBy: actor.name, updatedAt: at, updatedBy: actor.name };
  if (type === 'FLEET_VEHICLE_SAVE') {
    const old = payload.id ? vehicleById(state, payload.id) : null;
    const normalizedPlate = plate(payload.plate ?? old?.plate);
    if (state.fleet.some((item) => item.id !== old?.id && item.plate === normalizedPlate))
      fail(
        'Já existe um veículo com esta placa no cadastro. Nenhum veículo foi reclassificado.',
        'DUPLICATE',
      );
    if (old && state.fleetTrips.some((trip) => trip.fleetId === old.id && trip.status === 'out'))
      fail('O cadastro só pode ser alterado após o retorno do veículo.', 'INVALID_TRANSITION');
    const initial = km(payload.initialOdometerKm ?? old?.initialOdometerKm);
    if (old && initial !== old.initialOdometerKm)
      fail('A quilometragem inicial já registrada não pode ser alterada.');
    const record = {
      ...metadata,
      ...old,
      id: old?.id ?? 'fleet_' + crypto.randomUUID(),
      ownership: 'company',
      plate: normalizedPlate,
      name: text(payload.name ?? old?.name, 'Descrição do veículo', 150),
      initialOdometerKm: initial,
      currentOdometerKm: old?.currentOdometerKm ?? initial,
      notes: optional(payload.notes ?? old?.notes, 'Observações', 2000),
      active: old?.active ?? true,
      updatedAt: at,
      updatedBy: actor.name,
    };
    if (old) Object.assign(old, record);
    else state.fleet.unshift(record);
    return old ?? record;
  }
  if (type === 'FLEET_DEPART') {
    const vehicle = vehicleById(state, payload.fleetId);
    if (!vehicle.active) fail('O veículo está inativo.', 'INACTIVE_MASTER');
    if (state.fleetTrips.some((trip) => trip.fleetId === vehicle.id && trip.status === 'out'))
      fail('Este veículo já possui uma saída sem retorno.', 'DUPLICATE');
    const reading = km(payload.odometerOut);
    if (reading < lastReading(state, vehicle))
      fail('A quilometragem de saída não pode ser menor que a última leitura registrada.');
    const trip = {
      ...metadata,
      id: 'fleet_trip_' + crypto.randomUUID(),
      fleetId: vehicle.id,
      plate: vehicle.plate,
      vehicleName: vehicle.name,
      driver: text(payload.driver, 'Motorista', 150),
      destination: text(payload.destination, 'Destino', 200),
      purpose: text(payload.purpose, 'Motivo', 500),
      odometerOut: reading,
      odometerIn: null,
      distanceKm: null,
      conditionOut: optional(payload.conditionOut, 'Condições na saída', 2000),
      conditionIn: '',
      departedAt: at,
      returnedAt: null,
      status: 'out',
    };
    state.fleetTrips.unshift(trip);
    Object.assign(vehicle, { currentOdometerKm: reading, updatedAt: at, updatedBy: actor.name });
    return trip;
  }
  if (type === 'FLEET_RETURN') {
    const trip = state.fleetTrips.find((item) => item.id === text(payload.id, 'Saída', 150));
    if (!trip) fail('Saída da frota não encontrada.', 'NOT_FOUND');
    if (trip.status !== 'out')
      fail('O retorno deste veículo já foi registrado.', 'INVALID_TRANSITION');
    const vehicle = vehicleById(state, trip.fleetId),
      reading = km(payload.odometerIn);
    if (reading < trip.odometerOut || reading < lastReading(state, vehicle))
      fail('A quilometragem de retorno não pode ser menor que a quilometragem de saída.');
    if (Date.parse(at) < Date.parse(trip.departedAt))
      fail('O retorno não pode ser anterior à saída.');
    Object.assign(trip, {
      odometerIn: reading,
      distanceKm: reading - trip.odometerOut,
      conditionIn: optional(payload.conditionIn, 'Condições no retorno', 2000),
      status: 'returned',
      returnedAt: at,
      updatedAt: at,
      updatedBy: actor.name,
    });
    Object.assign(vehicle, { currentOdometerKm: reading, updatedAt: at, updatedBy: actor.name });
    return trip;
  }
  if (type === 'MATERIAL_EXIT_CREATE') {
    const record = {
      ...metadata,
      id: 'material_exit_' + crypto.randomUUID(),
      description: text(payload.description, 'Material', 2000),
      quantity: text(payload.quantity, 'Quantidade e unidade', 100),
      destination: text(payload.destination, 'Destino', 200),
      responsible: text(payload.responsible, 'Responsável', 150),
      invoiceNumber: optional(payload.invoiceNumber, 'Número da nota fiscal', 80),
      vehiclePlate: payload.vehiclePlate ? plate(payload.vehiclePlate) : '',
      notes: optional(payload.notes, 'Observações', 2000),
      status: 'registered',
    };
    state.materialExits.unshift(record);
    return record;
  }
  fail('Operação de logística não reconhecida.', 'UNKNOWN_COMMAND');
}

export function validateLogistics(state) {
  const own = state.fleet.filter((vehicle) => vehicle.ownership === 'company');
  for (const vehicle of own) {
    text(vehicle.name, 'Descrição do veículo', 150);
    km(vehicle.initialOdometerKm);
    km(vehicle.currentOdometerKm);
    if (vehicle.currentOdometerKm < vehicle.initialOdometerKm)
      fail('Quilometragem da frota inconsistente.', 'INVALID_BACKUP');
  }
  const open = new Set();
  for (const trip of state.fleetTrips) {
    const vehicle = vehicleById(state, trip.fleetId);
    plate(trip.plate);
    text(trip.vehicleName, 'Veículo', 150);
    text(trip.driver, 'Motorista', 150);
    text(trip.destination, 'Destino', 200);
    text(trip.purpose, 'Motivo', 500);
    km(trip.odometerOut);
    optional(trip.conditionOut, 'Condições na saída', 2000);
    optional(trip.conditionIn, 'Condições no retorno', 2000);
    const left = timestamp(trip.departedAt, 'Saída'),
      created = timestamp(trip.createdAt, 'Criação');
    const updated = timestamp(trip.updatedAt, 'Atualização');
    text(trip.createdBy, 'Operador de saída', 150);
    text(trip.updatedBy, 'Operador', 150);
    if (created !== left || updated < created || trip.odometerOut < vehicle.initialOdometerKm)
      fail('Saída da frota inconsistente.', 'INVALID_BACKUP');
    if (trip.status === 'out') {
      if (
        open.has(trip.fleetId) ||
        trip.odometerIn !== null ||
        trip.returnedAt !== null ||
        trip.distanceKm !== null
      )
        fail('Saída da frota duplicada ou inconsistente.', 'INVALID_BACKUP');
      open.add(trip.fleetId);
    } else if (trip.status === 'returned') {
      km(trip.odometerIn);
      if (
        trip.odometerIn < trip.odometerOut ||
        trip.distanceKm !== trip.odometerIn - trip.odometerOut ||
        timestamp(trip.returnedAt, 'Retorno') < left
      )
        fail('Retorno da frota inconsistente.', 'INVALID_BACKUP');
    } else fail('Situação da frota inválida.', 'INVALID_BACKUP');
    if (vehicle.currentOdometerKm < (trip.odometerIn ?? trip.odometerOut))
      fail('Última quilometragem da frota inconsistente.', 'INVALID_BACKUP');
  }
  for (const vehicle of own) {
    const trips = state.fleetTrips
      .filter((trip) => trip.fleetId === vehicle.id)
      .sort((left, right) => Date.parse(left.departedAt) - Date.parse(right.departedAt));
    let reading = vehicle.initialOdometerKm,
      availableAt = 0;
    for (const trip of trips) {
      if (trip.odometerOut < reading || Date.parse(trip.departedAt) < availableAt)
        fail('Histórico de quilometragem ou permanência da frota inconsistente.', 'INVALID_BACKUP');
      reading = trip.odometerIn ?? trip.odometerOut;
      availableAt = trip.returnedAt ? Date.parse(trip.returnedAt) : Infinity;
    }
  }
  for (const record of state.materialExits) {
    text(record.description, 'Material', 2000);
    text(record.quantity, 'Quantidade e unidade', 100);
    text(record.destination, 'Destino', 200);
    text(record.responsible, 'Responsável', 150);
    optional(record.invoiceNumber, 'Número da nota fiscal', 80);
    if (record.vehiclePlate) plate(record.vehiclePlate);
    if (record.status !== 'registered')
      fail('Situação da saída de material inválida.', 'INVALID_BACKUP');
    const created = timestamp(record.createdAt, 'Saída de material');
    if (timestamp(record.updatedAt, 'Atualização') < created)
      fail('Data da saída de material inconsistente.', 'INVALID_BACKUP');
    text(record.createdBy, 'Operador', 150);
    text(record.updatedBy, 'Operador', 150);
  }
}
