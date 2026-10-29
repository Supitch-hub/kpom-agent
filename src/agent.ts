import type { Env, Task } from './types';
import { id, iso } from './types';
import { command, ToolSchema, type Tool } from './tools';
import { GeminiClient, type AiClient } from './clients';
import { displayTime, localMonth, parseDate } from './time';

export const HELP = `ART AI — คำสั่ง / Commands
/task ชื่องาน | พรุ่งนี้ 09:00
/tasks — ดูงาน / list tasks
/done UUID — เสร็จ / complete
/edit UUID | ชื่อใหม่
/due UUID | 31/12/2569 09:00
/delete UUID — ลบ (ต้องยืนยัน)
/note ข้อความ
/search คำค้น
/remind ข้อความ | อีก 30 นาที
/remember ภาษา | ไทย — บันทึกความชอบอย่างชัดเจน
/memory, /forget ชื่อความชอบ
/status, /confirm, /cancel
เวลาไทย / Bangkok time. ยืนยันภายใน 5 นาที / confirm within 5 minutes.`;
const msg = (en: boolean, th: string, english: string) => en ? english : th;

export async function handleText(env: Env, user: string, input: string, now: Date, ai: AiClient = new GeminiClient(env)): Promise<string> {
  const en = !/[ก-๙]/.test(input);
  await env.DB.prepare('INSERT OR IGNORE INTO users(id,created_at) VALUES (?,?)').bind(user, iso(now)).run();
  let tool: Tool;
  try {
    const deterministic = command(input);
    if (deterministic) tool = deterministic;
    else if (input.trim().startsWith('/')) return HELP;
    else {
      try { tool = ToolSchema.parse(await ai.understand(input, now)); }
      catch { return msg(en, 'AI ไม่พร้อมใช้งาน ลองคำสั่ง /task /tasks /note /remind หรือ /help', 'AI is unavailable. Use /task /tasks /note /remind or /help.'); }
    }
  } catch { return msg(en, 'รูปแบบคำสั่งไม่ถูกต้อง ใช้ UUID เต็มและดู /help', 'Invalid command. Use the full UUID; see /help.'); }
  if (tool.tool === 'cancel') {
    await env.DB.prepare('UPDATE users SET pending_action=NULL,pending_expires_at=NULL WHERE id=?').bind(user).run();
    return msg(en, 'ยกเลิกแล้ว', 'Cancelled.');
  }
  if (tool.tool === 'confirm') {
    const row = await env.DB.prepare('SELECT pending_action,pending_expires_at FROM users WHERE id=?').bind(user)
      .first<{ pending_action: string | null; pending_expires_at: string | null }>();
    if (!row?.pending_action || !row.pending_expires_at || row.pending_expires_at <= iso(now)) return msg(en, 'ไม่มีรายการให้ยืนยัน หรือหมดเวลาแล้ว', 'No pending confirmation, or it expired.');
    // Compare-and-clear grants exactly one execution to concurrent confirmations.
    const cleared = await env.DB.prepare('UPDATE users SET pending_action=NULL,pending_expires_at=NULL WHERE id=? AND pending_action=? AND pending_expires_at=?')
      .bind(user, row.pending_action, row.pending_expires_at).run();
    if (!cleared.meta.changes) return msg(en, 'รายการนี้ได้รับการยืนยันแล้ว', 'Already confirmed.');
    const pending = JSON.parse(row.pending_action) as { tool: unknown; date?: string };
    return execute(env, user, ToolSchema.parse(pending.tool), now, en, true, pending.date);
  }
  return execute(env, user, tool, now, en);
}

async function execute(env: Env, user: string, tool: Tool, now: Date, en: boolean, confirmed = false, confirmedDate?: string): Promise<string> {
  const db = env.DB;
  let due: string | undefined = confirmedDate;
  if ('when' in tool && tool.when && !confirmedDate) {
    const date = parseDate(tool.when, now);
    if (!date) return msg(en, 'ระบุวันเวลาอนาคต เช่น พรุ่งนี้ 09:00 หรือ 31/12/2569 09:00', 'Specify a future date/time, e.g. tomorrow 09:00 or 2026-12-31 09:00.');
    due = date.at;
    if (date.ambiguous && !confirmed) return stage(tool, due, `${displayTime(due)}`);
  }
  if (due && new Date(due).getTime() <= now.getTime()) return msg(en, 'เวลานี้ผ่านไปแล้ว กรุณาระบุเวลาใหม่', 'That time has passed. Please choose a new time.');
  if (['task.delete', 'memory.delete', 'memory.set'].includes(tool.tool) && !confirmed) return stage(tool, due, JSON.stringify(tool));
  switch (tool.tool) {
    case 'help': return HELP;
    case 'chat': return tool.text;
    case 'task.create': {
      const taskId = id();
      const statements = [db.prepare('INSERT INTO tasks(id,user_id,title,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .bind(taskId, user, tool.title, due ?? null, iso(now), iso(now))];
      if (due) statements.push(reminder(taskId, tool.title, due));
      await db.batch(statements);
      return msg(en, `เพิ่มงานแล้ว: ${tool.title}\nID: ${taskId}${due ? '\n' + displayTime(due) : ''}`, `Task created: ${tool.title}\nID: ${taskId}${due ? '\n' + displayTime(due) : ''}`);
    }
    case 'task.list': {
      const rows = await db.prepare('SELECT id,title,due_at FROM tasks WHERE user_id=? AND completed_at IS NULL ORDER BY due_at IS NULL,due_at,created_at LIMIT 25').bind(user).all<Task>();
      return rows.results.map(t => `${t.title}${t.due_at ? ' — ' + displayTime(t.due_at) : ''}\n${t.id}`).join('\n\n') || msg(en, 'ไม่มีงานค้าง', 'No pending tasks.');
    }
    case 'task.complete': case 'task.edit': case 'task.reschedule': case 'task.delete': {
      const task = await db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').bind(tool.id, user).first<Task>();
      if (!task) return msg(en, 'ไม่พบงาน', 'Task not found.');
      if (tool.tool === 'task.edit') {
        await db.batch([
          db.prepare('UPDATE tasks SET title=?,updated_at=? WHERE id=? AND user_id=?').bind(tool.title, iso(now), tool.id, user),
          db.prepare('UPDATE reminders SET message=? WHERE task_id=? AND user_id=? AND queued_at IS NULL').bind(tool.title, tool.id, user),
          db.prepare("UPDATE notification_outbox SET message=? WHERE kind='reminder' AND source_id IN (SELECT id FROM reminders WHERE task_id=? AND user_id=?) AND state='pending'").bind('⏰ ' + tool.title, tool.id, user)
        ]);
      } else {
        const statements = [db.prepare("UPDATE notification_outbox SET state='failed',error_code='task_changed' WHERE kind='reminder' AND source_id IN (SELECT id FROM reminders WHERE task_id=? AND user_id=?) AND state='pending'").bind(tool.id, user),
          db.prepare('DELETE FROM reminders WHERE task_id=? AND user_id=?').bind(tool.id, user)];
        if (tool.tool === 'task.delete') statements.push(db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').bind(tool.id, user));
        if (tool.tool === 'task.complete') statements.push(db.prepare('UPDATE tasks SET completed_at=?,updated_at=? WHERE id=? AND user_id=?').bind(iso(now), iso(now), tool.id, user));
        if (tool.tool === 'task.reschedule') {
          if (task.completed_at) return msg(en, 'งานนี้เสร็จแล้ว', 'This task is complete.');
          statements.push(db.prepare('UPDATE tasks SET due_at=?,updated_at=? WHERE id=? AND user_id=?').bind(due!, iso(now), tool.id, user), reminder(tool.id, task.title, due!));
        }
        await db.batch(statements);
      }
      return msg(en, 'อัปเดตงานแล้ว', 'Task updated.');
    }
    case 'note.save': {
      const noteId = id();
      await db.prepare('INSERT INTO notes(id,user_id,content,created_at) VALUES (?,?,?,?)').bind(noteId, user, tool.content, iso(now)).run();
      return msg(en, `บันทึกโน้ตแล้ว: ${noteId}`, `Note saved: ${noteId}`);
    }
    case 'note.search': {
      const rows = await db.prepare('SELECT content FROM notes WHERE user_id=? AND instr(lower(content),lower(?)) > 0 ORDER BY created_at DESC LIMIT 10').bind(user, tool.query).all<{ content: string }>();
      return rows.results.map(r => r.content).join('\n\n') || msg(en, 'ไม่พบโน้ต', 'No matching notes.');
    }
    case 'reminder.create':
      await db.prepare('INSERT INTO reminders(id,user_id,message,due_at,created_at) VALUES (?,?,?,?,?)').bind(id(), user, tool.message, due!, iso(now)).run();
      return msg(en, `ตั้งเตือนแล้ว: ${displayTime(due!)}`, `Reminder set: ${displayTime(due!)}`);
    case 'memory.set':
      await db.prepare('INSERT INTO user_preferences(user_id,key,value,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(user, tool.key, tool.value, iso(now)).run();
      return msg(en, 'บันทึกความชอบแล้ว', 'Preference saved.');
    case 'memory.list': {
      const rows = await db.prepare('SELECT key,value FROM user_preferences WHERE user_id=? ORDER BY key LIMIT 30').bind(user).all<{ key: string; value: string }>();
      return rows.results.map(r => `${r.key}: ${r.value}`).join('\n') || msg(en, 'ยังไม่มีความชอบที่บันทึกไว้', 'No saved preferences.');
    }
    case 'memory.delete':
      await db.prepare('DELETE FROM user_preferences WHERE user_id=? AND key=?').bind(user, tool.key).run();
      return msg(en, 'ลบความชอบแล้ว', 'Preference deleted.');
    case 'status': {
      const usage = await db.prepare('SELECT reserved FROM monthly_message_usage WHERE month=?').bind(localMonth(now)).first<{ reserved: number }>();
      const uncertain = await db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE state='uncertain'").first<{ n: number }>();
      return `D1: OK\nAI: ${env.AI_ENABLED === 'true' ? 'enabled (not probed)' : 'disabled'}\nPush reserved/attempted ${localMonth(now)}: ${usage?.reserved ?? 0}/${budget(env)}\nUncertain notifications: ${uncertain?.n ?? 0}\nTimezone: Asia/Bangkok`;
    }
    default: return HELP;
  }
  function reminder(taskId: string, title: string, date: string) {
    return db.prepare('INSERT INTO reminders(id,user_id,task_id,message,due_at,created_at) VALUES (?,?,?,?,?,?)').bind(id(), user, taskId, title, date, iso(now));
  }
  async function stage(action: Tool, date: string | undefined, detail: string) {
    await db.prepare('UPDATE users SET pending_action=?,pending_expires_at=? WHERE id=?').bind(JSON.stringify({ tool: action, date }), new Date(now.getTime() + 300000).toISOString(), user).run();
    return msg(en, `กรุณายืนยัน: ${detail}\n/confirm หรือ /cancel (5 นาที)`, `Please confirm: ${detail}\n/confirm or /cancel (5 minutes)`);
  }
}
export function budget(env: Env): number {
  const n = Number(env.MAX_MONTHLY_PUSH_MESSAGES);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 250) : 0;
}
