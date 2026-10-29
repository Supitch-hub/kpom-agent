import type { Env, Task } from './types';
import { id, iso } from './types';
import { budget } from './agent';
import { DeliveryError, lineClient, type LineClient } from './clients';
import { localDate, localMonth } from './time';

export async function enqueueReminders(env: Env, now: Date) {
  // D1 batch is transactional: insertion and marking queued either both commit or neither does.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO notification_outbox(id,user_id,kind,source_id,message,due_at)
      SELECT id,user_id,'reminder',id,'⏰ ' || message,due_at FROM reminders
      WHERE queued_at IS NULL AND due_at<=? AND user_id=? ORDER BY due_at LIMIT 20`).bind(iso(now), env.LINE_ALLOWED_USER_ID),
    env.DB.prepare(`UPDATE reminders SET queued_at=? WHERE queued_at IS NULL
      AND id IN (SELECT source_id FROM notification_outbox WHERE kind='reminder')`).bind(iso(now))
  ]);
}

export async function enqueueBriefing(env: Env, now: Date) {
  const user = env.LINE_ALLOWED_USER_ID;
  if (!user) return;
  const day = localDate(now);
  const end = new Date(new Date(`${day}T00:00:00+07:00`).getTime() + 86400000).toISOString();
  const rows = await env.DB.prepare(`SELECT id,title,due_at FROM tasks WHERE user_id=? AND completed_at IS NULL
    AND due_at<? ORDER BY due_at LIMIT 20`).bind(user, end).all<Task>();
  const text = `☀️ ART AI — ${day}\nงานวันนี้และเกินกำหนด / Today's and overdue tasks\n` +
    (rows.results.map(t => `${t.due_at! < iso(now) ? '⚠️' : '•'} ${t.title}\n${t.id}`).join('\n') || 'ไม่มีงาน / No tasks.');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users(id,created_at) VALUES (?,?)').bind(user, iso(now)),
    env.DB.prepare(`INSERT OR IGNORE INTO notification_outbox(id,user_id,kind,source_id,message,due_at)
      VALUES (?,?,'briefing',?,?,?)`).bind(id(), user, `${user}:${day}`, text.slice(0, 4900), iso(now))
  ]);
}

export async function claimNotification(env: Env, notificationId: string, now: Date): Promise<string | null> {
  const token = id();
  const month = localMonth(now);
  // Each push has exactly one text message and one recipient; reserves one counted message.
  const results = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO monthly_message_usage(month,reserved) VALUES (?,0)').bind(month),
    env.DB.prepare(`UPDATE notification_outbox SET state='claimed',claim_token=?,claimed_at=?
      WHERE id=? AND user_id=? AND state='pending' AND due_at<=?
      AND (SELECT reserved FROM monthly_message_usage WHERE month=?)<?`)
      .bind(token, iso(now), notificationId, env.LINE_ALLOWED_USER_ID, iso(now), month, budget(env)),
    env.DB.prepare(`UPDATE monthly_message_usage SET reserved=reserved+1 WHERE month=?
      AND EXISTS (SELECT 1 FROM notification_outbox WHERE id=? AND claim_token=? AND state='claimed')`)
      .bind(month, notificationId, token)
  ]);
  return results[1]!.meta.changes ? token : null;
}

export async function runScheduler(env: Env, now: Date, client: LineClient = lineClient(env), clock: () => Date = () => new Date()) {
  if (!env.LINE_ALLOWED_USER_ID) return;
  const stale = new Date(now.getTime() - 5 * 60000).toISOString();
  await env.DB.prepare("UPDATE notification_outbox SET state='uncertain',error_code='stale_claim_no_retry' WHERE state='claimed' AND claimed_at<?").bind(stale).run();
  await enqueueReminders(env, now);
  const bangkokClock = new Date(now.getTime() + 7 * 3600000).toISOString().slice(11, 16);
  // Both cron expressions may run at 01:30; unique source_id prevents duplicate briefing.
  if (bangkokClock === env.DAILY_BRIEFING_TIME) await enqueueBriefing(env, now);
  const rows = await env.DB.prepare(`SELECT id,message FROM notification_outbox
    WHERE state='pending' AND due_at<=? AND user_id=? ORDER BY due_at LIMIT 5`).bind(iso(now), env.LINE_ALLOWED_USER_ID)
    .all<{ id: string; message: string }>();
  // At most 5 external calls per invocation; no retries on uncertain outcomes.
  for (const row of rows.results) {
    // Charge the actual attempt month, not a delayed cron's scheduled month.
    const attemptTime = clock();
    const token = await claimNotification(env, row.id, attemptTime);
    if (!token) continue;
    // Mark uncertain before network IO. Crashes cannot cause automatic resend.
    const changed = await env.DB.prepare("UPDATE notification_outbox SET state='uncertain' WHERE id=? AND claim_token=? AND state='claimed'").bind(row.id, token).run();
    if (!changed.meta.changes) continue;
    if (localMonth(clock()) !== localMonth(attemptTime)) {
      await env.DB.prepare("UPDATE notification_outbox SET error_code='month_rollover_no_send' WHERE id=? AND claim_token=?").bind(row.id, token).run();
      continue;
    }
    try {
      await client.push(env.LINE_ALLOWED_USER_ID, row.message, token);
      await env.DB.prepare("UPDATE notification_outbox SET state='sent',sent_at=? WHERE id=? AND claim_token=?").bind(iso(new Date()), row.id, token).run();
    } catch (error) {
      const known = error instanceof DeliveryError;
      await env.DB.prepare('UPDATE notification_outbox SET state=?,error_code=? WHERE id=? AND claim_token=?')
        .bind(known && !error.uncertain ? 'failed' : 'uncertain', known ? error.code : 'unknown_delivery_outcome', row.id, token).run();
      // Reservation is never refunded. An accepted request may have timed out.
    }
  }
  // Short bounded cleanup. Keep webhook IDs for 35 days; no content is logged.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM agent_logs WHERE id IN (SELECT id FROM agent_logs WHERE created_at<? LIMIT 100)').bind(new Date(now.getTime() - 7 * 86400000).toISOString()),
    env.DB.prepare('DELETE FROM processed_line_events WHERE event_id IN (SELECT event_id FROM processed_line_events WHERE created_at<? LIMIT 100)').bind(new Date(now.getTime() - 35 * 86400000).toISOString())
  ]);
}
