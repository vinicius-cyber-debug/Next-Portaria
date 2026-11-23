import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../lib/server.ts';
import { exportReportCsv, pagedRecords } from '../lib/state-sync.ts';
import { testSession } from './fixture-auth.mjs';
import { hasPostgres, withPostgresFixture } from './support/postgres-fixture.mjs';
import { SqliteTestDatabase } from './support/sqlite-fixture.mjs';

async function withReports(testReport) {
  const db = new SqliteTestDatabase();
  const origin = 'https://reports.example.test';
  try {
    await handleApi(new Request(origin + '/api/session'), db);
    const cookies = Object.fromEntries(
      ['admin', 'reader'].map((role) => {
        const cookie = testSession(db, { id: role, name: role, email: role + '@example.test' });
        db.sqlite
          .prepare("UPDATE operational_users SET role=?,status='active' WHERE id=?")
          .run(role, role);
        return [role, cookie];
      }),
    );
    const get = (path, role = 'admin') =>
      handleApi(new Request(origin + '/api' + path, { headers: { cookie: cookies[role] } }), db);
    const insert = db.sqlite.prepare(
      'INSERT INTO operational_records(collection,id,body) VALUES (?,?,?)',
    );
    const add = (collection, record) => insert.run(collection, record.id, JSON.stringify(record));
    await testReport({ db, get, add });
  } finally {
    db.sqlite.close();
  }
}

test('relatórios reutilizam filtros e datas locais no CSV e na consulta paginada', async () => {
  await withReports(async ({ get, add }) => {
    const records = [
      {
        id: 'old',
        title: 'Portaria antiga',
        severity: 'high',
        createdAt: '2026-10-05T03:59:59.000Z',
      },
      {
        id: 'in',
        title: 'Portaria no período',
        severity: 'high',
        createdAt: '2026-10-05T04:00:00.000Z',
      },
      {
        id: 'low',
        title: 'Portaria menor',
        severity: 'low',
        createdAt: '2026-10-06T03:59:59.000Z',
      },
      {
        id: 'next',
        title: 'Portaria dia seguinte',
        severity: 'high',
        createdAt: '2026-10-06T04:00:00.000Z',
      },
    ];
    for (const record of records)
      add('incidents', {
        ...record,
        status: 'open',
        updatedAt: '2026-10-20T10:00:00.000Z',
        description: 'Descrição não selecionada',
        attachmentIds: ['attachment_private'],
      });
    const filters = 'from=2026-10-05&to=2026-10-05&severity=high&status=open&q=Portaria';
    const page = await get('/records?collection=incidents&report=true&' + filters);
    assert.equal(page.status, 200);
    const { total, rows } = await page.json();
    assert.equal(total, 1);
    assert.equal(rows[0].title, 'Portaria no período');
    assert.equal(rows[0].description, undefined);
    assert.equal(rows[0].attachmentIds, undefined);
    const csv = await get('/exports?kind=incidents&' + filters);
    assert.equal(csv.status, 200);
    const contents = await csv.text();
    assert.equal(contents.split('\r\n').length, 2);
    assert.match(contents, /Portaria no período/);
    assert.doesNotMatch(
      contents,
      /Portaria antiga|Portaria menor|Portaria dia seguinte|attachment_private/,
    );
    const invalid = await get('/exports?kind=incidents&from=2026-10-06&to=2026-10-05');
    assert.equal((await invalid.json()).error.code, 'VALIDATION');
  });
});

test('relatórios protegem detalhes fiscais e pessoas da conferência de emergência', async () => {
  await withReports(async ({ db, get, add }) => {
    add('materialExits', {
      id: 'material-qa',
      description: 'Material fictício',
      invoiceNumber: 'NF-RESERVADA-015',
    });
    add('emergencyRollCalls', {
      id: 'emergency-qa',
      title: 'Exercício fictício',
      people: [
        { name: 'Pessoa reservada 1', confirmedAt: '2026-10-05T04:00:00.000Z' },
        { name: 'Pessoa reservada 2', confirmedAt: null },
      ],
    });
    const materials = '/records?collection=materialExits&report=true';
    const exportMaterials = '/exports?kind=materialExits';
    const restrictedRows = await (await get(materials, 'reader')).json();
    assert.equal(restrictedRows.rows[0].invoiceNumber, undefined);
    const search = await (await get(materials + '&q=NF-RESERVADA-015', 'reader')).json();
    assert.equal(search.total, 0);
    assert.equal((await get(exportMaterials, 'reader')).status, 403);
    db.sqlite
      .prepare('INSERT INTO operational_access(user_id,body) VALUES(?,?)')
      .run('reader', JSON.stringify({ dataExport: true }));
    const restrictedCsv = await get(exportMaterials, 'reader');
    assert.equal(restrictedCsv.status, 200);
    assert.doesNotMatch(await restrictedCsv.text(), /Nota fiscal|NF-RESERVADA-015/);
    assert.match(await (await get(exportMaterials)).text(), /NF-RESERVADA-015/);
    const emergency = await (
      await get('/records?collection=emergencyRollCalls&report=true')
    ).json();
    assert.equal(emergency.rows[0].peopleCount, 2);
    assert.equal(emergency.rows[0].confirmedCount, 1);
    assert.equal(emergency.rows[0].unresolvedCount, 1);
    assert.equal(emergency.rows[0].people, undefined);
    assert.doesNotMatch(
      await (await get('/exports?kind=emergencyRollCalls')).text(),
      /Pessoa reservada/,
    );
    assert.equal((await get('/records?collection=audit&report=true')).status, 400);
  });
});

test(
  'consulta e exportação de frota respeitam o recorte em PostgreSQL',
  { skip: !hasPostgres },
  async () => {
    await withPostgresFixture(async ({ db, owner }) => {
      const row = {
        id: 'trip-qa',
        fleetId: 'fleet-qa',
        plate: 'QAT1A23',
        departedAt: '2026-10-05T04:00:00.000Z',
        status: 'returned',
        distanceKm: 8,
        conditionIn: 'Vistoria reservada',
      };
      await owner.query(
        "INSERT INTO operational_records(collection,id,body) VALUES ('fleetTrips',$1,$2)",
        [row.id, JSON.stringify(row)],
      );
      const user = { capabilities: { dataExport: true, documentView: true } };
      const query = 'fleetId=fleet-qa&status=returned&from=2026-10-05&to=2026-10-05';
      const result = await pagedRecords(
        db,
        user,
        new URLSearchParams('collection=fleetTrips&report=true&' + query),
      );
      assert.equal(result.total, 1);
      assert.equal(result.rows[0].distanceKm, 8);
      assert.equal(result.rows[0].conditionIn, undefined);
      const csv = await exportReportCsv(db, user, new URLSearchParams('kind=fleetTrips&' + query));
      assert.match(csv, /QAT1A23/);
      assert.doesNotMatch(csv, /Vistoria reservada/);
    });
  },
);
