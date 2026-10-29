import { afterEach, describe, expect, it, vi } from 'vitest';
import { echoFetch, type EchoEnv } from '../src/echo';
import { MockLineClient } from '../src/clients';

const config: EchoEnv = { LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-token', LINE_ALLOWED_USER_ID: 'Uecho' };
const event = (text = 'สวัสดี Hello') => ({ type: 'message', webhookEventId: crypto.randomUUID(), timestamp: Date.now(), replyToken: 'reply-token',
  source: { type: 'user', userId: 'Uecho' }, message: { type: 'text', id: crypto.randomUUID(), text } });
async function request(events: unknown[], secret = config.LINE_CHANNEL_SECRET) {
  const body = JSON.stringify({ events });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return new Request('https://example.test/webhook/line', { method: 'POST', body,
    headers: { 'x-line-signature': btoa(String.fromCharCode(...new Uint8Array(signature))) } });
}
afterEach(() => vi.restoreAllMocks());
describe('standalone deployment without D1, AI or Cron', () => {
  it('reports config readiness without accessing a database or exposing secrets', async () => {
    const response = await echoFetch(new Request('https://example.test/health'), config);
    expect(await response.json()).toEqual({ ok: true, service: 'ART AI LINE Echo', mode: 'echo', configured: true, mockClients: false });
    expect((await echoFetch(new Request('https://example.test/health'), { ...config, LINE_CHANNEL_SECRET: '' })).status).toBe(503);
  });
  it('verifies an empty LINE test request and echoes through the actual Reply API adapter', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    expect((await echoFetch(await request([]), config)).status).toBe(200);
    expect((await echoFetch(await request([event()]), config)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.line.me/v2/bot/message/reply');
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ replyToken: 'reply-token', messages: [{ type: 'text', text: 'สวัสดี Hello' }] });
  });
  it('rejects bad signatures, other users and groups', async () => {
    const line = new MockLineClient();
    expect((await echoFetch(await request([event()], 'wrong-secret'), config, line)).status).toBe(401);
    for (const source of [{ type: 'user', userId: 'Uother' }, { type: 'group', userId: 'Uecho' }, { type: 'room', userId: 'Uecho' }]) {
      expect((await echoFetch(await request([{ ...event(), source }]), config, line)).status).toBe(403);
    }
    expect(line.replies).toHaveLength(0);
  });
  it('suppresses same-isolate duplicates and deliberately skips marked redeliveries', async () => {
    const e = event();
    const line = new MockLineClient();
    await Promise.all([echoFetch(await request([e]), config, line), echoFetch(await request([e]), config, line)]);
    await echoFetch(await request([{ ...event(), deliveryContext: { isRedelivery: true } }]), config, line);
    expect(line.replies).toHaveLength(1);
    expect(line.pushes).toHaveLength(0);
  });
  it('never retries uncertain reply failures or uses Push API', async () => {
    const line = new MockLineClient();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    line.reply = async () => { attempts++; throw new Error('Do not log this error object'); };
    const e = event();
    await echoFetch(await request([e]), config, line);
    await echoFetch(await request([e]), config, line);
    expect(attempts).toBe(1);
    expect(line.pushes).toHaveLength(0);
    expect(warning).toHaveBeenCalledExactlyOnceWith('line_echo_reply_failed');
  });
});
