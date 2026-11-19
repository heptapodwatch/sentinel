import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { Sentinel } from '../src/index';
import type { SentinelEnv } from '../src/config';
import type { PendingAlerts } from '../src/pending';
import type { Snapshot } from '../src/state';

const token = 'test-only-token-0123456789abcdef0123456789';
const urlA = 'https://instance.example.com';
const urlB = 'https://replacement.example.com';
const testEnv = { ...env, PING_TOKEN: token, WEBHOOK_URL: 'https://notifier.example.com/events' };
const start = 1_800_000_000_000;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

function object() { return env.SENTINEL.getByName('instance'); }
function request(route: 'ping' | 'status', instanceUrl: string) {
  return worker.fetch(new Request(`https://sentinel.example.com/${route}/${token}`), { ...testEnv, INSTANCE_URL: instanceUrl });
}

// Like the pending-delivery tests, replace live bindings while retaining the
// real object's SQLite storage. Per-request Worker overrides do not change DO bindings in the test pool.
function configured<T>(overrides: Partial<SentinelEnv>, action: (instance: Sentinel) => Promise<T>) {
  return runInDurableObject(object(), (_instance, state) => action(new Sentinel(state, { ...testEnv, ...overrides })));
}

describe('stable object identity', () => {
  it('keeps ping state and the heartbeat alarm when INSTANCE_URL changes and pings continue', async () => {
    const clock = vi.mocked(Date.now);
    await request('ping', urlA);
    clock.mockReturnValue(start + 200_000);
    await request('ping', urlB);
    expect(await (await request('status', urlB)).json()).toMatchObject({
      lastPingAt: start + 200_000, heartbeat: { state: 'UP', since: start },
      lastAlertAt: { heartbeat: null },
    });
    expect(await configured({ INSTANCE_URL: urlB }, (instance) => instance.status()))
      .toMatchObject({ instanceUrl: urlB, heartbeat: { state: 'UP', since: start } });
    await runInDurableObject(object(), async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(start + 500_000);
    });
    clock.mockReturnValue(start + 300_001);
    await runDurableObjectAlarm(object());
    expect((await object().status()).heartbeat).toEqual({ state: 'UP', since: start });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('alerts DOWN once from the stable object after pings stop', async () => {
    await request('ping', urlA);
    expect(await (await request('status', urlB)).json()).toMatchObject({
      lastPingAt: start, heartbeat: { state: 'UP', since: start },
    });
    vi.mocked(Date.now).mockReturnValue(start + 300_000);
    expect(await runDurableObjectAlarm(object())).toBe(true);
    expect(await object().status()).toMatchObject({ heartbeat: { state: 'DOWN', since: start + 300_000 } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(testEnv.WEBHOOK_URL, expect.objectContaining({
      body: expect.stringContaining('"check":"heartbeat","state":"DOWN"'),
    }));
    await runInDurableObject(object(), (instance) => instance.alarm());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps pending deliveries, transition history and retry alarms across an INSTANCE_URL change', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await request('ping', urlA);
    vi.mocked(Date.now).mockReturnValue(start + 300_000);
    await runDurableObjectAlarm(object());
    const before = await runInDurableObject(object(), (_instance, state) => state.storage.get<PendingAlerts>('pending'));
    const status = await configured({ INSTANCE_URL: urlB }, (instance) => instance.status());
    expect(status).toMatchObject({ instanceUrl: urlB, ok: false,
      lastAlertAt: { heartbeat: start + 300_000 }, undelivered: [{ attempts: 1, nextAttemptAt: start + 360_000 }] });
    await runInDurableObject(object(), async (_instance, state) => {
      expect(await state.storage.get<PendingAlerts>('pending')).toEqual(before);
      expect(await state.storage.getAlarm()).toBe(start + 360_000);
    });
    vi.mocked(Date.now).mockReturnValue(start + 360_000);
    await configured({ INSTANCE_URL: urlB }, (instance) => instance.alarm());
    expect(fetch).toHaveBeenLastCalledWith(testEnv.WEBHOOK_URL, expect.objectContaining({
      body: expect.stringContaining(`"instanceUrl":"${urlB}"`),
    }));
    expect((await object().status()).undelivered).toEqual([]);
  });

  it('uses the stable object for cron after INSTANCE_URL changes and probes the configured URL', async () => {
    const controller = { cron: '*/5 * * * *', scheduledTime: start, noRetry() {} };
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    await worker.scheduled(controller, testEnv);
    expect((await object().status()).up.state).toBe('SUSPECT');
    await worker.scheduled(controller, { ...testEnv, INSTANCE_URL: urlB });
    expect((await object().status()).up.state).toBe('DOWN');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    await configured({ INSTANCE_URL: urlB }, (instance) => instance.checkUp());
    expect(fetch).toHaveBeenCalledWith(`${urlB}/up`, expect.objectContaining({ redirect: 'manual' }));
    expect((await object().status()).up.state).toBe('UP');
  });
});

describe('superseded objects', () => {
  const entrypoints: ('alarm' | 'ping' | 'status' | 'checkUp')[] = ['alarm', 'ping', 'status', 'checkUp'];
  it.each(entrypoints)(
    'silently deletes legacy state, pending deliveries and alarm on %s', async (entrypoint) => {
      const stub = env.SENTINEL.getByName(urlA);
      const state: Snapshot = { lastPingAt: start, heartbeat: { state: 'UP', since: start },
        up: { state: 'UNKNOWN' }, lastAlertAt: { heartbeat: null, up: null } };
      const pending: PendingAlerts = { up: { id: 'legacy-pending', check: 'up', state: 'DOWN', since: start,
        at: start, deliveries: [{ channel: 'webhook', delivered: false, attempts: 1,
          nextAttemptAt: start + 300_000, unreportedSince: start }] } };
      await runInDurableObject(stub, async (_instance, context) => {
        await context.storage.put({ state, pending });
        await context.storage.setAlarm(start + 300_000);
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(Date.now).mockReturnValue(start + 300_000);
      if (entrypoint === 'alarm') expect(await runDurableObjectAlarm(stub)).toBe(true);
      else await stub[entrypoint]();
      await runInDurableObject(stub, async (_instance, context) => {
        expect(await context.storage.list()).toEqual(new Map());
        expect(await context.storage.getAlarm()).toBeNull();
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'sentinel_object_retired' }));
    },
  );
});
