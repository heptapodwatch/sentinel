import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import worker, { Sentinel } from '../src/index';
import { readConfig, type SentinelEnv } from '../src/config';
import type { PendingAlerts } from '../src/pending';

const token = 'test-only-token-0123456789abcdef0123456789';
const webhook = 'https://notifier.example.com/events';
const ntfy = 'https://ntfy.example.com/topic';
const testEnv = { ...env, PING_TOKEN: token, WEBHOOK_URL: webhook };
const start = 1_800_000_000_000;
let clock: MockInstance<() => number>;
let log: MockInstance<typeof console.error>;
let outcomes: Map<string, (number | Error)[]>;
let sent: { url: string; body: string; status: number }[];
let unexpected: string[];

beforeEach(() => {
  clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  outcomes = new Map();
  sent = [];
  unexpected = [];
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (![webhook, ntfy, 'https://instance.example.com/up'].includes(input)) {
      unexpected.push(input);
      throw new Error('Unexpected external request');
    }
    const outcome = outcomes.get(input)?.shift() ?? 204;
    if (outcome instanceof Error) throw outcome;
    if (input.endsWith('/up')) return new Response(null, { status: outcome });
    if (typeof init?.body !== 'string') throw new Error('Expected notifier body');
    sent.push({ url: input, body: init.body, status: outcome });
    return new Response(null, { status: outcome });
  }));
});
afterEach(async () => {
  expect(unexpected).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

function object() { return env.SENTINEL.getByName('instance'); }
type Stub = ReturnType<typeof object>;

// Exercise changing live bindings against real SQLite-backed storage, without
// modifying the deployed Worker or using credentials/remote providers.
function configured<T>(stub: Stub, overrides: Partial<SentinelEnv>, action: (instance: Sentinel) => Promise<T>) {
  return runInDurableObject(stub, (_instance, state) => action(new Sentinel(state, { ...testEnv, ...overrides })));
}
function pending(stub: Stub) {
  return runInDurableObject(stub, async (_instance, state) => (await state.storage.get<PendingAlerts>('pending')) ?? {});
}
function alarmTime(stub: Stub) {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}
async function expire(stub: Stub) {
  await stub.ping();
  clock.mockReturnValue(start + 300_000);
  await runDurableObjectAlarm(stub);
}

describe('durable pending alerts', () => {
  it('retries through 1, 2, 5, 10, 30, 30 minute backoff, survives restart, and delivers once', async () => {
    let stub = object();
    const id = stub.id;
    outcomes.set(webhook, [503, 503, 503, 503, 503, 503, 204]);
    await expire(stub);
    let at = start + 300_000;
    const delays = [60_000, 120_000, 300_000, 600_000, 1_800_000, 1_800_000];
    for (const [index, delay] of delays.entries()) {
      const due = at + delay;
      expect(await alarmTime(stub)).toBe(due);
      expect((await stub.status()).undelivered).toEqual([{ check: 'heartbeat', state: 'DOWN',
        since: start + 300_000, at: start + 300_000, attempts: index + 1,
        nextAttemptAt: due, failingNotifiers: ['webhook'] }]);
      await runInDurableObject(stub, (instance) => instance.alarm());
      expect(sent).toHaveLength(index + 1); // Redelivery before due does not resend.
      if (index === 1) {
        await abortAllDurableObjects();
        stub = env.SENTINEL.get(id);
        expect((await pending(stub)).heartbeat?.deliveries[0]?.attempts).toBe(2);
      }
      at = due;
      clock.mockReturnValue(at);
      await runDurableObjectAlarm(stub);
    }
    expect(sent.filter((attempt) => attempt.status === 204)).toHaveLength(1);
    expect(sent).toHaveLength(7);
    expect(await stub.status()).toMatchObject({ ok: true, undelivered: [] });
    expect(await pending(stub)).toEqual({});
    expect(await alarmTime(stub)).toBeNull();
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect(sent).toHaveLength(7);
  });

  it('retries only the failed notifier and preserves successful delivery across restart', async () => {
    let stub = object();
    const id = stub.id;
    const config = { NTFY_URL: ntfy };
    outcomes.set(ntfy, [503, 204]);
    await configured(stub, config, (instance) => instance.ping());
    clock.mockReturnValue(start + 300_000);
    await configured(stub, config, (instance) => instance.alarm());
    expect((await pending(stub)).heartbeat?.deliveries).toEqual([
      { channel: 'webhook', delivered: true, attempts: 1, nextAttemptAt: start + 360_000, unreportedSince: null },
      { channel: 'ntfy', delivered: false, attempts: 1, nextAttemptAt: start + 360_000, unreportedSince: start + 300_000 },
    ]);
    expect(await configured(stub, config, (instance) => instance.status())).toMatchObject({ ok: false,
      undelivered: [{ failingNotifiers: ['ntfy'] }] });
    await abortAllDurableObjects();
    stub = env.SENTINEL.get(id);
    clock.mockReturnValue(start + 360_000);
    await configured(stub, config, (instance) => instance.alarm());
    expect(sent.map((attempt) => attempt.url)).toEqual([webhook, ntfy, ntfy]);
    expect(await configured(stub, config, (instance) => instance.status())).toMatchObject({ ok: true, undelivered: [] });
  });

  it('durably acknowledges a successful channel while another channel is still in flight', async () => {
    const stub = object();
    await runInDurableObject(stub, async (_instance, state) => {
      const instance = new Sentinel(state, { ...testEnv, NTFY_URL: ntfy });
      await instance.ping();
      clock.mockReturnValue(start + 300_000);
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      vi.mocked(fetch).mockImplementation(async (url) => {
        if (String(url) === ntfy) { started.resolve(); return response.promise; }
        return new Response(null, { status: 204 });
      });
      const delivery = instance.alarm();
      await started.promise;
      await vi.waitFor(async () => {
        expect((await instance.status()).undelivered).toMatchObject([{ failingNotifiers: ['ntfy'] }]);
      });
      expect((await state.storage.get<PendingAlerts>('pending'))?.heartbeat?.deliveries)
        .toMatchObject([{ channel: 'webhook', delivered: true }, { channel: 'ntfy', delivered: false }]);
      response.resolve(new Response(null, { status: 503 }));
      await delivery;
    });
    const id = stub.id;
    await abortAllDurableObjects();
    expect((await pending(env.SENTINEL.get(id))).heartbeat?.deliveries[0]?.delivered).toBe(true);
  });

  it('supersedes missed DOWN with one combined recovery, but sends normal UP to a channel that received DOWN', async () => {
    const stub = object();
    const config = { NTFY_URL: ntfy };
    outcomes.set(ntfy, [503, 503, 204]);
    await configured(stub, config, (instance) => instance.ping());
    clock.mockReturnValue(start + 300_000);
    await configured(stub, config, (instance) => instance.alarm());
    clock.mockReturnValue(start + 310_000);
    await configured(stub, config, (instance) => instance.ping());
    expect(sent.filter((attempt) => attempt.url === webhook).map((attempt) => JSON.parse(attempt.body).message))
      .toEqual([
        'Heptapod Sentinel: Scheduler heartbeat DOWN. Since 2027-01-15T08:05:00.000Z. Instance: https://instance.example.com',
        'Heptapod Sentinel: Scheduler heartbeat UP. Since 2027-01-15T08:05:00.000Z. Instance: https://instance.example.com',
      ]);
    expect((await pending(stub)).heartbeat).toMatchObject({ state: 'UP', since: start + 300_000, at: start + 310_000 });
    clock.mockReturnValue(start + 370_000);
    await configured(stub, config, (instance) => instance.alarm());
    const delivered = sent.filter((attempt) => attempt.url === ntfy && attempt.status === 204);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.body).toBe('Heptapod Sentinel: Scheduler heartbeat was down from 2027-01-15T08:05:00.000Z to 2027-01-15T08:05:10.000Z. Now UP. Instance: https://instance.example.com');
    expect(await pending(stub)).toEqual({});
    expect(await alarmTime(stub)).toBe(start + 610_000);
  });

  it('retains the earliest unreported outage when DOWN, UP, then another DOWN supersede each other', async () => {
    const stub = object();
    outcomes.set(webhook, [503, 503, 204]);
    await expire(stub);
    clock.mockReturnValue(start + 310_000);
    await stub.ping();
    clock.mockReturnValue(start + 610_000);
    await runDurableObjectAlarm(stub);
    const successes = sent.filter((attempt) => attempt.status === 204);
    expect(successes).toHaveLength(1);
    expect(JSON.parse(successes[0]?.body ?? '{}')).toMatchObject({ state: 'DOWN', since: start + 610_000,
      message: 'Heptapod Sentinel: Scheduler heartbeat DOWN. Since 2027-01-15T08:10:10.000Z. Earlier outages since 2027-01-15T08:05:00.000Z were not reported. Instance: https://instance.example.com' });
    expect(await stub.status()).toMatchObject({ ok: true, undelivered: [] });
  });

  it('does not let an in-flight DOWN completion clear a replacement UP or lose its alarm', async () => {
    const stub = object();
    await runInDurableObject(stub, async (instance, state) => {
      await instance.ping();
      clock.mockReturnValue(start + 300_000);
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      vi.mocked(fetch).mockImplementationOnce(async () => { started.resolve(); return response.promise; });
      const down = instance.alarm();
      await started.promise;
      expect((await state.storage.get<PendingAlerts>('pending'))?.heartbeat?.state).toBe('DOWN');
      clock.mockReturnValue(start + 310_000);
      const recovery = instance.ping();
      // Observe the durable replacement before releasing the old provider call.
      await vi.waitFor(async () => {
        expect((await state.storage.get<PendingAlerts>('pending'))?.heartbeat?.state).toBe('UP');
      });
      response.resolve(new Response(null, { status: 204 }));
      await Promise.all([down, recovery]);
      expect(await instance.status()).toMatchObject({ ok: false, undelivered: [{ state: 'UP', attempts: 0 }] });
      expect(await state.storage.getAlarm()).toBe(start + 311_000);
      clock.mockReturnValue(start + 311_000);
      await instance.alarm();
      expect(await instance.status()).toMatchObject({ ok: true, undelivered: [] });
    });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? '{}').message).toContain('was down from');
  });

  it('combines heartbeat expiry and retry schedules: earliest wins and healthy pings cannot postpone retries', async () => {
    const stub = object();
    outcomes.set('https://instance.example.com/up', [503, 503]);
    outcomes.set(webhook, [503, 503, 503, 204]);
    await stub.ping();
    clock.mockReturnValue(start + 100_000);
    await stub.checkUp();
    await stub.checkUp();
    expect(await alarmTime(stub)).toBe(start + 160_000);
    clock.mockReturnValue(start + 150_000);
    await stub.ping();
    expect(await alarmTime(stub)).toBe(start + 160_000);
    clock.mockReturnValue(start + 160_000);
    await runDurableObjectAlarm(stub);
    expect(await alarmTime(stub)).toBe(start + 280_000);
    clock.mockReturnValue(start + 280_000);
    await runDurableObjectAlarm(stub);
    // Next reachability retry is 580000; heartbeat expires earlier at 450000.
    expect(await alarmTime(stub)).toBe(start + 450_000);
    clock.mockReturnValue(start + 450_000);
    await runDurableObjectAlarm(stub);
    expect((await stub.status()).heartbeat.state).toBe('DOWN');
    expect(await alarmTime(stub)).toBe(start + 580_000);
    clock.mockReturnValue(start + 580_000);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ ok: true, undelivered: [] });
    expect(await alarmTime(stub)).toBeNull();
  });

  it('retries /up without any heartbeat and supersedes its missed DOWN with a combined recovery', async () => {
    const stub = object();
    outcomes.set('https://instance.example.com/up', [503, 503, 200]);
    outcomes.set(webhook, [503, 503, 204]);
    clock.mockReturnValue(start + 100_000);
    await stub.checkUp();
    expect(await alarmTime(stub)).toBeNull();
    clock.mockReturnValue(start + 200_000);
    await stub.checkUp();
    expect(await alarmTime(stub)).toBe(start + 260_000);
    clock.mockReturnValue(start + 210_000);
    await stub.checkUp();
    expect(await alarmTime(stub)).toBe(start + 270_000);
    clock.mockReturnValue(start + 270_000);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ heartbeat: { state: 'UNKNOWN' }, ok: true, undelivered: [] });
    expect(JSON.parse(sent[2]?.body ?? '{}')).toMatchObject({ check: 'up', state: 'UP', since: start + 100_000,
      at: start + 210_000, message: 'Heptapod Sentinel: /up reachability was down from 2027-01-15T08:01:40.000Z to 2027-01-15T08:03:30.000Z. Now UP. Instance: https://instance.example.com' });
    expect(await alarmTime(stub)).toBeNull();
  });

  it('keeps heartbeat and reachability pending independently and retries both when due together', async () => {
    const stub = object();
    outcomes.set('https://instance.example.com/up', [503, 503]);
    outcomes.set(webhook, [503, 503, 204, 204]);
    await expire(stub);
    await stub.checkUp();
    await stub.checkUp();
    expect((await stub.status()).undelivered.map((alert) => alert.check).sort()).toEqual(['heartbeat', 'up']);
    clock.mockReturnValue(start + 360_000);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ ok: true, undelivered: [] });
    expect(sent.filter((attempt) => attempt.status === 204)).toHaveLength(2);
  });

  it('exposes undelivered alerts on authenticated status and stores no configuration secrets or provider bodies', async () => {
    const stub = env.SENTINEL.getByName('instance');
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(`provider-secret-body ${token} owner@example.com`, { status: 429 }));
    await expire(stub);
    const response = await worker.fetch(new Request(`https://sentinel.example.com/status/${token}`), testEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: false, undelivered: [{ check: 'heartbeat', state: 'DOWN',
      since: start + 300_000, attempts: 1, nextAttemptAt: start + 360_000, failingNotifiers: ['webhook'] }] });
    const stored = await runInDurableObject(stub, async (_instance, state) => JSON.stringify([...await state.storage.list()]));
    for (const secret of [token, webhook, testEnv.INSTANCE_URL, 'provider-secret-body']) expect(stored).not.toContain(secret);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'notifier_failed', channel: 'webhook',
      check: 'heartbeat', state: 'DOWN', attempt: 1, failure: 'http', status: 429 }));
    expect((await worker.fetch(new Request('https://sentinel.example.com/status/wrong'), testEnv)).status).toBe(404);
  });

  it('adds email to a pending ntfy alert and drops removed ntfy with a secret-free log instead of remaining stuck', async () => {
    const stub = object();
    const onlyNtfy = { WEBHOOK_URL: '', NTFY_URL: ntfy };
    outcomes.set(ntfy, [429, 429]);
    await configured(stub, onlyNtfy, (instance) => instance.ping());
    clock.mockReturnValue(start + 300_000);
    await configured(stub, onlyNtfy, (instance) => instance.alarm());
    const email = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => ({ messageId: 'local-id' }));
    const withEmail = { ...onlyNtfy, EMAIL: { send: email }, CF_EMAIL_FROM: 'sender@example.com', CF_EMAIL_TO: 'owner@example.com' };
    expect(await configured(stub, withEmail, (instance) => instance.status())).toMatchObject({ ok: false,
      undelivered: [{ failingNotifiers: ['ntfy', 'cloudflare-email'] }] });
    clock.mockReturnValue(start + 360_000);
    await configured(stub, withEmail, (instance) => instance.alarm());
    expect(email).toHaveBeenCalledExactlyOnceWith({ from: 'sender@example.com', to: 'owner@example.com',
      subject: 'Heptapod Sentinel heartbeat DOWN',
      text: 'Heptapod Sentinel: Scheduler heartbeat DOWN. Since 2027-01-15T08:05:00.000Z. Instance: https://instance.example.com' });
    const onlyEmail = { ...withEmail, NTFY_URL: '' };
    expect(await configured(stub, onlyEmail, (instance) => instance.status())).toMatchObject({ ok: true, undelivered: [] });
    clock.mockReturnValue(start + 480_000);
    await configured(stub, onlyEmail, (instance) => instance.alarm());
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'pending_alert_channel_removed', channel: 'ntfy', check: 'heartbeat' }));
    expect(await pending(stub)).toEqual({});
    expect(await alarmTime(stub)).toBeNull();
    expect(email).toHaveBeenCalledTimes(1);
  });

  it('logs a removed failing channel when a recovery supersedes its pending DOWN', async () => {
    const stub = object();
    const withNtfy = { NTFY_URL: ntfy };
    outcomes.set(ntfy, [503]);
    await configured(stub, withNtfy, (instance) => instance.ping());
    clock.mockReturnValue(start + 300_000);
    await configured(stub, withNtfy, (instance) => instance.alarm());
    clock.mockReturnValue(start + 310_000);
    await stub.ping();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'pending_alert_channel_removed', channel: 'ntfy', check: 'heartbeat' }));
    expect(await stub.status()).toMatchObject({ ok: true, undelivered: [] });
    expect(sent.filter((attempt) => attempt.url === ntfy)).toHaveLength(1);
  });

  it('new channels receive a pending combined recovery with the unreported outage', async () => {
    const stub = object();
    outcomes.set(webhook, [503, 503, 204]);
    await expire(stub);
    clock.mockReturnValue(start + 310_000);
    await stub.ping();
    clock.mockReturnValue(start + 370_000);
    await configured(stub, { NTFY_URL: ntfy }, (instance) => instance.alarm());
    expect(sent.find((attempt) => attempt.url === ntfy)?.body).toContain('was down from 2027-01-15T08:05:00.000Z to 2027-01-15T08:05:10.000Z. Now UP.');
    expect(await pending(stub)).toEqual({});
  });
});

describe('ntfy configuration validation', () => {
  it('rejects anonymous ntfy.sh at startup boundaries, including with another valid notifier', async () => {
    const anonymous = { ...testEnv, NTFY_URL: 'https://NTFY.SH/private-topic' };
    expect(() => readConfig(anonymous)).toThrow('ntfy.sh requires NTFY_TOKEN');
    expect(() => readConfig(anonymous)).toThrow('shared Cloudflare egress quotas');
    expect(() => readConfig({ ...anonymous, NTFY_URL: 'https://ntfy.sh./private-topic' })).toThrow('ntfy.sh requires NTFY_TOKEN');
    await expect(worker.fetch(new Request(`https://sentinel.example.com/ping/${token}`), anonymous)).rejects.toThrow('ntfy.sh requires NTFY_TOKEN');
    expect(sent).toEqual([]);
  });

  it('allows an ntfy account token and anonymous self-hosted ntfy', () => {
    expect(readConfig({ ...testEnv, NTFY_URL: 'https://ntfy.sh/private-topic', NTFY_TOKEN: 'dummy-test-key' }).notifiers)
      .toContainEqual({ kind: 'ntfy', url: 'https://ntfy.sh/private-topic', token: 'dummy-test-key' });
    expect(readConfig({ ...testEnv, NTFY_URL: ntfy }).notifiers)
      .toContainEqual({ kind: 'ntfy', url: ntfy, token: undefined });
  });
});
