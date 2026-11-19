import type { Notifier } from './config';
import type { Alert } from './notify';
import type { Snapshot } from './state';

export type Channel = Notifier['kind'];
export type Check = Alert['check'];
export type Delivery = {
  channel: Channel;
  delivered: boolean;
  attempts: number;
  nextAttemptAt: number;
  // Earliest outage this channel has not learned about. One timestamp bounds
  // storage even when several transitions supersede an undelivered alert.
  unreportedSince: number | null;
};
export type PendingAlert = Omit<Alert, 'instanceUrl'> & { id: string; deliveries: Delivery[] };
export type PendingAlerts = Partial<Record<Check, PendingAlert>>;

export function transitionAlert(alert: Omit<Alert, 'instanceUrl'>, notifiers: Notifier[], previous?: PendingAlert): PendingAlert {
  const earliest = previous ? Math.min(previous.since, ...previous.deliveries.flatMap((delivery) =>
    delivery.unreportedSince === null ? [] : [delivery.unreportedSince])) : alert.since;
  return { ...alert, id: crypto.randomUUID(), deliveries: notifiers.map(({ kind }) => {
    const prior = previous?.deliveries.find((delivery) => delivery.channel === kind);
    const unreportedSince = prior ? prior.unreportedSince : previous ? earliest : null;
    return { channel: kind, delivered: false, attempts: 0, nextAttemptAt: alert.at,
      unreportedSince: unreportedSince ?? (alert.state === 'DOWN' ? alert.since : null) };
  }) };
}

export function currentDeliveries(pending: PendingAlert, notifiers: Notifier[], now: number): Delivery[] {
  const unreportedSince = Math.min(pending.since, ...pending.deliveries.flatMap((delivery) =>
    delivery.unreportedSince === null ? [] : [delivery.unreportedSince]));
  return notifiers.map(({ kind }) => pending.deliveries.find((delivery) => delivery.channel === kind) ??
    { channel: kind, delivered: false, attempts: 0, nextAttemptAt: now, unreportedSince });
}

export function retryDelayMs(attempts: number) {
  return ([1, 2, 5, 10][attempts - 1] ?? 30) * 60_000;
}

export function nextAlarmAt(state: Snapshot, pending: PendingAlerts, graceMs: number): number | null {
  const deadlines = Object.values(pending).flatMap((alert) => alert.deliveries
    .filter((delivery) => !delivery.delivered).map((delivery) => delivery.nextAttemptAt));
  if (state.lastPingAt !== null && state.heartbeat.state === 'UP') deadlines.push(state.lastPingAt + graceMs);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function undeliveredAlerts(pending: PendingAlerts, notifiers: Notifier[], now: number) {
  return Object.values(pending).flatMap((alert) => {
    const failing = currentDeliveries(alert, notifiers, now).filter((delivery) => !delivery.delivered);
    return failing.length ? [{ check: alert.check, state: alert.state, since: alert.since, at: alert.at,
      attempts: Math.max(...failing.map((delivery) => delivery.attempts)),
      nextAttemptAt: Math.min(...failing.map((delivery) => delivery.nextAttemptAt)),
      failingNotifiers: failing.map((delivery) => delivery.channel) }] : [];
  });
}
