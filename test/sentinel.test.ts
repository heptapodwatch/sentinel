import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { verifyToken } from '../src/index';
import { readConfig } from '../src/config';
import { notify, type Alert } from '../src/notify';

const token = 'test-only-token-0123456789abcdef0123456789';
const testEnv = { ...env, PING_TOKEN: token, WEBHOOK_URL: 'https://notifier.example.com/events' };
let alerts: Alert[];
let responses: (number | Error)[];
let notifierResponses: number[];
let calls: string[];

beforeEach(() => {
  alerts = [];
  responses = [];
  notifierResponses = [];
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    calls.push(input);
    if (input === 'https://notifier.example.com/events') {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON notifier body');
      alerts.push(JSON.parse(init.body));
      return new Response(null, { status: notifierResponses.shift() ?? 204 });
    }
    if (input === 'https://instance.example.com/up') {
      const response = responses.shift();
      if (response === undefined) throw new Error('Unexpected probe');
      if (response instanceof Error) throw response;
      return new Response(null, { status: response });
    }
    throw new Error(`Unexpected external request: ${input}`);
  }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

function object() { return env.SENTINEL.getByName('instance'); }
function request(path: string, method = 'GET') {
  return worker.fetch(new Request(`https://sentinel.example.com${path}`, { method }), testEnv);
}

describe('Sentinel heartbeat', () => {
  it('stores a ping and grace alarm, alerts once on expiry, recovers once, and survives restart', async () => {
    let stub = object();
    const id = stub.id;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const initial = await stub.status();
    expect(initial.heartbeat.state).toBe('UNKNOWN');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(1_800_000_300_000);
    });
    clock.mockReturnValue(1_800_000_300_001);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.status()).heartbeat).toEqual({ state: 'DOWN', since: 1_800_000_300_000 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ check: 'heartbeat', state: 'DOWN', since: 1_800_000_300_000 });
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect(alerts).toHaveLength(1);
    await abortAllDurableObjects();
    stub = env.SENTINEL.get(id);
    expect((await stub.status()).heartbeat.state).toBe('DOWN');
    clock.mockReturnValue(1_800_000_360_000);
    await stub.ping();
    await stub.ping();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ state: 'UP', since: 1_800_000_300_000 });
    expect((await stub.status()).lastAlertAt.heartbeat).toBe(1_800_000_360_000);
  });

  it('moves the deadline forward on a ping while UP and ignores the old expiry', async () => {
    const stub = object();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await stub.ping();
    clock.mockReturnValue(1_800_000_200_000);
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(1_800_000_500_000);
    });
    clock.mockReturnValue(1_800_000_301_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.status()).heartbeat.state).toBe('UP');
    expect(alerts).toHaveLength(0);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(1_800_000_500_000);
    });
  });

  it('does not let an early or stale alarm mark a fresh ping DOWN', async () => {
    const stub = object();
    await stub.ping();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.status()).heartbeat.state).toBe('UP');
    expect(alerts).toHaveLength(0);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

describe('/up reachability', () => {
  it('requires two consecutive failures, recovers on one success, and does not repeat unchanged state', async () => {
    let stub = object();
    const id = stub.id;
    responses.push(503, 503, 503, 200, 200);
    await stub.checkUp();
    expect((await stub.status()).up.state).toBe('SUSPECT');
    expect(alerts).toHaveLength(0);
    await abortAllDurableObjects();
    stub = env.SENTINEL.get(id);
    await stub.checkUp();
    expect((await stub.status()).up.state).toBe('DOWN');
    await stub.checkUp();
    expect(alerts).toHaveLength(1);
    await stub.checkUp();
    await stub.checkUp();
    expect((await stub.status()).up.state).toBe('UP');
    expect(alerts.map((alert) => [alert.check, alert.state])).toEqual([['up', 'DOWN'], ['up', 'UP']]);
  });

  it('resets the first failure on success and counts timeouts/network errors as failures', async () => {
    const stub = object();
    responses.push(500, 200, new DOMException('timeout', 'TimeoutError'), new Error('network'));
    await stub.checkUp();
    await stub.checkUp();
    await stub.checkUp();
    expect((await stub.status()).up.state).toBe('SUSPECT');
    await stub.checkUp();
    expect(alerts).toHaveLength(1);
  });

  it('cron invokes /up with a ten-second abort signal and rejects redirects', async () => {
    responses.push(302);
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry() {} }, testEnv);
    expect(calls).toContain('https://instance.example.com/up');
    expect(fetch).toHaveBeenCalledWith('https://instance.example.com/up', expect.objectContaining({
      redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal),
    }));
    expect((await env.SENTINEL.getByName('instance').status()).up.state).toBe('SUSPECT');
  });
});

describe('notification failures', () => {
  const alert: Alert = { check: 'heartbeat', state: 'DOWN', since: 1, at: 2, instanceUrl: 'https://instance.example.com' };

  it('logs a failed attempt and reports it for durable retry', async () => {
    const log = vi.spyOn(console, 'error');
    notifierResponses.push(503);
    const [notifier] = readConfig(testEnv).notifiers;
    if (!notifier) throw new Error('Expected webhook notifier');
    expect(await notify(notifier, alert, 1000, 1)).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('notifier_failed'));
  });

  it('sends plain ntfy and Brevo API messages without forwarding credentials through redirects', async () => {
    const send = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const config = readConfig({ ...testEnv, WEBHOOK_URL: '',
      NTFY_URL: 'https://ntfy.example.com/private-topic', NTFY_TOKEN: 'test-ntfy-key',
      BREVO_API_KEY: 'test-brevo-key', BREVO_FROM: 'sender@example.com', BREVO_TO: 'owner@example.com' });
    await Promise.all(config.notifiers.map((notifier) => notify(notifier, alert, 1000, 1)));
    expect(send).toHaveBeenCalledWith('https://ntfy.example.com/private-topic', expect.objectContaining({
      redirect: 'manual', headers: expect.objectContaining({ Authorization: 'Bearer test-ntfy-key', Title: 'Heptapod Sentinel' }),
      body: expect.stringContaining('Heptapod Sentinel: Scheduler heartbeat DOWN. Since 1970-01-01T00:00:00.001Z.'),
    }));
    expect(send).toHaveBeenCalledWith('https://api.brevo.com/v3/smtp/email', expect.objectContaining({
      redirect: 'manual', headers: expect.objectContaining({ 'api-key': 'test-brevo-key' }),
      body: JSON.stringify({ sender: { email: 'sender@example.com' }, to: [{ email: 'owner@example.com' }],
        subject: 'Heptapod Sentinel heartbeat DOWN',
        textContent: 'Heptapod Sentinel: Scheduler heartbeat DOWN. Since 1970-01-01T00:00:00.001Z. Instance: https://instance.example.com' }),
    }));
  });

  it('reports Cloudflare send_email failure and sends plain text on a later attempt', async () => {
    let attempts = 0;
    const binding = {
      async send(message: EmailMessage | EmailMessageBuilder) {
        attempts++;
        expect(message).toEqual({ from: 'sender@example.com', to: 'owner@example.com',
          subject: 'Heptapod Sentinel heartbeat DOWN',
          text: 'Heptapod Sentinel: Scheduler heartbeat DOWN. Since 1970-01-01T00:00:00.001Z. Instance: https://instance.example.com' });
        if (attempts === 1) throw new Error('Simulated binding failure');
        return { messageId: 'local-test-id' };
      },
    };
    const config = readConfig({ ...testEnv, WEBHOOK_URL: '', EMAIL: binding,
      CF_EMAIL_FROM: 'sender@example.com', CF_EMAIL_TO: 'owner@example.com' });
    const [notifier] = config.notifiers;
    if (!notifier) throw new Error('Expected email notifier');
    expect(await notify(notifier, alert, 1000, 1)).toBe(false);
    expect(await notify(notifier, alert, 1000, 2)).toBe(true);
    expect(attempts).toBe(2);
  });

  it('still attempts other configured channels when one fails', async () => {
    const send = vi.mocked(fetch).mockImplementation(async (input) =>
      new Response(null, { status: String(input).includes('notifier.example.com') ? 500 : 204 }));
    const config = readConfig({ ...testEnv, NTFY_URL: 'https://ntfy.example.com/topic' });
    expect(await Promise.all(config.notifiers.map((notifier) => notify(notifier, alert, 1000, 1))))
      .toEqual([false, true]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('https://ntfy.example.com/topic', expect.anything());
  });

  it('keeps a failed DOWN visibly pending and suppresses early alarm redelivery', async () => {
    const stub = object();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_001_000_000);
    await stub.ping();
    clock.mockReturnValue(1_800_001_300_001);
    notifierResponses.push(500);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ heartbeat: { state: 'DOWN' }, ok: false,
      undelivered: [{ check: 'heartbeat', attempts: 1, failingNotifiers: ['webhook'] }] });
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect(alerts).toHaveLength(1);
  });
});

describe('configuration and routing', () => {
  it('refuses missing notifier configuration rather than running an inert watchdog', async () => {
    const missing = { ...testEnv, WEBHOOK_URL: '' };
    expect(() => readConfig(missing)).toThrow('at least one notifier is required');
    await expect(worker.fetch(new Request(`https://sentinel.example.com/ping/${token}`), missing)).rejects.toThrow('at least one notifier');
    expect(calls).toHaveLength(0);
  });

  it('rejects partial notifiers and invalid timing/origin/token settings', () => {
    expect(() => readConfig({ ...testEnv, BREVO_TO: 'owner@example.com' })).toThrow('BREVO_API_KEY');
    expect(() => readConfig({ ...testEnv, CF_EMAIL_TO: 'owner@example.com' })).toThrow('send_email');
    expect(() => readConfig({ ...testEnv, UP_TIMEOUT_SECONDS: '11' })).toThrow('UP_TIMEOUT_SECONDS');
    expect(() => readConfig({ ...testEnv, INSTANCE_URL: 'http://instance.example.com' })).toThrow('HTTPS origin');
    expect(() => readConfig({ ...testEnv, PING_TOKEN: 'short' })).toThrow('PING_TOKEN');
  });

  it('hashes both tokens to fixed-size digests and uses the runtime constant-time primitive for all lengths', async () => {
    const compare = vi.spyOn(crypto.subtle, 'timingSafeEqual');
    expect(await verifyToken(token, token)).toBe(true);
    expect(await verifyToken('x', token)).toBe(false);
    expect(await verifyToken(`${token}x`, token)).toBe(false);
    expect(await verifyToken('x'.repeat(token.length), token)).toBe(false);
    expect(compare).toHaveBeenCalledTimes(4);
    for (const [a, b] of compare.mock.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });

  it('accepts GET/POST ping, returns authenticated status JSON with no caching, rejects unauthorized and unknown routes', async () => {
    for (const method of ['GET', 'POST']) expect((await request(`/ping/${token}`, method)).status).toBe(200);
    const response = await request(`/status/${token}`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const state = await response.json();
    expect(state).toMatchObject({ instanceUrl: testEnv.INSTANCE_URL, heartbeat: { state: 'UP' }, lastPingAt: expect.any(Number) });
    expect((await request(`/status/${token}`, 'POST')).status).toBe(405);
    for (const path of ['/', '/unknown', `/ping/${token}/extra`, '/ping/wrong', '/status/wrong']) {
      expect((await request(path)).status).toBe(404);
    }
    expect(await (await request(`/status/${token}`)).json()).toEqual(state);
    expect(alerts).toHaveLength(0);
  });
});

describe('finished checks reported by scheduler pings', () => {
  it('debounces stale checks across restarts and recovers on a finished check or inactive report', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const ping = (value: string) => request(`/ping/${token}?check_age_seconds=${value}`);
    await ping('901');
    let stub = env.SENTINEL.getByName('instance');
    expect((await stub.status()).checks).toMatchObject({ state: 'SUSPECT' });
    await abortAllDurableObjects();
    stub = env.SENTINEL.getByName('instance');
    clock.mockReturnValue(1_800_000_060_000);
    await ping('961');
    await ping('1021');
    expect((await stub.status()).heartbeat.state).toBe('UP');
    expect((await stub.status()).checks).toMatchObject({ state: 'DOWN', reason: 'checks not running' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ check: 'checks', state: 'DOWN', reason: 'checks not running' });
    await ping('900');
    expect((await stub.status()).checks).toMatchObject({ state: 'UP' });
    expect(alerts[1]).toMatchObject({ check: 'checks', state: 'UP' });
    await ping('901');
    await ping('902');
    await ping('null');
    expect((await stub.status()).checks).toMatchObject({ state: 'UP' });
    expect(alerts.map((alert) => alert.state)).toEqual(['DOWN', 'UP', 'DOWN', 'UP']);
  });

  it('keeps old pings compatible, resets a suspect report but does not clear an established checks outage', async () => {
    const ping = (suffix = '') => request(`/ping/${token}${suffix}`);
    const stub = env.SENTINEL.getByName('instance');
    await ping();
    expect((await stub.status()).heartbeat.state).toBe('UP');
    expect(alerts).toHaveLength(0);
    await ping('?check_age_seconds=901');
    await ping();
    await ping('?check_age_seconds=902');
    expect(alerts).toHaveLength(0);
    await ping('?check_age_seconds=903');
    await ping();
    expect((await stub.status()).checks).toMatchObject({ state: 'DOWN' });
    expect(alerts).toHaveLength(1);
  });

  it('carries the newest checks reason into pending delivery and recovery while DOWN', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    notifierResponses.push(503, 204, 204);
    await request(`/ping/${token}?check_age_seconds=invalid`);
    await request(`/ping/${token}?check_age_seconds=invalid`);
    const stub = env.SENTINEL.getByName('instance');
    expect((await stub.status()).checks).toMatchObject({ state: 'DOWN', reason: 'invalid check age report' });

    await request(`/ping/${token}?check_age_seconds=901`);
    expect((await stub.status()).checks).toMatchObject({ state: 'DOWN', reason: 'checks not running' });
    clock.mockReturnValue(1_800_000_060_001);
    await runDurableObjectAlarm(stub);
    expect(alerts[1]).toMatchObject({ check: 'checks', state: 'DOWN', reason: 'checks not running' });
    await request(`/ping/${token}?check_age_seconds=0`);
    expect(alerts[2]).toMatchObject({ check: 'checks', state: 'UP', reason: 'checks not running' });
  });

  it('retries an undelivered checks alert from the durable alarm without a new ping', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const path = `/ping/${token}?check_age_seconds=901`;
    notifierResponses.push(503, 204);
    await request(path);
    await request(path);
    const stub = env.SENTINEL.getByName('instance');
    expect((await stub.status()).undelivered).toMatchObject([{ check: 'checks', state: 'DOWN', attempts: 1 }]);

    clock.mockReturnValue(1_800_000_060_001);
    await runDurableObjectAlarm(stub);

    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ check: 'checks', reason: 'checks not running', state: 'DOWN' });
    expect((await stub.status()).undelivered).toEqual([]);
  });

  it.each(['', '-1', 'NaN', '1.5', '9007199254740992', '1&check_age_seconds=2'])(
    'rejects invalid age %s but records liveness and debounces an invalid-report alert', async (age) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
      const path = `/ping/${token}?check_age_seconds=${age}`;
      expect((await request(path)).status).toBe(422);
      const stub = env.SENTINEL.getByName('instance');
      expect((await stub.status()).heartbeat.state).toBe('UP');
      expect((await stub.status()).lastPingAt).toBe(1_800_000_000_000);
      expect(alerts).toHaveLength(0);
      expect((await request(path)).status).toBe(422);
      expect((await stub.status()).checks).toMatchObject({ state: 'DOWN', reason: 'invalid check age report' });
      expect(alerts[0]).toMatchObject({ check: 'checks', state: 'DOWN', reason: 'invalid check age report' });
    });
});
