import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

// This command owns both servers, uses disposable local storage and never
// runs scheduled probes or contacts a real notifier.
const temporary = await mkdtemp(join(tmpdir(), 'sentinel-smoke-'));
const alerts = [];
const listener = createServer(async (request, response) => {
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/events');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  alerts.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(204).end();
});
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const listenerPort = listener.address().port;
const portReservation = createServer();
await new Promise((resolve) => portReservation.listen(0, '127.0.0.1', resolve));
const workerPort = portReservation.address().port;
await new Promise((resolve) => portReservation.close(resolve));
const token = 'local-smoke-token-not-a-secret-0123456789abcdef';
const config = ts.parseConfigFileTextToJson('wrangler.jsonc', await readFile('wrangler.jsonc', 'utf8'));
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const base = { ...config.config, main: resolve('src/index.ts'),
  vars: { ...config.config.vars, INSTANCE_URL: 'https://instance.example.invalid', GRACE_SECONDS: '1' } };
delete base.$schema;
const configPath = join(temporary, 'wrangler.json');
await writeFile(configPath, JSON.stringify(base));
const varsPath = join(temporary, '.dev.vars');
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
let log = '';
let worker;
const children = [];
function start() {
  const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', configPath,
    '--ip', '127.0.0.1', '--port', String(workerPort), '--inspector-port', '0',
    '--persist-to', join(temporary, 'state'), '--show-interactive-dev-session', 'false'], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  return child;
}
async function until(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Local smoke timed out\n${log}`);
    await delay(50);
  }
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

try {
  await writeFile(varsPath, `PING_TOKEN=${token}\n`);
  const invalid = start();
  await until(() => log.includes('at least one notifier is required'));
  await stop(invalid);
  console.log('Startup without notifier: refused — Heptapod Sentinel configuration: at least one notifier is required');

  log = '';
  await writeFile(varsPath, `PING_TOKEN=${token}\nWEBHOOK_URL=http://127.0.0.1:${listenerPort}/events\n`);
  worker = start();
  const origin = `http://127.0.0.1:${workerPort}`;
  await until(async () => {
    if (worker.exitCode !== null) throw new Error(`Wrangler exited early\n${log}`);
    try { return (await fetch(`${origin}/unknown`)).status === 404; }
    catch (error) {
      if (error instanceof TypeError && error.cause?.code === 'ECONNREFUSED') return false;
      throw error;
    }
  });
  const ready = log.split('\n').find((line) => line.includes('Ready on '));
  assert.ok(ready, 'Expected Wrangler local startup evidence');
  console.log(ready.trim());
  const ping = await fetch(`${origin}/ping/${token}`);
  assert.equal(ping.status, 200);
  const status = await fetch(`${origin}/status/${token}`);
  assert.equal(status.status, 200);
  const state = await status.json();
  assert.equal(state.heartbeat.state, 'UP');
  assert.equal(typeof state.lastPingAt, 'number');
  console.log(`GET ping: ${ping.status}; GET status: ${status.status} ${JSON.stringify(state)}`);
  const unknown = await fetch(`${origin}/unknown`);
  assert.equal(unknown.status, 404);
  console.log(`GET unknown: ${unknown.status}`);
  await until(() => alerts.length === 1);
  assert.equal(alerts[0].state, 'DOWN');
  await delay(1250);
  assert.equal(alerts.length, 1);
  assert.equal((await fetch(`${origin}/ping/${token}`, { method: 'POST' })).status, 200);
  await until(() => alerts.length === 2);
  assert.equal(alerts[1].state, 'UP');
  console.log(`Local webhook: ${alerts.map((alert) => `${alert.check} ${alert.state}`).join(' → ')}; no repeat while DOWN`);
  console.log('Smoke passed; no external notifications or probes');
} finally {
  for (const child of children) await stop(child);
  await new Promise((resolve) => listener.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
