import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { fetchHandler } from '../src/index';
import { MockLineClient } from '../src/clients';

const echoEnv = () => ({ ...env, RESPONSE_MODE: 'echo' });
beforeEach(async () => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
afterEach(async () => reset());

async function request(events: unknown[], signature = true) {
  const body = JSON.stringify({ events });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const signed = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return new Request('https://example.test/webhook/line', { method: 'POST', body,
    headers: signature ? { 'x-line-signature': signed } : {} });
}
const event = (text: string) => ({ type: 'message', webhookEventId: crypto.randomUUID(), timestamp: Date.now(),
  replyToken: 'single-use-token', source: { type: 'user', userId: env.LINE_ALLOWED_USER_ID },
  message: { id: crypto.randomUUID(), type: 'text', text } });

describe('Phase 1 echo', () => {
  it('echoes Thai, English, commands and whitespace without invoking the agent', async () => {
    const line = new MockLineClient();
    const ai = { understand: async (): Promise<never> => { throw new Error('AI must never run'); } };
    for (const text of ['สวัสดีครับ', 'Hello LINE!', '/task Must not create', '  keep\n whitespace  ']) {
      expect((await fetchHandler(await request([event(text)]), echoEnv(), line, ai)).status).toBe(200);
      expect(line.replies.at(-1)).toEqual({ token: 'single-use-token', text });
    }
    expect(line.pushes).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);
  });
  it('rejects absent and invalid signatures without sending replies', async () => {
    const line = new MockLineClient();
    const missing = await request([event('hi')], false);
    expect((await fetchHandler(missing, echoEnv(), line)).status).toBe(401);
    const wrong = await request([event('hi')]);
    wrong.headers.set('x-line-signature', 'A'.repeat(43) + '=');
    expect((await fetchHandler(wrong, echoEnv(), line)).status).toBe(401);
    expect(line.replies).toHaveLength(0);
  });
  it('rejects other users and group/room events', async () => {
    const line = new MockLineClient();
    for (const source of [{ type: 'user', userId: 'Uunauthorized' }, { type: 'group', userId: env.LINE_ALLOWED_USER_ID }, { type: 'room', userId: env.LINE_ALLOWED_USER_ID }]) {
      expect((await fetchHandler(await request([{ ...event('hi'), source }]), echoEnv(), line)).status).toBe(403);
    }
    expect(line.replies).toHaveLength(0);
  });
  it('deduplicates concurrent deliveries and uses Reply API once', async () => {
    const e = event('Only once');
    const line = new MockLineClient();
    await Promise.all([fetchHandler(await request([e]), echoEnv(), line), fetchHandler(await request([e]), echoEnv(), line)]);
    expect(line.replies).toHaveLength(1);
    expect(await env.DB.prepare('SELECT status FROM processed_line_events').first('status')).toBe('done');
  });
  it('accepts verification and ignores nontext events', async () => {
    const line = new MockLineClient();
    expect((await fetchHandler(await request([]), echoEnv(), line)).status).toBe(200);
    const e = event('');
    e.message.type = 'image';
    expect((await fetchHandler(await request([e]), echoEnv(), line)).status).toBe(200);
    expect(line.replies).toHaveLength(0);
  });
  it('records API failure without retrying or using push', async () => {
    const line = new MockLineClient();
    let attempts = 0;
    line.reply = async () => { attempts++; throw new Error('simulated LINE failure'); };
    const e = event('Hi');
    await fetchHandler(await request([e]), echoEnv(), line);
    await fetchHandler(await request([e]), echoEnv(), line);
    expect(attempts).toBe(1);
    expect(line.pushes).toHaveLength(0);
    expect(await env.DB.prepare('SELECT status FROM processed_line_events').first('status')).toBe('uncertain');
  });
  it('reports echo health and disables scheduled work', async () => {
    const response = await fetchHandler(new Request('https://example.test/health'), echoEnv());
    expect(await response.json()).toMatchObject({ ok: true, mode: 'echo', aiEnabled: false });
    let scheduled = false;
    worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, echoEnv(), {
      waitUntil() { scheduled = true; }
    } as unknown as ExecutionContext);
    expect(scheduled).toBe(false);
  });
});
