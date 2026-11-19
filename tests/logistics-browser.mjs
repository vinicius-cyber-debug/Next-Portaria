import { chromium, expect as baseExpect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { withPostgresFixture } from './support/postgres-fixture.mjs';
import { hashPassword } from '../lib/local-auth.ts';
import { handleApi, readSnapshot } from '../lib/server.ts';
import { validateState } from '../lib/domain.mjs';

const expect = baseExpect.configure({ timeout: 30000 });
const output = resolve('.porto-tooling/logistics-browser');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'portaria-logistics-qa-'));
const screenshots = [], errors = [];
let child, browser, logs = '';

async function waitFor(predicate, message, timeout = 60000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw Error(message);
    await new Promise((done) => setTimeout(done, 250));
  }
}
async function unusedPort() {
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const value = socket.address().port;
  await new Promise((done) => socket.close(done));
  return value;
}
async function stopFixture() {
  if (browser) { await browser.close(); browser = null; }
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    await ended;
  }
}

try {
  if (process.env.PORTO_LOGISTICS_WAIT_BUILD_LOG === 'true') {
    await waitFor(async () => {
      const log = await readFile('.porto-tooling/logistics-build.log', 'utf8').catch(() => '');
      return log.includes('Build complete.');
    }, 'A compilação nativa ainda não confirmou Build complete.', 240000);
  }
  await withPostgresFixture(async ({ owner, db, database, role, password: appPassword, adminConfig }) => {
    try {
      await handleApi(new Request('http://127.0.0.1/api/session'), db);
      const password = randomBytes(24).toString('hex'), credential = await hashPassword(password), now = new Date().toISOString();
      await owner.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES('logistics-admin','logistics@example.test','Admin Logística QA','admin','active',$1,$1)", [now]);
      await owner.query("INSERT INTO operational_credentials(user_id,username,password_hash,password_salt,password_iterations,password_changed_at,must_change_password) VALUES('logistics-admin','logistics.qa',$1,$2,$3,$4,0)", [credential.hash, credential.salt, credential.iterations, now]);
      const media = join(temporary, 'media'); await mkdir(media);
      const uiPort = await unusedPort(), origin = 'http://127.0.0.1:' + uiPort;
      child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/run-framework.mjs', 'start', '--hostname', '127.0.0.1', '--port', String(uiPort)], {
        windowsHide: true,
        env: { ...process.env, PORTO_DB_PROVIDER: 'postgres', PORTO_PG_CONFIG: JSON.stringify({ ...adminConfig, database, user: role, password: appPassword }), PORTO_MEDIA_ROOT: media, PORTO_IDSECURE_CONFIG: join(temporary, 'no-central.json'), PORTO_EXIT_CONFIG: join(temporary, 'no-physical-access.json'), PORTO_NATIVE_PROCESS_FILE: join(temporary, 'process.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (value) => { logs = (logs + value).slice(-10000); });
      await waitFor(() => fetch(origin).then((r) => r.ok).catch(() => false), 'Servidor QA não iniciou.');
      browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const login = await context.request.post(origin + '/api/auth/login', { headers: { origin }, data: { username: 'logistics.qa', password } });
      expect(login.status()).toBe(200);
      const page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      const navigate = async (title) => {
        await expect(page.locator('main h1')).toBeVisible();
        const navigation = page.getByRole('navigation', { name: 'Navegação principal' });
        if (page.viewportSize().width <= 1024) await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
        await expect(navigation).toBeVisible();
        await navigation.getByRole('button', { name: title, exact: true }).click();
        await expect(page.locator('main h1')).toContainText(title);
      };
      async function capture(label) {
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: join(output, label + '.png'), fullPage: true, animations: 'disabled' }); screenshots.push(label);
      }
      await navigate('Frota própria');
      console.log('QA frota: cadastro e saída');
      await page.getByRole('button', { name: 'Cadastrar veículo', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Placa', exact: true }).fill('QAT1A23');
      await dialog.getByRole('textbox', { name: 'Descrição do veículo', exact: true }).fill('Utilitário fictício de demonstração');
      await dialog.getByRole('spinbutton', { name: 'Quilometragem atual (km)', exact: true }).fill('1200');
      await dialog.getByRole('button', { name: 'Salvar registro', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.logistics-vehicle')).toContainText('QAT1A23');
      await page.locator('.logistics-vehicle').getByRole('button', { name: 'Registrar saída', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Motorista', exact: true }).fill('Motorista fictício QA');
      await dialog.getByRole('textbox', { name: 'Destino', exact: true }).fill('Cliente fictício QA');
      await expect(dialog.getByRole('spinbutton', { name: 'Quilometragem na saída (km)', exact: true })).toHaveValue('1200');
      await dialog.getByRole('textbox', { name: 'Motivo do deslocamento', exact: true }).fill('Entrega de demonstração');
      await dialog.getByRole('textbox', { name: 'Condições do veículo na saída', exact: true }).fill('Sem avarias na saída de teste.');
      await dialog.getByRole('button', { name: 'Confirmar saída', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'Vistoria de saída', exact: true }).click();
      dialog = page.getByRole('dialog');
      const photo = join(temporary, 'vistoria-saida-qa.png');
      const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d'); context.fillStyle = '#edf3fb'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#2563eb'; context.fillRect(130, 130, 380, 120); context.fillStyle = '#102542'; context.beginPath(); context.arc(210, 255, 30, 0, 2 * Math.PI); context.arc(440, 255, 30, 0, 2 * Math.PI); context.fill(); context.font = '24px sans-serif'; context.fillText('Vistoria fictícia de saída QA', 140, 80); return canvas.toDataURL('image/png').split(',')[1];
      });
      await writeFile(photo, Buffer.from(image, 'base64'));
      await dialog.getByLabel('Adicionar foto ou vídeo').setInputFiles(photo);
      await dialog.getByRole('button', { name: 'Enviar ou retomar', exact: true }).click();
      await expect(dialog.getByText('Arquivo enviado e conferido.', { exact: true })).toBeVisible();
      await expect(dialog.getByAltText('vistoria-saida-qa.png')).toBeVisible();
      console.log('QA frota: foto de saída enviada');
      await capture('vistoria-saida-desktop');
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
      await page.getByRole('button', { name: 'Registrar retorno', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('spinbutton', { name: 'Quilometragem no retorno (km)', exact: true }).fill('1234');
      await dialog.getByRole('textbox', { name: 'Condições do veículo no retorno', exact: true }).fill('Retornou sem novas avarias.');
      await dialog.getByRole('button', { name: 'Confirmar retorno', exact: true }).click();
      await expect(dialog.getByRole('region', { name: 'Fotos e vídeos da vistoria de retorno', exact: true })).toBeVisible();
      await dialog.getByLabel('Adicionar foto ou vídeo').setInputFiles(resolve('docs/assets/fluxo-visita.mp4'));
      await dialog.getByRole('button', { name: 'Enviar ou retomar', exact: true }).click();
      await expect(dialog.getByText('Arquivo enviado e conferido.', { exact: true })).toBeVisible();
      await expect.poll(() => dialog.locator('video').evaluate((video) => video.readyState >= 1 && video.duration > 0 && video.videoWidth > 0)).toBe(true);
      await dialog.locator('video').evaluate((video) => { video.muted = true; return video.play(); });
      await expect.poll(() => dialog.locator('video').evaluate((video) => video.currentTime)).toBeGreaterThan(0);
      console.log('QA frota: retorno e vídeo privado reproduzido');
      await capture('vistoria-retorno-video-desktop');
      await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
      await page.reload(); await navigate('Frota própria');
      await expect(page.getByRole('row').filter({ hasText: 'QAT1A23' })).toContainText('34 km');
      await capture('frota-retorno-desktop');
      await navigate('Saída de materiais');
      await page.getByRole('button', { name: 'Registrar saída de material', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Material / descrição', exact: true }).fill('Caixas térmicas fictícias QA');
      await dialog.getByRole('textbox', { name: 'Quantidade e unidade', exact: true }).fill('12 unidades');
      await dialog.getByRole('textbox', { name: 'Número da nota fiscal', exact: true }).fill('123456');
      await dialog.getByRole('textbox', { name: 'Destino / destinatário', exact: true }).fill('Cliente fictício QA');
      await dialog.getByRole('textbox', { name: 'Responsável pela retirada', exact: true }).fill('Responsável fictício QA');
      await dialog.getByRole('textbox', { name: 'Placa do veículo', exact: true }).fill('QAT1A23');
      await dialog.getByRole('button', { name: 'Salvar registro', exact: true }).click(); await expect(dialog).toHaveCount(0);
      await page.getByRole('textbox', { name: 'Buscar material, nota fiscal ou destino', exact: true }).fill('123456');
      await expect(page.getByRole('row').filter({ hasText: 'Caixas térmicas fictícias QA' })).toContainText('123456');
      await capture('material-nota-fiscal-desktop');
      console.log('QA materiais: nota fiscal persistida e buscável');
      await page.reload(); await navigate('Saída de materiais');
      await expect(page.getByRole('row').filter({ hasText: 'Caixas térmicas fictícias QA' })).toContainText('123456');
      await page.setViewportSize({ width: 390, height: 844 }); await capture('material-nota-fiscal-mobile');
      await navigate('Frota própria'); await capture('frota-retorno-mobile');
      const snapshot = await readSnapshot(db); validateState(snapshot.state);
      expect(snapshot.state.fleetTrips).toHaveLength(1); expect(snapshot.state.fleetTrips[0].status).toBe('returned'); expect(snapshot.state.fleetTrips[0].distanceKm).toBe(34);
      expect(snapshot.state.materialExits[0].invoiceNumber).toBe('123456');
      const assets = await owner.query("SELECT l.phase,a.mime_type FROM media_links l JOIN media_assets a ON a.id=l.asset_id WHERE l.collection='fleetTrips' AND a.status='ready' ORDER BY l.phase");
      expect(assets.rows).toEqual([{ phase: 'departure', mime_type: 'image/png' }, { phase: 'return', mime_type: 'video/mp4' }]); expect(errors).toEqual([]);
    } finally { await stopFixture(); }
  });
  console.log(JSON.stringify({ status: 'passed', screenshots, errors }));
} catch (error) {
  console.error(logs); throw error;
} finally {
  await stopFixture();
  await writeFile(join(output, 'relatorio.json'), JSON.stringify({ screenshots, errors }, null, 2));
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw Error('Pasta QA inválida.');
  await rm(temporary, { recursive: true, force: true });
}
