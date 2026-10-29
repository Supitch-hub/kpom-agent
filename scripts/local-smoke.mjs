import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const secret = process.env.LINE_CHANNEL_SECRET;
const user = process.env.LINE_ALLOWED_USER_ID;
if (!secret || !user) throw new Error('Copy .dev.vars.example to .dev.vars first.');
const base = 'http://127.0.0.1:8787';
const health = await fetch(`${base}/health`);
if (!health.ok || !(await health.json()).ok) throw new Error('Health check failed');
const eventId = randomUUID();
const body = JSON.stringify({ events: [{ type: 'message', webhookEventId: eventId, timestamp: Date.now(),
  source: { type: 'user', userId: user }, replyToken: 'local-reply-token',
  message: { type: 'text', id: randomUUID(), text: '/task LOCAL_SMOKE_TEST' } }] });
const signature = createHmac('sha256', secret).update(body).digest('base64');
for (let i = 0; i < 2; i++) {
  const response = await fetch(`${base}/webhook/line`, { method: 'POST', body, headers: { 'x-line-signature': signature } });
  if (response.status !== 200) throw new Error(`Signed webhook failed: ${response.status}`);
}
const rejected = await fetch(`${base}/webhook/line`, { method: 'POST', body });
if (rejected.status !== 401) throw new Error('Unsigned webhook accepted');
console.log('Health OK; signed webhook and duplicate acknowledged; unsigned webhook rejected.');
console.log('Confirm one done event per invocation in local D1. Echo mode creates no task; agent mode creates one LOCAL_SMOKE_TEST task.');
