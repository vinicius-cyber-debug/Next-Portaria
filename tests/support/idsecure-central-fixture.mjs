import { createServer } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';

export async function testCertificate(directory) {
  const cert = join(directory, 'cert.pem'),
    key = join(directory, 'key.pem');
  const generated = spawnSync(
    process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  if (generated.status !== 0) throw Error('Não foi possível criar certificado isolado de QA.');
  return { cert, key, ca: await readFile(cert), privateKey: await readFile(key) };
}
/** Strict fake vendor service. It never connects to a LAN host. */
export async function centralFixture(directory) {
  const tls = await testCertificate(directory),
    requests = [],
    rules = new Map(),
    events = [];
  const state = {
    loginStatus: 200,
    offline: false,
    ambiguous: false,
    confirm: true,
    configuration: { Mode: 2, ManualAuthorization: true, DefaultContingency: false },
    syncStatus: 0,
    serial: 'QA-ONLY-PORTARIA',
    nextRule: 20,
  };
  const target = {
    sourceId: 'qa-central',
    deviceId: '2',
    deviceName: 'CATRACA PORTARIA QA',
    model: 17,
    firmware: '6.26.0',
    serial: state.serial,
    entryReaderId: '3',
    exitReaderId: '4',
    entryAreaId: '1',
    exitAreaId: '4',
    exitAreaName: 'Saída QA',
    exitRotation: 'anticlockwise',
  };
  const people = new Map(
    ['101', '102', '103'].map((native, index) => [
      String(301 + index),
      {
        id: 301 + index,
        idDevice: Number(native),
        idType: 0,
        inativo: false,
        blackList: false,
        deleted: false,
        name: 'QA ' + native,
      },
    ]),
  );
  const device = {
    id: 2,
    name: target.deviceName,
    model: 17,
    versao: target.firmware,
    serial: target.serial,
    entranceSpinDirection: 'clockwise',
    readers: [
      { id: 3, idAreaFrom: 4, idAreaTo: 1 },
      { id: 4, idAreaFrom: 1, idAreaTo: 4 },
    ],
  };
  function detail(rule) {
    return {
      ...rule,
      usersList: rule.users.map((id) => ({ id })),
      devicesList: rule.devices.map((id) => ({ id })),
      areasList: rule.areas.map((id) => ({ id })),
      schedulesList: rule.schedules.map((id) => ({ id })),
      groupsList: rule.groups,
      typesList: rule.types,
      visitorsList: rule.visitors,
    };
  }
  const server = createServer({ cert: tls.ca, key: tls.privateKey }, async (req, res) => {
    try {
      const url = new URL(req.url, 'https://127.0.0.1'),
        path = url.pathname;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8'),
        body = text ? JSON.parse(text) : undefined;
      function reply(value, status = 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      }
      if (path === '/api/login/') {
        if (state.loginStatus !== 200) {
          reply({ message: 'QA login recusado' }, state.loginStatus);
          return;
        }
        reply({ accessToken: 'qa-ephemeral-token' });
        return;
      }
      requests.push({ method: req.method, path, query: url.search, body });
      if (state.offline) {
        reply({ error: 'offline' }, 503);
        return;
      }
      if (req.headers.authorization !== 'Bearer qa-ephemeral-token') {
        reply({}, 401);
        return;
      }
      if (path === '/api/util/configUI') {
        reply(state.configuration);
        return;
      }
      if (path === '/api/device/2') {
        reply({ ...device, serial: state.serial });
        return;
      }
      if (path === '/api/util/DevicesSyncStatus') {
        reply([{ id: 2, syncStatus: state.syncStatus }]);
        return;
      }
      if (path === '/api/area/') {
        reply([
          { id: 1, name: 'Entrada QA' },
          { id: 4, name: target.exitAreaName },
        ]);
        return;
      }
      if (path === '/api/util/connect' && req.method === 'POST') {
        reply({ success: true, serial: state.serial, version: target.firmware });
        return;
      }
      if (path === '/api/user/list' && req.method === 'POST') {
        const rows = [...people.values()];
        reply({
          data: rows.slice(
            Number(url.searchParams.get('start')),
            Number(url.searchParams.get('start')) + 100,
          ),
          recordsFiltered: rows.length,
        });
        return;
      }
      if (/^\/api\/user\/\d+$/.test(path) && req.method === 'GET') {
        const person = people.get(path.split('/').at(-1));
        reply(person || {}, person ? 200 : 404);
        return;
      }
      if (path === '/api/rule/' && req.method === 'GET') {
        reply([...rules.values()].map((rule) => ({ id: rule.id, name: rule.name })));
        return;
      }
      if (path === '/api/rule/' && req.method === 'POST') {
        const rule = { ...body, id: String(state.nextRule++) };
        rules.set(rule.id, rule);
        reply({ success: true, id: rule.id });
        return;
      }
      if (/^\/api\/rule\/\d+$/.test(path)) {
        const id = path.split('/').at(-1),
          rule = rules.get(id);
        if (req.method === 'DELETE') {
          rules.delete(id);
          res.writeHead(204);
          res.end();
          return;
        }
        reply(rule ? detail(rule) : {}, rule ? 200 : 404);
        return;
      }
      if (path === '/api/access/monitor') {
        reply({ data: events });
        return;
      }
      const action = path.match(
        /^\/api\/util\/action\/2\/catra\/allow=anticlockwise,reason=3\/([1-9]\d*)$/,
      );
      if (action && req.method === 'GET') {
        const event = events.find(
          (row) =>
            String(row.idLog) === action[1] &&
            row.eventCode === 8 &&
            row.functionDetail === 1 &&
            row.idDevice === 2 &&
            row.idArea === 4,
        );
        if (!event) {
          reply({ success: false }, 400);
          return;
        }
        if (state.ambiguous) {
          req.socket.destroy();
          return;
        }
        if (state.confirm) event.eventCode = 7;
        reply({ success: true });
        return;
      }
      reply({ error: 'unsupported test route' }, 404);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const credentialFile = join(directory, 'idsecure.json'),
    configFile = join(directory, 'exit-access.json');
  const credentials = {
    origin: 'https://127.0.0.1:' + server.address().port,
    username: 'qa',
    password: randomBytes(16).toString('hex'),
    mode: 'read_only',
    sourceId: target.sourceId,
    certificatePath: tls.cert,
    fingerprint256: new X509Certificate(tls.ca).fingerprint256,
  };
  const config = { version: 1, enabled: true, credentialFile, target };
  await writeFile(credentialFile, JSON.stringify(credentials));
  await writeFile(configFile, JSON.stringify(config));
  function pending(native = '101', extra = {}) {
    const person = [...people.values()].find((row) => String(row.idDevice) === native),
      event = {
        idLog: 1001 + events.length,
        idUser: person?.id ?? 0,
        idDevice: 2,
        idArea: 4,
        idReader: 4,
        area: target.exitAreaName,
        eventCode: 8,
        functionDetail: 1,
        time: new Date().toISOString(),
        ...extra,
      };
    events.push(event);
    return event;
  }
  return {
    server,
    state,
    target,
    config,
    configFile,
    credentials,
    tls,
    requests,
    rules,
    events,
    people,
    pending,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
