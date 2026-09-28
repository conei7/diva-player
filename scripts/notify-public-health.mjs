import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PATHS = {
  '/': 'https://diva-player.pages.dev/',
  '/backend-api/api/ready': 'https://diva-player.pages.dev/backend-api/api/ready',
  '/backend-api/api/health': 'https://diva-player.pages.dev/backend-api/api/health',
};
const FAILURE_THRESHOLD = 2;
const RECOVERY_THRESHOLD = 2;

function probeOutcomes(report) {
  const probes = Array.isArray(report?.probes) ? report.probes : [];
  return Object.entries(PATHS).map(([path, url]) => {
    const item = probes.find(probe => probe.path === path && probe.round === 2);
    let ok = Boolean(item?.ok);
    let error = item?.error || null;
    if (path !== '/') {
      if (item?.originRole !== 'primary' || item?.standbyState !== 'missing') {
        ok = false;
        error = item?.originRole !== 'primary' ? 'primary-route-mismatch' : 'standby-route-mismatch';
      }
    }
    return {
      id: `public:${path === '/' ? 'root' : path.endsWith('/ready') ? 'ready' : 'health'}`,
      path,
      url,
      ok,
      status: item?.status ?? null,
      error,
    };
  });
}

export function advanceGithubHealthState(report, previous = {}, now = new Date()) {
  const oldChecks = previous?.checks && typeof previous.checks === 'object' ? previous.checks : {};
  const checks = {};
  const notifications = [];
  for (const outcome of probeOutcomes(report)) {
    const old = oldChecks[outcome.id] && typeof oldChecks[outcome.id] === 'object'
      ? oldChecks[outcome.id] : {};
    const state = {
      consecutiveFailures: outcome.ok ? 0 : (Number(old.consecutiveFailures) || 0) + 1,
      consecutiveSuccesses: outcome.ok ? (Number(old.consecutiveSuccesses) || 0) + 1 : 0,
      active: Boolean(old.active),
      notified: Boolean(old.notified),
      incidentPending: Boolean(old.incidentPending),
      recoveryPending: Boolean(old.recoveryPending),
      startedAt: old.startedAt || null,
      lastStatus: outcome.status,
      lastError: outcome.error,
      lastCheckedAt: now.toISOString(),
    };
    if (!outcome.ok && state.consecutiveFailures >= FAILURE_THRESHOLD && !state.active) {
      state.active = true;
      state.startedAt = now.toISOString();
      state.incidentPending = true;
    }
    if (!outcome.ok) state.recoveryPending = false;
    if (state.active && state.incidentPending) {
      notifications.push({ kind: 'incident', ...outcome, startedAt: state.startedAt, checkedAt: now.toISOString() });
    }
    if (state.active && state.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
      if (state.notified || state.incidentPending) {
        // Preserve delivery order if Discord was unavailable until after the
        // health recovered: send both sides before clearing the incident.
        state.recoveryPending = true;
      } else {
        state.active = false;
        state.startedAt = null;
      }
    }
    if (state.active && state.recoveryPending) {
      notifications.push({ kind: 'recovery', ...outcome, startedAt: state.startedAt, checkedAt: now.toISOString() });
    }
    checks[outcome.id] = state;
  }
  return {
    state: { schemaVersion: 1, source: 'github-actions', updatedAt: now.toISOString(), checks },
    notifications,
    reportOk: Boolean(report?.ok),
  };
}

function notificationContent(notifications) {
  const testOnly = notifications.length > 0 && notifications.every(item => item.testOnly === true);
  const lines = [
    `DIVA Player public health monitor (GitHub Actions)${testOnly ? ' — TEST ONLY (no synthetic state change)' : ''}`,
  ];
  for (const item of notifications) {
    const label = testOnly
      ? (item.kind === 'incident' ? 'テスト障害通知' : 'テスト復旧通知')
      : (item.kind === 'incident' ? '障害を検知' : '復旧を確認');
    lines.push(`• ${label}: ${item.id} (${item.status ?? 'no response'}${item.error ? ` / ${item.error}` : ''})`);
    lines.push(`  ${item.url}`);
    lines.push(`  発生時刻: ${item.startedAt}`);
    lines.push(`  ${item.kind === 'incident' ? '検知' : '復旧確認'}時刻: ${item.checkedAt}`);
  }
  return lines.join('\n').slice(0, 1900);
}

export async function sendGithubHealthNotifications(notifications, webhook, fetchImpl = fetch) {
  if (!notifications.length) return { sent: true, messageId: null };
  if (!webhook) return { sent: false, error: 'DIVA_ALERT_WEBHOOK_URL is not configured' };
  let parsed;
  try { parsed = new URL(webhook); } catch { return { sent: false, error: 'Discord webhook URL is invalid' }; }
  if (parsed.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(parsed.hostname) || !parsed.pathname.startsWith('/api/webhooks/')) {
    return { sent: false, error: 'Discord webhook URL is invalid' };
  }
  try {
    const response = await fetchImpl(`${webhook}${webhook.includes('?') ? '&' : '?'}wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'diva-player-public-health-monitor/1' },
      body: JSON.stringify({ content: notificationContent(notifications), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || typeof payload?.id !== 'string' || !payload.id) {
      return { sent: false, error: `Discord delivery was not acknowledged (HTTP ${response.status})` };
    }
    return { sent: true, messageId: payload.id };
  } catch (error) {
    return { sent: false, error: `Discord delivery failed (${error?.name || 'Error'})` };
  }
}

export async function sendGithubHealthTestNotification(webhook, fetchImpl = fetch, now = new Date()) {
  const checkedAt = now.toISOString();
  const shared = {
    id: 'test:public-health',
    path: '/backend-api/api/health',
    url: PATHS['/backend-api/api/health'],
    status: 200,
    error: null,
    startedAt: checkedAt,
    checkedAt,
    testOnly: true,
  };
  return sendGithubHealthNotifications([
    { kind: 'incident', ...shared },
    { kind: 'recovery', ...shared },
  ], webhook, fetchImpl);
}

export function applyGithubNotificationReceipt(result, delivery) {
  const state = structuredClone(result.state);
  if (delivery.sent) {
    for (const item of result.notifications) {
      const check = state.checks[item.id];
      if (!check) continue;
      if (item.kind === 'incident') {
        check.notified = true;
        check.incidentPending = false;
      }
      if (item.kind === 'recovery') {
        check.active = false;
        check.notified = false;
        check.incidentPending = false;
        check.recoveryPending = false;
        check.startedAt = null;
        check.consecutiveFailures = 0;
        check.consecutiveSuccesses = RECOVERY_THRESHOLD;
      }
      check.lastDiscordMessageId = delivery.messageId;
    }
  }
  return {
    ...result,
    state,
    notificationStatus: result.notifications.length ? (delivery.sent ? 'sent' : 'pending') : 'not-needed',
    notificationError: delivery.sent ? null : delivery.error || null,
  };
}

function parseArgs(argv) {
  const options = { reportFile: 'public-primary-health-report.json', stateFile: 'public-primary-health-state.json', resultFile: 'public-primary-health-result.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${name}`);
    if (name === '--report-file') options.reportFile = value;
    else if (name === '--state-file') options.stateFile = value;
    else if (name === '--result-file') options.resultFile = value;
    else throw new Error(`unsupported option: ${name}`);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = JSON.parse(await readFile(options.reportFile, 'utf8'));
  let previous = {};
  try { previous = JSON.parse(await readFile(options.stateFile, 'utf8')); } catch {}
  const advanced = advanceGithubHealthState(report, previous);
  const delivery = await sendGithubHealthNotifications(advanced.notifications, process.env.DIVA_ALERT_WEBHOOK_URL);
  const result = applyGithubNotificationReceipt(advanced, delivery);
  const testRequested = process.env.DIVA_PUBLIC_HEALTH_DISCORD_TEST === 'true';
  const testDelivery = testRequested
    ? await sendGithubHealthTestNotification(process.env.DIVA_ALERT_WEBHOOK_URL)
    : null;
  await writeFile(options.stateFile, `${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
  const testNotificationStatus = !testRequested ? 'not-requested' : testDelivery.sent ? 'sent' : 'pending';
  await writeFile(options.resultFile, `${JSON.stringify({
    reportOk: result.reportOk,
    notificationStatus: result.notificationStatus,
    notificationError: result.notificationError,
    testNotificationStatus,
    testNotificationMessageId: testDelivery?.messageId || null,
    testNotificationError: testDelivery?.sent ? null : testDelivery?.error || null,
  }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    reportOk: result.reportOk,
    notificationStatus: result.notificationStatus,
    notificationError: result.notificationError,
    notificationCount: result.notifications.length,
    testNotificationStatus,
  }));
  if (!result.reportOk || result.notificationStatus === 'pending' || testNotificationStatus === 'pending') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`Public health notification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
