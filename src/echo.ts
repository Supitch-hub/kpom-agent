import { DeliveryError, HttpLineClient, MockLineClient, type LineClient } from './line';
import { verifySignature } from './signature';
import type { LineEvent } from './types';

export interface EchoEnv {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_ALLOWED_USER_ID: string;
  MOCK_CLIENTS?: string;
}
// Bounded, best-effort deduplication only. No durable storage in this deployment.
const seen = new Map<string, number>();
type EchoEvent = LineEvent & { deliveryContext?: { isRedelivery?: boolean } };

export async function echoFetch(request: Request, env: EchoEnv, client?: LineClient): Promise<Response> {
  const path = new URL(request.url).pathname;
  const configured = Boolean(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_ALLOWED_USER_ID);
  if (path === '/health' && request.method === 'GET') {
    return Response.json({ ok: configured, service: 'ART AI LINE Echo', mode: 'echo',
      configured, mockClients: env.MOCK_CLIENTS === 'true' }, { status: configured ? 200 : 503 });
  }
  if (path !== '/webhook/line') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (!configured) return new Response('Not configured', { status: 503 });
  if (Number(request.headers.get('content-length')) > 65536) return new Response('Too large', { status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) { await reader.cancel(); return new Response('Too large', { status: 413 }); }
      chunks.push(value);
    }
  }
  const raw = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  if (!await verifySignature(raw.buffer, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) return new Response('Unauthorized', { status: 401 });
  let events: EchoEvent[];
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw));
    if (!body || typeof body !== 'object' || !('events' in body) || !Array.isArray(body.events) || body.events.length > 5) throw new Error();
    events = body.events as EchoEvent[];
    if (events.some(e => !e || typeof e !== 'object')) throw new Error();
  } catch { return new Response('Invalid JSON/events', { status: 400 }); }
  if (events.some(e => e.source?.type !== 'user' || e.source?.userId !== env.LINE_ALLOWED_USER_ID)) return new Response('Forbidden', { status: 403 });
  const line = client ?? (env.MOCK_CLIENTS === 'true' ? new MockLineClient() : new HttpLineClient(env.LINE_CHANNEL_ACCESS_TOKEN));
  const now = Date.now();
  for (const [key, expires] of seen) if (expires <= now) seen.delete(key);
  await Promise.all(events.map(async e => {
    if (e.type !== 'message' || e.message?.type !== 'text' || typeof e.message.text !== 'string' || !e.message.text.length) return;
    if (typeof e.replyToken !== 'string' || !e.replyToken || /^0+$/.test(e.replyToken)) return;
    if (typeof e.timestamp !== 'number' || now - e.timestamp > 50000 || e.timestamp > now + 60000) return;
    // Conservative echo-only policy: never retry redeliveries after an uncertain reply.
    if (e.deliveryContext?.isRedelivery === true) return;
    const eventId = e.webhookEventId || e.message.id;
    if (typeof eventId !== 'string' || !eventId || eventId.length > 200) return;
    const key = `${env.LINE_ALLOWED_USER_ID}:${eventId}`;
    if (seen.has(key)) return;
    if (seen.size >= 1024) seen.delete(seen.keys().next().value!);
    seen.set(key, now + 120000);
    try { await line.reply(e.replyToken, e.message.text.slice(0, 4900)); }
    catch (error) {
      // Log codes only. Never log headers, body, tokens, user IDs or error objects.
      console.warn(error instanceof DeliveryError ? error.code : 'line_echo_reply_failed');
    }
  }));
  return new Response('OK');
}

export default { fetch: (request: Request, env: EchoEnv) => echoFetch(request, env) } satisfies ExportedHandler<EchoEnv>;
