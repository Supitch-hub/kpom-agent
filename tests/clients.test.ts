import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { GeminiClient, HttpLineClient } from '../src/clients';

afterEach(() => vi.restoreAllMocks());
describe('real client protocols using mocked HTTP', () => {
  it('uses Reply API for interactions and Push API with stable retry key for schedules', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const line = new HttpLineClient('test-token');
    await line.reply('reply-token', 'Hello');
    await line.push('Utest', 'Reminder', '27b774da-fc3d-4892-a835-a12db98fb950');
    expect(fetch.mock.calls[0]![0]).toBe('https://api.line.me/v2/bot/message/reply');
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ replyToken: 'reply-token', messages: [{ type: 'text', text: 'Hello' }] });
    expect(fetch.mock.calls[0]![1]!.headers).not.toHaveProperty('X-Line-Retry-Key');
    expect(fetch.mock.calls[1]![0]).toBe('https://api.line.me/v2/bot/message/push');
    expect(fetch.mock.calls[1]![1]!.headers).toMatchObject({ 'X-Line-Retry-Key': '27b774da-fc3d-4892-a835-a12db98fb950' });
  });
  it('distinguishes definitive LINE rejection from uncertain server/transport errors', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const line = new HttpLineClient('test-token');
    fetch.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(line.push('Utest', 'Hi', crypto.randomUUID())).rejects.toMatchObject({ uncertain: false, code: 'line_http_429' });
    fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(line.push('Utest', 'Hi', crypto.randomUUID())).rejects.toMatchObject({ uncertain: true });
    fetch.mockRejectedValueOnce(new Error('network'));
    await expect(line.reply('token', 'Hi')).rejects.toMatchObject({ uncertain: true });
  });
  it('validates Gemini output, rejects arbitrary tools, confirmation and malformed output', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const client = new GeminiClient({ ...env, AI_ENABLED: 'true', GEMINI_API_KEY: 'test-key' });
    const response = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    fetch.mockResolvedValueOnce(response('{"tool":"task.create","title":"Coffee"}'));
    expect(await client.understand('add Coffee', new Date())).toEqual({ tool: 'task.create', title: 'Coffee' });
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
    for (const text of ['{"tool":"http","url":"https://evil.test"}', '{"tool":"confirm"}', '{"tool":"task.create","title":""}', 'not JSON']) {
      fetch.mockResolvedValueOnce(response(text));
      await expect(client.understand('test', new Date())).rejects.toBeDefined();
    }
    fetch.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(client.understand('test', new Date())).rejects.toThrow('ai_unavailable');
  });
  it('never calls paid/disabled AI implicitly', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(new GeminiClient({ ...env, AI_ENABLED: 'false', GEMINI_API_KEY: 'test' }).understand('test', new Date())).rejects.toThrow('ai_disabled');
    expect(fetch).not.toHaveBeenCalled();
  });
});
