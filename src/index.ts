import type { Env, LineEvent } from './types';
import { id, iso } from './types';
import { handleText } from './agent';
import { lineClient, type LineClient, type AiClient } from './clients';
import { runScheduler } from './scheduler';
import { verifySignature } from './signature';
export { verifySignature } from './signature';

export async function fetchHandler(request: Request, env: Env, client: LineClient = lineClient(env), ai?: AiClient): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    try {
      await env.DB.prepare('SELECT id FROM users LIMIT 1').all();
      return Response.json({ ok: true, service: 'ART AI', database: 'ok', mode: env.RESPONSE_MODE === 'agent' ? 'agent' : 'echo', aiEnabled: env.RESPONSE_MODE === 'agent' && env.AI_ENABLED === 'true' });
    } catch { return Response.json({ ok: false, database: 'unavailable' }, { status: 503 }); }
  }
  if (url.pathname !== '/webhook/line') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.LINE_CHANNEL_SECRET || !env.LINE_ALLOWED_USER_ID || !env.LINE_CHANNEL_ACCESS_TOKEN) return new Response('Not configured', { status: 503 });
  if (Number(request.headers.get('content-length')) > 65536) return new Response('Too large', { status: 413 });
  // Bound streamed bodies too, before buffering and verifying exact bytes.
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
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (!await verifySignature(bytes.buffer, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) return new Response('Unauthorized', { status: 401 });
  let events: LineEvent[];
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!body || typeof body !== 'object' || !('events' in body) || !Array.isArray(body.events) || body.events.length > 5) throw new Error();
    events = body.events as LineEvent[];
    if (events.some(e => !e || typeof e !== 'object')) throw new Error();
  } catch { return new Response('Invalid JSON/events', { status: 400 }); }
  // Reject unauthorized events before writing anything. Empty verify requests are allowed.
  if (events.some(e => e.source?.type !== 'user' || e.source?.userId !== env.LINE_ALLOWED_USER_ID)) return new Response('Forbidden', { status: 403 });
  // Normal LINE batches are small. Keep reply latency bounded: no asynchronous delayed replies.
  await Promise.all(events.map(async (event) => {
    if (event.type !== 'message' || event.message?.type !== 'text') return;
    if (typeof event.message.text !== 'string' || typeof event.replyToken !== 'string') return;
    const eventId = event.webhookEventId || event.message.id;
    if (typeof eventId !== 'string' || !eventId || eventId.length > 200) return;
    const now = new Date();
    // Very old events cannot safely execute mutations/reuse expired reply tokens.
    if (typeof event.timestamp !== 'number' || now.getTime() - event.timestamp > 50000 || event.timestamp > now.getTime() + 60000) return;
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO processed_line_events(event_id,user_id,status,created_at,updated_at) VALUES (?,?,'claimed',?,?)")
      .bind(eventId, env.LINE_ALLOWED_USER_ID, iso(now), iso(now)).run();
    if (!claimed.meta.changes) return;
    let replyAttempted = false;
    try {
      const reply = env.RESPONSE_MODE === 'agent'
        ? await handleText(env, env.LINE_ALLOWED_USER_ID, event.message.text.slice(0, 2000), now, ai)
        : event.message.text.slice(0, 4900);
      replyAttempted = true;
      await client.reply(event.replyToken, reply);
      await env.DB.prepare("UPDATE processed_line_events SET status='done',updated_at=? WHERE event_id=?").bind(iso(new Date()), eventId).run();
    } catch {
      if (!replyAttempted) {
        try { await client.reply(event.replyToken, 'ยืนยันผลไม่ได้ / Could not confirm the operation. Check /tasks or /status before retrying.'); }
        catch { /* No reply-token retry and no interactive push fallback. */ }
      }
      // A mutation may already have committed. Never replay an event automatically.
      await env.DB.batch([
        env.DB.prepare("UPDATE processed_line_events SET status='uncertain',updated_at=? WHERE event_id=?").bind(iso(new Date()), eventId),
        env.DB.prepare('INSERT INTO agent_logs(id,category,code,created_at) VALUES (?,?,?,?)').bind(id(), 'webhook', 'processing_or_reply_failed', iso(new Date()))
      ]);
    }
  }));
  return new Response('OK');
}

export default {
  fetch: (request: Request, env: Env) => fetchHandler(request, env),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    if (env.RESPONSE_MODE !== 'agent') return;
    ctx.waitUntil(runScheduler(env, new Date(controller.scheduledTime)));
  }
} satisfies ExportedHandler<Env>;
