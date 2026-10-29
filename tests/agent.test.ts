import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { fetchHandler, verifySignature } from '../src/index';
import { handleText } from '../src/agent';
import { MockAiClient, MockLineClient, DeliveryError } from '../src/clients';
import { parseDate } from '../src/time';
import { claimNotification, enqueueBriefing, enqueueReminders, runScheduler } from '../src/scheduler';
import type { Env } from '../src/types';

declare global { namespace Cloudflare { interface Env extends importEnv { TEST_MIGRATIONS: D1Migration[]; } } }
type importEnv = Env;
const now = new Date('2026-10-29T01:00:00Z');
const user = 'Utest';
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(async () => { await reset(); });

async function signed(body: string, signature?: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const value = signature ?? btoa(String.fromCharCode(...new Uint8Array(digest)));
  return new Request('https://example.com/webhook/line', { method: 'POST', body, headers: { 'x-line-signature': value } });
}
function event(overrides = {}) {
  return { type: 'message', webhookEventId: 'event-1', timestamp: Date.now(), replyToken: 'reply-1',
    source: { type: 'user', userId: user }, message: { type: 'text', id: 'msg1', text: '/task Test' }, ...overrides };
}
async function count(table: string) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe('LINE boundary', () => {
  it('verifies exact raw bytes; rejects missing, malformed and altered signatures', async () => {
    const body = '{"events":[]}';
    const req = await signed(body);
    expect(await verifySignature(new TextEncoder().encode(body).buffer, req.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)).toBe(true);
    expect(await verifySignature(new TextEncoder().encode(body + ' ').buffer, req.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)).toBe(false);
    expect(await verifySignature(new ArrayBuffer(0), null, env.LINE_CHANNEL_SECRET)).toBe(false);
    expect((await fetchHandler(await signed(body, 'bad'), env)).status).toBe(401);
  });
  it('accepts LINE verification and reports D1 health', async () => {
    expect((await fetchHandler(await signed('{"events":[]}'), env)).status).toBe(200);
    expect(await (await fetchHandler(new Request('https://example.com/health'), env)).json()).toMatchObject({ ok: true });
  });
  it('rejects unauthorized users, groups and rooms before mutation', async () => {
    for (const source of [{ type: 'user', userId: 'attacker' }, { type: 'group', userId: user }, { type: 'room', userId: user }]) {
      const res = await fetchHandler(await signed(JSON.stringify({ events: [event({ source })] })), env);
      expect(res.status).toBe(403);
    }
    expect(await count('tasks')).toBe(0);
  });
  it('handles duplicate webhook delivery once and replies without push', async () => {
    const body = JSON.stringify({ events: [event()] });
    const line = new MockLineClient();
    await Promise.all([fetchHandler(await signed(body), env, line), fetchHandler(await signed(body), env, line)]);
    expect(await count('tasks')).toBe(1);
    expect(line.replies).toHaveLength(1);
    expect(line.pushes).toHaveLength(0);
    expect(line.replies[0]!.text).toContain('Task created');
  });
  it('does not replay writes after reply failure or stale redelivery', async () => {
    const line = new MockLineClient();
    line.reply = async () => { throw new Error('timeout'); };
    const body = JSON.stringify({ events: [event()] });
    await fetchHandler(await signed(body), env, line);
    await fetchHandler(await signed(body), env, line);
    await fetchHandler(await signed(JSON.stringify({ events: [event({ webhookEventId: 'old', timestamp: Date.now() - 120000 })] })), env, line);
    expect(await count('tasks')).toBe(1);
    expect(await env.DB.prepare('SELECT status FROM processed_line_events').first('status')).toBe('uncertain');
  });
});

describe('trusted time parsing', () => {
  it('resolves Thai, English, relative and Buddhist Era dates in Bangkok', () => {
    expect(parseDate('พรุ่งนี้ 09:30', now)?.at).toBe('2026-10-30T02:30:00.000Z');
    expect(parseDate('today 10:00', now)?.at).toBe('2026-10-29T03:00:00.000Z');
    expect(parseDate('อีก 30 นาที', now)?.at).toBe('2026-10-29T01:30:00.000Z');
    expect(parseDate('31/12/2569 09:00', now)?.at).toBe('2026-12-31T02:00:00.000Z');
    expect(parseDate('2026-12-31 09:00', now)?.at).toBe('2026-12-31T02:00:00.000Z');
    expect(parseDate('พรุ่งนี้ บ่าย 2 โมงครึ่ง', now)?.at).toBe('2026-10-30T07:30:00.000Z');
    expect(parseDate('พรุ่งนี้ ๙ โมงเช้า', now)?.at).toBe('2026-10-30T02:00:00.000Z');
    expect(parseDate('พรุ่งนี้เช้า', now)?.ambiguous).toBe(true);
  });
  it('flags ambiguous expressions and rejects invalid/past dates', () => {
    expect(parseDate('พรุ่งนี้', now)?.ambiguous).toBe(true);
    expect(parseDate('09:00', now)?.ambiguous).toBe(true);
    for (const s of ['2026-02-31 10:00', 'วันนี้ 07:00', 'พรุ่งนี้ 25:00', 'next Friday', 'อีก 0 นาที']) expect(parseDate(s, now)).toBeNull();
  });
});

describe('validated tools and fallback', () => {
  it('creates, edits, completes and deletes owned tasks', async () => {
    await handleText(env, user, '/task ทดสอบ | พรุ่งนี้ 09:00', now);
    const task = await env.DB.prepare('SELECT id,due_at FROM tasks').first<{ id: string; due_at: string }>();
    expect(task?.due_at).toBe('2026-10-30T02:00:00.000Z');
    expect(await count('reminders')).toBe(1);
    await handleText(env, user, `/edit ${task!.id} | ใหม่`, now);
    expect(await env.DB.prepare('SELECT message FROM reminders').first('message')).toBe('ใหม่');
    await handleText(env, user, `/due ${task!.id} | อีก 30 นาที`, now);
    expect(await env.DB.prepare('SELECT due_at FROM reminders').first('due_at')).toBe('2026-10-29T01:30:00.000Z');
    await handleText(env, user, `/done ${task!.id}`, now);
    expect(await count('reminders')).toBe(0);
    await handleText(env, user, `/delete ${task!.id}`, now);
    expect(await count('tasks')).toBe(1);
    await handleText(env, user, '/confirm', now);
    expect(await count('tasks')).toBe(0);
  });
  it('isolates owners and notes, stores memory only after explicit confirmation', async () => {
    await handleText(env, user, '/task Private', now);
    const taskId = await env.DB.prepare('SELECT id FROM tasks').first<string>('id');
    expect(await handleText(env, 'other', `/done ${taskId}`, now)).toContain('not found');
    await handleText(env, user, '/note ซื้อกาแฟ', now);
    expect(await handleText(env, user, '/search กาแฟ', now)).toContain('ซื้อกาแฟ');
    expect(await handleText(env, 'other', '/search กาแฟ', now)).not.toContain('ซื้อกาแฟ');
    await handleText(env, user, '/remember language | Thai', now);
    expect(await count('user_preferences')).toBe(0);
    await handleText(env, user, '/confirm', now);
    expect(await handleText(env, user, '/memory', now)).toContain('language: Thai');
    await handleText(env, user, '/forget language', now);
    await handleText(env, user, '/confirm', now);
    expect(await count('user_preferences')).toBe(0);
  });
  it('requires confirmation for ambiguous dates and expires pending actions', async () => {
    const reply = await handleText(env, user, '/remind Coffee | พรุ่งนี้', now);
    expect(reply).toContain('/confirm');
    expect(await count('reminders')).toBe(0);
    await Promise.all([handleText(env, user, '/confirm', now), handleText(env, user, '/confirm', now)]);
    expect(await count('reminders')).toBe(1);
    await handleText(env, user, '/remind Tea | พรุ่งนี้', now);
    await handleText(env, user, '/confirm', new Date(now.getTime() + 360000));
    expect(await count('reminders')).toBe(1);
  });
  it('works without AI and accepts only validated AI tools', async () => {
    expect(await handleText(env, user, 'hello', now)).toContain('AI is unavailable');
    await handleText(env, user, '/task Offline', now);
    await handleText(env, user, 'add coffee', now, new MockAiClient({ tool: 'task.create', title: 'Coffee' }));
    const malicious = { understand: async () => ({ tool: 'shell', command: 'rm' }) as never };
    // The executor has no shell/HTTP tool even if a nonstandard adapter returns one.
    expect(await handleText(env, user, 'run shell', now, malicious)).toContain('AI is unavailable');
    expect(await count('tasks')).toBe(2);
  });
});

describe('scheduler and atomic budgets', () => {
  async function reminder() {
    await handleText(env, user, '/remind Coffee | อีก 1 นาที', now);
    await enqueueReminders(env, new Date(now.getTime() + 120000));
    return (await env.DB.prepare('SELECT id FROM notification_outbox').first<string>('id'))!;
  }
  it('queues reminders once, claims concurrently once, and reserves quota atomically', async () => {
    const notificationId = await reminder();
    const later = new Date(now.getTime() + 120000);
    await enqueueReminders(env, later);
    expect(await count('notification_outbox')).toBe(1);
    const result = await Promise.all(Array.from({ length: 8 }, () => claimNotification({ ...env, MAX_MONTHLY_PUSH_MESSAGES: '1' }, notificationId, later)));
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await env.DB.prepare('SELECT reserved FROM monthly_message_usage').first('reserved')).toBe(1);
  });
  it('caps concurrent distinct notifications, fails closed on bad config and resets by Bangkok month', async () => {
    await reminder();
    await handleText(env, user, '/remind Tea | อีก 1 นาที', now);
    const later = new Date(now.getTime() + 120000);
    await enqueueReminders(env, later);
    const rows = await env.DB.prepare('SELECT id FROM notification_outbox').all<{ id: string }>();
    const result = await Promise.all(rows.results.map(r => claimNotification({ ...env, MAX_MONTHLY_PUSH_MESSAGES: '1' }, r.id, later)));
    expect(result.filter(Boolean)).toHaveLength(1);
    const pending = rows.results[result[0] ? 1 : 0]!.id;
    expect(await claimNotification({ ...env, MAX_MONTHLY_PUSH_MESSAGES: 'bad' }, pending, later)).toBeNull();
    expect(await claimNotification({ ...env, MAX_MONTHLY_PUSH_MESSAGES: '1' }, pending, new Date('2026-10-31T17:00:00Z'))).toBeTruthy();
  });
  it('sends scheduled push once and never refunds uncertain failures', async () => {
    await reminder();
    const line = new MockLineClient();
    line.push = async () => { throw new DeliveryError('timeout', true); };
    const later = new Date(now.getTime() + 120000);
    await runScheduler(env, later, line);
    await runScheduler(env, later, line);
    expect(await env.DB.prepare('SELECT state FROM notification_outbox').first('state')).toBe('uncertain');
    expect(await env.DB.prepare('SELECT reserved FROM monthly_message_usage').first('reserved')).toBe(1);
  });
  it('creates one briefing per local date across overlapping cron runs', async () => {
    await handleText(env, user, '/task Morning | อีก 10 นาที', now);
    const morning = new Date('2026-10-29T01:30:00Z');
    await Promise.all([enqueueBriefing(env, morning), enqueueBriefing(env, morning)]);
    const line = new MockLineClient();
    await runScheduler(env, morning, line);
    await runScheduler(env, morning, line);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM notification_outbox WHERE kind='briefing'").first('n')).toBe(1);
    expect(line.pushes.filter(p => p.text.includes('☀️'))).toHaveLength(1);
    expect(line.pushes[0]?.text).toContain('Morning');
  });
  it('cancels queued reminders when their task completes', async () => {
    await handleText(env, user, '/task Coffee | อีก 1 นาที', now);
    const taskId = await env.DB.prepare('SELECT id FROM tasks').first<string>('id');
    const later = new Date(now.getTime() + 120000);
    await enqueueReminders(env, later);
    await handleText(env, user, `/done ${taskId}`, later);
    const line = new MockLineClient();
    await runScheduler(env, later, line);
    expect(line.pushes).toHaveLength(0);
  });
  it('never automatically reclaims stale reservations', async () => {
    const notificationId = await reminder();
    const later = new Date(now.getTime() + 120000);
    await claimNotification(env, notificationId, later);
    const line = new MockLineClient();
    await runScheduler(env, new Date(later.getTime() + 360000), line);
    expect(line.pushes).toHaveLength(0);
    expect(await env.DB.prepare('SELECT state FROM notification_outbox').first('state')).toBe('uncertain');
    expect(await env.DB.prepare('SELECT reserved FROM monthly_message_usage').first('reserved')).toBe(1);
  });
  it('reserves delayed cron sends in their actual Bangkok month', async () => {
    await reminder();
    const line = new MockLineClient();
    const actual = new Date('2026-10-31T17:00:02Z');
    await runScheduler(env, new Date('2026-10-31T16:59:00Z'), line, () => actual);
    expect(line.pushes).toHaveLength(1);
    expect(await env.DB.prepare('SELECT month FROM monthly_message_usage').first('month')).toBe('2026-11');
  });
});
