export type Health =
  | { state: 'UNKNOWN' }
  | { state: 'UP'; since: number }
  | { state: 'DOWN'; since: number };
export type Reachability = Health | { state: 'SUSPECT'; since: number };
export type CheckFailureReason = 'checks not running' | 'invalid check age report';
export type ChecksHealth = Exclude<Health, { state: 'DOWN' }> | { state: 'SUSPECT'; since: number; reason: CheckFailureReason }
  | { state: 'DOWN'; since: number; reason: CheckFailureReason };
export type CheckAgeReport = number | null | 'invalid';

export type Snapshot = {
  lastPingAt: number | null;
  heartbeat: Health;
  up: Reachability;
  // Optional because snapshots written by older workers have no check-completion signal.
  checks?: ChecksHealth;
  lastAlertAt: { heartbeat: number | null; up: number | null; checks?: number };
};

export function emptySnapshot(): Snapshot {
  return { lastPingAt: null, heartbeat: { state: 'UNKNOWN' }, up: { state: 'UNKNOWN' },
    lastAlertAt: { heartbeat: null, up: null } };
}

export function nextReachability(current: Reachability, ok: boolean, now: number): Reachability {
  if (ok) return current.state === 'UP' ? current : { state: 'UP', since: now };
  if (current.state === 'DOWN') return current;
  if (current.state === 'SUSPECT') return { state: 'DOWN', since: current.since };
  return { state: 'SUSPECT', since: now };
}
