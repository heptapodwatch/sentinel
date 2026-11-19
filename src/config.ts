// Wrangler owns configured bindings; only optional secrets and the opt-in email
// binding extend its generated Env. No secret values are compiled into code.
export type SentinelEnv = Env & {
  PING_TOKEN?: string;
  WEBHOOK_URL?: string;
  NTFY_URL?: string;
  NTFY_TOKEN?: string;
  BREVO_API_KEY?: string;
  BREVO_FROM?: string;
  BREVO_TO?: string;
  EMAIL?: SendEmail;
  CF_EMAIL_FROM?: string;
  CF_EMAIL_TO?: string;
};

export type Notifier =
  | { kind: 'webhook'; url: string }
  | { kind: 'ntfy'; url: string; token: string | undefined }
  | { kind: 'brevo'; key: string; from: string; to: string }
  | { kind: 'cloudflare-email'; binding: SendEmail; from: string; to: string };

export function readConfig(env: SentinelEnv) {
  const notifiers: Notifier[] = [];
  if (env.WEBHOOK_URL) notifiers.push({ kind: 'webhook', url: notifierUrl(env.WEBHOOK_URL) });
  if (env.NTFY_URL) {
    const url = notifierUrl(env.NTFY_URL);
    if (new URL(url).hostname.replace(/\.$/, '') === 'ntfy.sh' && !env.NTFY_TOKEN) {
      throw new Error('Heptapod Sentinel configuration: ntfy.sh requires NTFY_TOKEN; anonymous publishing from Workers exhausts shared Cloudflare egress quotas. Use an ntfy account access token or a self-hosted server.');
    }
    notifiers.push({ kind: 'ntfy', url, token: env.NTFY_TOKEN });
  } else if (env.NTFY_TOKEN) {
    throw new Error('Heptapod Sentinel configuration: NTFY_TOKEN requires NTFY_URL');
  }
  if (env.BREVO_API_KEY || env.BREVO_FROM || env.BREVO_TO) {
    if (!env.BREVO_API_KEY) throw new Error('Heptapod Sentinel configuration: BREVO_API_KEY is required');
    notifiers.push({ kind: 'brevo', key: env.BREVO_API_KEY,
      from: emailAddress(env.BREVO_FROM, 'BREVO_FROM'), to: emailAddress(env.BREVO_TO, 'BREVO_TO') });
  }
  if (env.EMAIL || env.CF_EMAIL_FROM || env.CF_EMAIL_TO) {
    if (!env.EMAIL) throw new Error('Heptapod Sentinel configuration: add the EMAIL send_email binding');
    notifiers.push({ kind: 'cloudflare-email', binding: env.EMAIL,
      from: emailAddress(env.CF_EMAIL_FROM, 'CF_EMAIL_FROM'), to: emailAddress(env.CF_EMAIL_TO, 'CF_EMAIL_TO') });
  }
  if (notifiers.length === 0) {
    throw new Error('Heptapod Sentinel configuration: at least one notifier is required (WEBHOOK_URL, NTFY_URL, Brevo, or EMAIL)');
  }
  if (!env.PING_TOKEN || !/^[A-Za-z0-9_-]{32,256}$/.test(env.PING_TOKEN)) {
    throw new Error('Heptapod Sentinel configuration: PING_TOKEN must contain 32–256 URL-safe random characters');
  }
  const instance = new URL(env.INSTANCE_URL);
  if (instance.protocol !== 'https:' || instance.username || instance.password ||
      instance.search || instance.hash || instance.pathname !== '/') {
    throw new Error('Heptapod Sentinel configuration: INSTANCE_URL must be a HTTPS origin, without credentials, query or path');
  }
  return {
    instanceUrl: instance.origin,
    token: env.PING_TOKEN,
    graceMs: seconds(env.GRACE_SECONDS, 'GRACE_SECONDS', 86400) * 1000,
    upTimeoutMs: seconds(env.UP_TIMEOUT_SECONDS, 'UP_TIMEOUT_SECONDS', 10) * 1000,
    notifierTimeoutMs: seconds(env.NOTIFIER_TIMEOUT_SECONDS, 'NOTIFIER_TIMEOUT_SECONDS', 10) * 1000,
    notifiers,
  };
}

function seconds(value: string, name: string, maximum: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`Heptapod Sentinel configuration: ${name} must be an integer between 1 and ${maximum}`);
  }
  return number;
}

function notifierUrl(value: string) {
  const url = new URL(value);
  // HTTP loopback is exclusively for local test listeners; it cannot deliver
  // from a deployed Worker. All other notifier destinations require TLS.
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error('Heptapod Sentinel configuration: notifier URL requires HTTPS (HTTP loopback allowed for local tests only)');
  }
  return url.href;
}

function emailAddress(value: string | undefined, name: string) {
  if (!value || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)) {
    throw new Error(`Heptapod Sentinel configuration: ${name} must be a plain email address`);
  }
  return value;
}
