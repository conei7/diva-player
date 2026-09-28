import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceGithubHealthState,
  applyGithubNotificationReceipt,
  sendGithubHealthTestNotification,
  sendGithubHealthNotifications,
} from './notify-public-health.mjs';

function report(ok) {
  return {
    ok,
    probes: [
      { round: 2, path: '/', ok, status: ok ? 200 : 530, error: ok ? null : 'http-530' },
      { round: 2, path: '/backend-api/api/ready', ok, status: ok ? 200 : 503, error: ok ? null : 'invalid-api-payload', originRole: 'primary', standbyState: 'missing' },
      { round: 2, path: '/backend-api/api/health', ok, status: ok ? 200 : 503, error: ok ? null : 'database-unavailable', originRole: 'primary', standbyState: 'missing' },
    ],
  };
}

test('GitHub monitor alerts after two failures and only resolves after two successes', () => {
  const start = new Date('2026-09-28T00:00:00Z');
  let result = advanceGithubHealthState(report(false), {}, start);
  assert.equal(result.notifications.length, 0);
  result = advanceGithubHealthState(report(false), result.state, new Date(start.getTime() + 15 * 60_000));
  assert.deepEqual(result.notifications.map(item => item.kind), ['incident', 'incident', 'incident']);
  result = applyGithubNotificationReceipt(result, { sent: true, messageId: 'discord-1' });
  assert.equal(result.state.checks['public:ready'].notified, true);
  result = advanceGithubHealthState(report(true), result.state, new Date(start.getTime() + 30 * 60_000));
  assert.equal(result.notifications.length, 0);
  result = advanceGithubHealthState(report(true), result.state, new Date(start.getTime() + 45 * 60_000));
  assert.deepEqual(result.notifications.map(item => item.kind), ['recovery', 'recovery', 'recovery']);
  result = applyGithubNotificationReceipt(result, { sent: true, messageId: 'discord-2' });
  assert.equal(result.state.checks['public:ready'].active, false);
});

test('undelivered incidents remain pending and are retried even if the endpoint recovers', () => {
  const start = new Date('2026-09-28T00:00:00Z');
  let result = advanceGithubHealthState(report(false), {}, start);
  result = advanceGithubHealthState(report(false), result.state, new Date(start.getTime() + 1));
  result = applyGithubNotificationReceipt(result, { sent: false, error: 'timeout' });
  result = advanceGithubHealthState(report(true), result.state, new Date(start.getTime() + 2));
  result = advanceGithubHealthState(report(true), result.state, new Date(start.getTime() + 3));
  assert.deepEqual(result.notifications.map(item => item.kind), ['incident', 'recovery', 'incident', 'recovery', 'incident', 'recovery']);
  result = applyGithubNotificationReceipt(result, { sent: true, messageId: 'discord-3' });
  assert.equal(result.state.checks['public:root'].active, false);
});

test('API route mismatch is considered unhealthy and Discord delivery requires a receipt', async () => {
  const wrongRoute = report(true);
  wrongRoute.probes[1].originRole = 'standby';
  let result = advanceGithubHealthState(wrongRoute, {});
  assert.equal(result.state.checks['public:ready'].consecutiveFailures, 1);
  const notifications = [{ kind: 'incident', id: 'public:ready', url: 'https://diva-player.pages.dev/backend-api/api/ready' }];
  const failed = await sendGithubHealthNotifications(notifications, 'https://discord.com/api/webhooks/1/secret', async () => ({ ok: true, status: 204, json: async () => ({}) }));
  assert.equal(failed.sent, false);
  const sent = await sendGithubHealthNotifications(notifications, 'https://discord.com/api/webhooks/1/secret', async (_url, options) => {
    assert.match(_url, /wait=true/);
    assert.deepEqual(JSON.parse(options.body).allowed_mentions.parse, []);
    return { ok: true, status: 200, json: async () => ({ id: 'confirmed-message' }) };
  });
  assert.equal(sent.messageId, 'confirmed-message');
});

test('manual Discord test is clearly labeled and does not need or mutate monitor state', async () => {
  const now = new Date('2026-09-29T00:00:00.000Z');
  let requestBody;
  const result = await sendGithubHealthTestNotification(
    'https://discord.com/api/webhooks/1/secret',
    async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ id: 'test-message-receipt' }) };
    },
    now,
  );
  assert.equal(result.sent, true);
  assert.equal(result.messageId, 'test-message-receipt');
  assert.match(requestBody.content, /TEST ONLY/);
  assert.match(requestBody.content, /テスト障害通知/);
  assert.match(requestBody.content, /テスト復旧通知/);
  assert.match(requestBody.content, /no synthetic state change/);
  assert.deepEqual(requestBody.allowed_mentions.parse, []);
  assert.equal(Object.hasOwn(result, 'state'), false);
});
