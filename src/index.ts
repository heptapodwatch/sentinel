import { DurableObject, env as startupEnv } from 'cloudflare:workers';
import { readConfig, type Notifier, type SentinelEnv } from './config';
import { notify, type Alert } from './notify';
import { currentDeliveries, nextAlarmAt, retryDelayMs, transitionAlert, undeliveredAlerts, type Check, type PendingAlert, type PendingAlerts } from './pending';
import { emptySnapshot, nextReachability, type CheckAgeReport, type ChecksHealth, type Snapshot } from './state';

// Pure validation at module startup refuses a misconfigured Worker before it
// accepts traffic. Revalidate at entrypoints because bindings can change live.
readConfig(startupEnv);

// One Worker watches one instance. The target URL is configuration, not identity.
const objectName = 'instance';

function logRemovedChannels(pending: PendingAlert | undefined, notifiers: Notifier[]) {
  if (!pending) return;
  for (const delivery of pending.deliveries) {
    if (!delivery.delivered && !notifiers.some((notifier) => notifier.kind === delivery.channel)) {
      console.error(JSON.stringify({ event: 'pending_alert_channel_removed', channel: delivery.channel, check: pending.check }));
    }
  }
}

export async function verifyToken(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export class Sentinel extends DurableObject<SentinelEnv> {
  private probe: Promise<void> | undefined;
  private deliveries: Partial<Record<Check, Promise<void>>> = {};

  private async retireIfSuperseded() {
    if (this.ctx.id.equals(this.env.SENTINEL.idFromName(objectName))) return false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    console.log(JSON.stringify({ event: 'sentinel_object_retired' }));
    return true;
  }

  async status() {
    await this.retireIfSuperseded();
    const config = readConfig(this.env);
    const [stored, pending] = await Promise.all([
      this.ctx.storage.get<Snapshot>('state'), this.ctx.storage.get<PendingAlerts>('pending'),
    ]);
    const undelivered = undeliveredAlerts(pending ?? {}, config.notifiers, Date.now());
    return { ...(stored ?? emptySnapshot()), instanceUrl: config.instanceUrl, ok: undelivered.length === 0, undelivered };
  }

  async ping(checkAge?: CheckAgeReport) {
    if (await this.retireIfSuperseded()) return;
    const config = readConfig(this.env);
    const transitions = await this.ctx.storage.transaction(async (storage) => {
      const state = (await storage.get<Snapshot>('state')) ?? emptySnapshot();
      const pending = (await storage.get<PendingAlerts>('pending')) ?? {};
      const now = Date.now();
      const recovery = state.heartbeat.state === 'DOWN';
      const since = state.heartbeat.state === 'DOWN' ? state.heartbeat.since : now;
      state.lastPingAt = now;
      if (state.heartbeat.state !== 'UP') state.heartbeat = { state: 'UP', since: now };
      if (recovery) {
        state.lastAlertAt.heartbeat = now;
        this.queueTransition(pending, { check: 'heartbeat', state: 'UP', since, at: now }, config.notifiers);
        await storage.put('pending', pending);
      }
      const previous = state.checks ?? { state: 'UNKNOWN' };
      let checksTransition = false;
      if (checkAge === undefined) {
        // Legacy pings prove liveness, not recovery. A missing sample breaks a consecutive-failure candidate.
        if (previous.state === 'SUSPECT') state.checks = { state: 'UNKNOWN' };
      } else {
        const failed = checkAge === 'invalid' || (checkAge !== null && checkAge > 900);
        const health = nextReachability(previous, !failed, now);
        const next: ChecksHealth = health.state === 'DOWN' || health.state === 'SUSPECT'
          ? { ...health, reason: checkAge === 'invalid' ? 'invalid check age report' : 'checks not running' }
          : health;
        state.checks = next;
        // Keep an undelivered outage's explanation current without restarting its delivery backoff.
        const queued = pending.checks;
        if (next.state === 'DOWN' && queued?.state === 'DOWN' && queued.reason !== next.reason) {
          queued.reason = next.reason;
          await storage.put('pending', pending);
        }
        if ((next.state === 'DOWN' && previous.state !== 'DOWN') || (next.state === 'UP' && previous.state === 'DOWN')) {
          checksTransition = true;
          state.lastAlertAt.checks = now;
          this.queueTransition(pending, { check: 'checks', state: next.state,
            since: previous.state === 'DOWN' ? previous.since : next.since, at: now,
            reason: next.state === 'DOWN' ? next.reason : previous.state === 'DOWN' ? previous.reason : 'checks not running' }, config.notifiers);
          await storage.put('pending', pending);
        }
      }
      await storage.put('state', state);
      await this.schedule(storage, state, pending, config.graceMs);
      return { heartbeat: recovery, checks: checksTransition };
    });
    await Promise.all([
      ...(transitions.heartbeat ? [this.deliver('heartbeat')] : []),
      ...(transitions.checks ? [this.deliver('checks')] : []),
    ]);
    return this.status();
  }

  async alarm() {
    if (await this.retireIfSuperseded()) return;
    const config = readConfig(this.env);
    await this.ctx.storage.transaction(async (storage) => {
      const state = (await storage.get<Snapshot>('state')) ?? emptySnapshot();
      const pending = (await storage.get<PendingAlerts>('pending')) ?? {};
      const now = Date.now();
      if (state.lastPingAt !== null && state.heartbeat.state === 'UP') {
        const deadline = state.lastPingAt + config.graceMs;
        // A stale alarm must use the most recent ping's deadline.
        if (now >= deadline) {
          state.heartbeat = { state: 'DOWN', since: deadline };
          state.lastAlertAt.heartbeat = now;
          this.queueTransition(pending, { check: 'heartbeat', state: 'DOWN', since: deadline, at: now }, config.notifiers);
          await storage.put('state', state);
          await storage.put('pending', pending);
        }
      }
      await this.schedule(storage, state, pending, config.graceMs);
    });
    await Promise.all([this.deliver('heartbeat'), this.deliver('up'), this.deliver('checks')]);
  }

  private queueTransition(pending: PendingAlerts, alert: Omit<Alert, 'instanceUrl'>, notifiers: Notifier[]) {
    logRemovedChannels(pending[alert.check], notifiers);
    pending[alert.check] = transitionAlert(alert, notifiers, pending[alert.check]);
  }

  private async schedule(storage: DurableObjectTransaction, state: Snapshot, pending: PendingAlerts, graceMs: number) {
    const next = nextAlarmAt(state, pending, graceMs);
    if (next === null) await storage.deleteAlarm();
    // A replacement can become due while its predecessor is in flight. Keep
    // that wakeup armed without spinning on an alarm already in the past.
    else {
      const now = Date.now();
      await storage.setAlarm(next <= now ? now + 1000 : next);
    }
  }

  private async deliver(check: Check) {
    const running = this.deliveries[check];
    if (running) return running;
    const delivery = this.performDelivery(check);
    this.deliveries[check] = delivery;
    try {
      await delivery;
    } finally {
      delete this.deliveries[check];
    }
  }

  private async performDelivery(check: Check) {
    const config = readConfig(this.env);
    const batch = await this.ctx.storage.transaction(async (storage) => {
      const state = (await storage.get<Snapshot>('state')) ?? emptySnapshot();
      const pending = (await storage.get<PendingAlerts>('pending')) ?? {};
      const alert = pending[check];
      if (!alert) return;
      const now = Date.now();
      logRemovedChannels(alert, config.notifiers);
      alert.deliveries = currentDeliveries(alert, config.notifiers, now);
      const due = config.notifiers.flatMap((notifier) => {
        const delivery = alert.deliveries.find((item) => item.channel === notifier.kind);
        if (!delivery || delivery.delivered || delivery.nextAttemptAt > now) return [];
        delivery.attempts++;
        delivery.nextAttemptAt = now + retryDelayMs(delivery.attempts);
        return [{ notifier, delivery }];
      });
      if (alert.deliveries.every((delivery) => delivery.delivered)) delete pending[check];
      await storage.put('pending', pending);
      // Attempt count and the next wakeup commit before any provider I/O.
      await this.schedule(storage, state, pending, config.graceMs);
      return { alert, due };
    });
    if (!batch) return;
    await Promise.all(batch.due.map(async ({ notifier, delivery }) => {
      const delivered = await notify(notifier, { check: batch.alert.check, state: batch.alert.state,
        since: batch.alert.since, at: batch.alert.at, instanceUrl: config.instanceUrl,
        ...(batch.alert.reason === undefined ? {} : { reason: batch.alert.reason }) },
      config.notifierTimeoutMs, delivery.attempts, delivery.unreportedSince);
      if (!delivered) return;
      await this.ctx.storage.transaction(async (storage) => {
        const state = (await storage.get<Snapshot>('state')) ?? emptySnapshot();
        const pending = (await storage.get<PendingAlerts>('pending')) ?? {};
        const current = pending[check];
        // An older completion cannot acknowledge or erase a newer transition.
        if (!current || current.id !== batch.alert.id) return;
        const target = current.deliveries.find((item) => item.channel === notifier.kind);
        if (!target) return;
        target.delivered = true;
        target.unreportedSince = null;
        if (current.deliveries.every((item) => item.delivered)) delete pending[check];
        await storage.put('pending', pending);
        await this.schedule(storage, state, pending, config.graceMs);
      });
    }));
  }

  async checkUp() {
    if (await this.retireIfSuperseded()) return;
    // Coalesce overlapping cron requests without holding a storage input gate
    // across network I/O. Pings and alarms remain independently responsive.
    if (this.probe) return this.probe;
    this.probe = this.performProbe();
    try {
      await this.probe;
    } finally {
      this.probe = undefined;
    }
  }

  private async performProbe() {
    const config = readConfig(this.env);
    let ok: boolean;
    try {
      const response = await fetch(`${config.instanceUrl}/up`, { redirect: 'manual',
        cache: 'no-store', signal: AbortSignal.timeout(config.upTimeoutMs) });
      ok = response.ok;
      await response.body?.cancel();
    } catch {
      // Network failures and timeouts are observations of unreachable /up.
      // Only the fetch boundary is caught; storage/config errors escape.
      ok = false;
      console.error(JSON.stringify({ event: 'up_probe_network_failure' }));
    }
    const transition = await this.ctx.storage.transaction(async (storage) => {
      const state = (await storage.get<Snapshot>('state')) ?? emptySnapshot();
      const pending = (await storage.get<PendingAlerts>('pending')) ?? {};
      const now = Date.now();
      const previous = state.up;
      const next = nextReachability(previous, ok, now);
      if (next === previous) return false;
      state.up = next;
      let transition = false;
      if (next.state === 'DOWN' || (next.state === 'UP' && previous.state === 'DOWN')) {
        transition = true;
        state.lastAlertAt.up = now;
        this.queueTransition(pending, { check: 'up', state: next.state, at: now,
          since: previous.state === 'DOWN' ? previous.since : next.since }, config.notifiers);
        await storage.put('pending', pending);
      }
      await storage.put('state', state);
      await this.schedule(storage, state, pending, config.graceMs);
      return transition;
    });
    if (transition) await this.deliver('up');
  }
}

export default {
  async fetch(request: Request, env: SentinelEnv): Promise<Response> {
    const config = readConfig(env);
    const match = /^\/(ping|status)\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!match) return new Response('Not found', { status: 404 });
    const [, route, token] = match;
    if (!token || !(await verifyToken(token, config.token))) {
      return new Response('Not found', { status: 404 });
    }
    const allowed = route === 'ping' ? ['GET', 'POST'] : ['GET'];
    if (!allowed.includes(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: allowed.join(', ') } });
    }
    const object = env.SENTINEL.getByName(objectName);
    const values = new URL(request.url).searchParams.getAll('check_age_seconds');
    const raw = values[0];
    const age = values.length === 0 ? undefined : values.length === 1 && raw === 'null' ? null
      : values.length === 1 && raw !== undefined && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 'invalid';
    const state = route === 'ping' ? await object.ping(age) : await object.status();
    return Response.json(state, { status: route === 'ping' && age === 'invalid' ? 422 : 200, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  },
  async scheduled(_controller: ScheduledController, env: SentinelEnv) {
    readConfig(env);
    await env.SENTINEL.getByName(objectName).checkUp();
  },
} satisfies ExportedHandler<SentinelEnv>;
