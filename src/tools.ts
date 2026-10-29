import { z } from 'zod';
const text = z.string().trim().min(1).max(1000);
const key = z.string().trim().min(1).max(80);
const recordId = z.string().uuid();
export const ToolSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('help') }).strict(),
  z.object({ tool: z.literal('chat'), text: text }).strict(),
  z.object({ tool: z.literal('task.create'), title: text, when: text.optional() }).strict(),
  z.object({ tool: z.literal('task.list') }).strict(),
  z.object({ tool: z.literal('task.complete'), id: recordId }).strict(),
  z.object({ tool: z.literal('task.edit'), id: recordId, title: text }).strict(),
  z.object({ tool: z.literal('task.reschedule'), id: recordId, when: text }).strict(),
  z.object({ tool: z.literal('task.delete'), id: recordId }).strict(),
  z.object({ tool: z.literal('note.save'), content: text }).strict(),
  z.object({ tool: z.literal('note.search'), query: text }).strict(),
  z.object({ tool: z.literal('reminder.create'), message: text, when: text }).strict(),
  z.object({ tool: z.literal('memory.set'), key, value: text }).strict(),
  z.object({ tool: z.literal('memory.list') }).strict(),
  z.object({ tool: z.literal('memory.delete'), key }).strict(),
  z.object({ tool: z.literal('status') }).strict(),
  z.object({ tool: z.literal('confirm') }).strict(),
  z.object({ tool: z.literal('cancel') }).strict()
]);
export type Tool = z.infer<typeof ToolSchema>;
export function command(input: string): Tool | null {
  const raw = input.trim();
  const [name, ...args] = raw.split(/\s+/);
  const tail = args.join(' ');
  const parts = tail.split('|').map(s => s.trim());
  const data: Record<string, unknown> = {};
  switch (name?.toLowerCase()) {
    case '/help': case 'help': case 'ช่วยเหลือ': data.tool = 'help'; break;
    case '/tasks': case 'งาน': data.tool = 'task.list'; break;
    case '/task': data.tool = 'task.create'; data.title = parts[0]; if (parts[1]) data.when = parts[1]; break;
    case '/done': data.tool = 'task.complete'; data.id = tail; break;
    case '/edit': data.tool = 'task.edit'; data.id = parts[0]; data.title = parts[1]; break;
    case '/due': data.tool = 'task.reschedule'; data.id = parts[0]; data.when = parts[1]; break;
    case '/delete': data.tool = 'task.delete'; data.id = tail; break;
    case '/note': data.tool = 'note.save'; data.content = tail; break;
    case '/search': data.tool = 'note.search'; data.query = tail; break;
    case '/remind': data.tool = 'reminder.create'; data.message = parts[0]; data.when = parts[1]; break;
    case '/remember': data.tool = 'memory.set'; data.key = parts[0]; data.value = parts[1]; break;
    case '/memory': data.tool = 'memory.list'; break;
    case '/forget': data.tool = 'memory.delete'; data.key = tail; break;
    case '/status': data.tool = 'status'; break;
    case '/confirm': case 'ยืนยัน': data.tool = 'confirm'; break;
    case '/cancel': case 'ยกเลิก': data.tool = 'cancel'; break;
    default: return null;
  }
  return ToolSchema.parse(data);
}
