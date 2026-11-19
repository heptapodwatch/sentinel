import type { Notifier } from './config';
import type { CheckFailureReason } from './state';

export type Alert = {
  check: 'heartbeat' | 'up' | 'checks';
  reason?: CheckFailureReason;
  state: 'DOWN' | 'UP';
  since: number;
  at: number;
  instanceUrl: string;
};

export function alertText(alert: Alert, unreportedSince: number | null = null) {
  const check = alert.check === 'checks' ? (alert.reason ?? 'checks not running')
    : alert.check === 'heartbeat' ? 'Scheduler heartbeat' : '/up reachability';
  const since = new Date(alert.since).toISOString();
  const state = alert.state === 'UP' && unreportedSince !== null
    ? `was down from ${since} to ${new Date(alert.at).toISOString()}. Now UP.`
    : `${alert.state}. Since ${since}.`;
  const earlier = unreportedSince !== null && unreportedSince < alert.since
    ? ` Earlier outages since ${new Date(unreportedSince).toISOString()} were not reported.` : '';
  return `Heptapod Sentinel: ${check} ${state}${earlier} Instance: ${alert.instanceUrl}`;
}

// A false result is a delivery observation, not a discarded error: the caller
// keeps its durable obligation and alarm until a later attempt succeeds.
export async function notify(notifier: Notifier, alert: Alert, timeoutMs: number, attempt: number,
  unreportedSince: number | null = null): Promise<boolean> {
  try {
    await send(notifier, alert, timeoutMs, unreportedSince);
    return true;
  } catch (error) {
    const failure = error instanceof NotifierHttpError
      ? { failure: 'http', status: error.status }
      : { failure: error instanceof DOMException && error.name === 'TimeoutError'
        ? 'timeout' : 'transport_or_binding' };
    console.error(JSON.stringify({ event: 'notifier_failed', channel: notifier.kind,
      check: alert.check, state: alert.state, attempt, ...failure }));
    return false;
  }
}

async function send(notifier: Notifier, alert: Alert, timeoutMs: number, unreportedSince: number | null) {
  const text = alertText(alert, unreportedSince);
  if (notifier.kind === 'cloudflare-email') {
    await notifier.binding.send({ from: notifier.from, to: notifier.to,
      subject: `Heptapod Sentinel ${alert.check} ${alert.state}`, text });
    return;
  }
  let url: string;
  let headers: Record<string, string>;
  let body: string;
  switch (notifier.kind) {
    case 'webhook':
      url = notifier.url;
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({ ...alert, message: text });
      break;
    case 'ntfy':
      url = notifier.url;
      headers = { 'Content-Type': 'text/plain; charset=UTF-8', Title: 'Heptapod Sentinel' };
      if (notifier.token) headers.Authorization = `Bearer ${notifier.token}`;
      body = text;
      break;
    case 'brevo':
      url = 'https://api.brevo.com/v3/smtp/email';
      headers = { 'Content-Type': 'application/json', 'api-key': notifier.key };
      body = JSON.stringify({ sender: { email: notifier.from }, to: [{ email: notifier.to }],
        subject: `Heptapod Sentinel ${alert.check} ${alert.state}`, textContent: text });
      break;
  }
  const response = await fetch(url, { method: 'POST', headers, body,
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  // No unbounded provider response body is buffered; release the connection.
  await response.body?.cancel();
  if (!response.ok) throw new NotifierHttpError(response.status);
}

class NotifierHttpError extends Error {
  constructor(readonly status: number) {
    super(`Notifier returned HTTP ${status}`);
  }
}
