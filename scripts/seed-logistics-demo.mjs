import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execute, validateState } from '../lib/domain.mjs';
import { readSnapshot } from '../lib/server.ts';
import { stateDelta } from '../lib/state-sync.ts';
import { PostgresDatabase } from '../lib/persistence/postgres.ts';
import { postgresConfig } from './postgres-config.mjs';

const marker = 'simulation:logistics:v1';
const hash = createHash('sha256').update(marker).digest('hex');
const actor = { id: 'demo-logistics-seed', name: 'Simulação · dados fictícios', role: 'admin' };
const collections = ['fleet', 'fleetTrips', 'materialExits'];
const plates = ['DMO1A01', 'DMO1A02', 'DMO1A03'];

export function buildLogisticsDemo(before, now = new Date()) {
  for (const plate of plates) {
    if (before.fleet.some((vehicle) => vehicle.plate === plate))
      throw Error('Uma placa reservada à simulação já existe. Nenhum dado foi alterado.');
  }
  let state = structuredClone(before);
  const at = (hours) => new Date(now.getTime() + hours * 3600000).toISOString();
  const run = (type, payload, hours) => {
    const outcome = execute(state, { type, payload, at: at(hours) }, actor);
    state = outcome.state;
    return outcome.result;
  };
  const note = 'SIMULAÇÃO: cadastro e movimentações fictícios para apresentação.';
  const vehicles = [
    ['Utilitário de apoio · SIMULAÇÃO', 12540],
    ['Caminhonete de manutenção · SIMULAÇÃO', 48100],
    ['Caminhão de entregas · SIMULAÇÃO', 87300],
  ].map(([name, initialOdometerKm], index) =>
    run(
      'FLEET_VEHICLE_SAVE',
      {
        plate: plates[index],
        name,
        initialOdometerKm,
        notes: note,
      },
      -50,
    ),
  );
  const trip = (vehicle, driver, destination, purpose, odometerOut, hour, returned) => {
    const departed = run(
      'FLEET_DEPART',
      {
        fleetId: vehicle.id,
        driver,
        destination,
        purpose: purpose + ' · SIMULAÇÃO',
        odometerOut,
        conditionOut: 'Exemplo fictício: carroceria e pneus conferidos; sem avarias visíveis.',
      },
      hour,
    );
    if (returned)
      run(
        'FLEET_RETURN',
        {
          id: departed.id,
          odometerIn: returned.km,
          conditionIn:
            returned.condition ?? 'Exemplo fictício: retornou nas mesmas condições da saída.',
        },
        returned.hour,
      );
    return departed.id;
  };
  const trips = [
    trip(
      vehicles[0],
      'Carlos Almeida · fictício',
      'Fornecedor Modelo · fictício',
      'Retirada de embalagens',
      12540,
      -48,
      { km: 12602, hour: -46 },
    ),
    trip(
      vehicles[0],
      'Carlos Almeida · fictício',
      'Cliente Exemplo · fictício',
      'Entrega de materiais',
      12602,
      -25,
      { km: 12636, hour: -23 },
    ),
    trip(
      vehicles[1],
      'Mariana Souza · fictícia',
      'Oficina Modelo · fictícia',
      'Manutenção preventiva',
      48100,
      -6,
      {
        km: 48142,
        hour: -5,
        condition:
          'Exemplo fictício: revisão concluída; pequeno risco preexistente no para-choque anotado.',
      },
    ),
    trip(
      vehicles[0],
      'Carlos Almeida · fictício',
      'Depósito Exemplo · fictício',
      'Coleta de caixas térmicas',
      12636,
      -2,
    ),
    trip(
      vehicles[2],
      'Roberto Lima · fictício',
      'Cliente Modelo · fictício',
      'Entrega programada',
      87300,
      -1.5,
    ),
  ];
  const materialData = [
    [
      'Caixas térmicas vazias · SIMULAÇÃO',
      '12 unidades',
      'Fornecedor Exemplo · fictício',
      'Carlos Almeida · fictício',
      'SIM-000101',
      plates[0],
    ],
    [
      'Peças de manutenção · SIMULAÇÃO',
      '2 volumes',
      'Oficina Modelo · fictícia',
      'Mariana Souza · fictícia',
      'SIM-000102',
      plates[1],
    ],
    [
      'Equipamento para reparo · SIMULAÇÃO',
      '1 unidade',
      'Assistência Modelo · fictícia',
      'Roberto Lima · fictício',
      'SIM-000103',
      plates[2],
    ],
    [
      'Embalagens para devolução · SIMULAÇÃO',
      '30 caixas',
      'Distribuidora Exemplo · fictícia',
      'Fernanda Costa · fictícia',
      'SIM-000104',
      plates[2],
    ],
    [
      'Paletes retornáveis · SIMULAÇÃO',
      '8 unidades',
      'Depósito Modelo · fictício',
      'Carlos Almeida · fictício',
      'SIM-000105',
      plates[0],
    ],
    [
      'Ferramentas para serviço externo · SIMULAÇÃO',
      '1 maleta',
      'Oficina Exemplo · fictícia',
      'Mariana Souza · fictícia',
      '',
      plates[1],
    ],
  ];
  const materials = materialData.map(
    ([description, quantity, destination, responsible, invoiceNumber, vehiclePlate], index) =>
      run(
        'MATERIAL_EXIT_CREATE',
        {
          description,
          quantity,
          destination,
          responsible,
          invoiceNumber,
          vehiclePlate,
          notes:
            note +
            (invoiceNumber
              ? ' Nota fiscal fictícia, sem validade fiscal.'
              : ' Exemplo sem nota fiscal informada.'),
        },
        -4.5 + index * 0.7,
      ).id,
  );
  validateState(state);
  return { state, result: { vehicles: vehicles.map((vehicle) => vehicle.id), trips, materials } };
}

export async function seedLogisticsDemo(db, { now = new Date() } = {}) {
  return db.transaction(async (client, scoped) => {
    await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
    const existing = (
      await client.query('SELECT hash,result,revision FROM operational_commands WHERE id=$1', [
        marker,
      ])
    ).rows[0];
    if (existing) {
      if (existing.hash !== hash)
        throw Error('Marcador de demonstração incompatível; dados preservados.');
      return { ...JSON.parse(existing.result), revision: existing.revision, replayed: true };
    }
    const before = await readSnapshot(scoped);
    const { state, result } = buildLogisticsDemo(before.state, now);
    for (const collection of collections) {
      const previousIds = new Set(before.state[collection].map((record) => record.id));
      for (const record of state[collection]) {
        if (previousIds.has(record.id)) continue;
        await client.query('INSERT INTO operational_records(collection,id,body) VALUES($1,$2,$3)', [
          collection,
          record.id,
          JSON.stringify(record),
        ]);
      }
    }
    const auditIds = new Set(before.state.audit.map((event) => event.id));
    for (const event of state.audit) {
      if (!auditIds.has(event.id))
        await client.query('INSERT INTO operational_audit(id,at,body) VALUES($1,$2,$3)', [
          event.id,
          event.at,
          JSON.stringify(event),
        ]);
    }
    const revision = before.revision + 1,
      createdAt = now.toISOString();
    await client.query(
      'INSERT INTO operational_changes(revision,created_at,body) VALUES($1,$2,$3)',
      [revision, createdAt, JSON.stringify(stateDelta(before.state, state, createdAt))],
    );
    await client.query('UPDATE operational_meta SET revision=$1 WHERE id=1', [revision]);
    await client.query(
      'INSERT INTO operational_commands(id,actor_id,hash,result,revision,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [marker, actor.id, hash, JSON.stringify(result), revision, createdAt],
    );
    return { ...result, revision, replayed: false };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') !== '--local')
    throw Error('Use --local para carregar somente a instalação local.');
  const config = postgresConfig();
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.database.host))
    throw Error('A carga de simulação exige PostgreSQL neste computador.');
  const db = new PostgresDatabase(config.database);
  try {
    const result = await seedLogisticsDemo(db);
    console.log(
      JSON.stringify(
        {
          vehicles: result.vehicles.length,
          trips: result.trips.length,
          materials: result.materials.length,
          revision: result.revision,
          replayed: result.replayed,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}
