const OFFSET = 7 * 60 * 60 * 1000;
export function localDate(now: Date): string {
  return new Date(now.getTime() + OFFSET).toISOString().slice(0, 10);
}
export function localMonth(now: Date): string { return localDate(now).slice(0, 7); }
export function displayTime(value: string): string {
  return new Date(value).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
}
export type ParsedDate = { at: string; ambiguous: boolean };
/** Deliberately small grammar: ambiguous/missing times require confirmation. */
export function parseDate(input: string, now: Date): ParsedDate | null {
  const s = input.trim().toLowerCase().replace(/[๐-๙]/g, c => String(c.charCodeAt(0) - 0x0e50));
  const relative = /^(?:อีก|in)\s*(\d+)\s*(นาที|ชั่วโมง|วัน|minutes?|hours?|days?)$/.exec(s);
  if (relative) {
    const n = Number(relative[1]);
    if (n < 1 || n > 365) return null;
    const unit = relative[2]!;
    const ms = /นาที|minute/.test(unit) ? 60000 : /ชั่วโมง|hour/.test(unit) ? 3600000 : 86400000;
    return { at: new Date(now.getTime() + n * ms).toISOString(), ambiguous: false };
  }
  let date = localDate(now);
  let explicitDay = false;
  let ambiguous = false;
  const day = /^(วันนี้|พรุ่งนี้|มะรืน(?:นี้)?|today|tomorrow)\s*/.exec(s);
  let rest = s;
  if (day) {
    const delta = /พรุ่งนี้|tomorrow/.test(day[1]!) ? 1 : /มะรืน/.test(day[1]!) ? 2 : 0;
    date = localDate(new Date(now.getTime() + delta * 86400000));
    rest = s.slice(day[0].length); explicitDay = true;
  } else {
    const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*/.exec(s);
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*/.exec(s);
    if (ymd || dmy) {
      const m = (ymd || dmy)!;
      let year = Number(ymd ? m[1] : m[3]);
      if (year >= 2400) year -= 543;
      date = `${year}-${m[2]!.padStart(2, '0')}-${(ymd ? m[3] : m[1])!.padStart(2, '0')}`;
      rest = s.slice(m[0].length); explicitDay = true;
    }
  }
  rest = rest.replace(/^(?:เวลา|at)\s*/, '').replace(/\s*น\.?$/, '').trim();
  const period = /^(เช้า|บ่าย|เย็น|คืนนี้|เที่ยง|เที่ยงคืน)$/.exec(rest);
  if (period) {
    const hours: Record<string, number> = { เช้า: 9, บ่าย: 13, เย็น: 18, คืนนี้: 20, เที่ยง: 12, เที่ยงคืน: 0 };
    rest = `${hours[period[1]!]!}:00`;
    if (!['เที่ยง', 'เที่ยงคืน'].includes(period[1]!)) ambiguous = true;
  }
  const thaiTime = /^(?:(บ่าย|เย็น|ตี)\s*)?(\d{1,2})\s*(?:โมง(?:เช้า|เย็น)?|นาฬิกา)?(?:\s*(ครึ่ง|\d{1,2})\s*(?:นาที)?)?$/.exec(rest);
  if (thaiTime) {
    let h = Number(thaiTime[2]);
    if (thaiTime[1] === 'บ่าย' || thaiTime[1] === 'เย็น' || /โมงเย็น/.test(rest)) { if (h < 12) h += 12; }
    else if (thaiTime[1] !== 'ตี' && !/โมงเช้า|นาฬิกา/.test(rest)) ambiguous = true;
    const m = thaiTime[3] === 'ครึ่ง' ? 30 : Number(thaiTime[3] ?? 0);
    rest = `${h}:${String(m).padStart(2, '0')}`;
  }
  const time = /^(\d{1,2})[:.](\d{2})$/.exec(rest);
  if (!time && rest) return null;
  if (!time && !explicitDay) return null;
  const hour = time ? Number(time[1]) : 9;
  const minute = time ? Number(time[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  if (!time || !explicitDay) ambiguous = true;
  let at = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`);
  if (!Number.isFinite(at.getTime()) || localDate(at) !== date) return null;
  if (!explicitDay && at.getTime() <= now.getTime()) {
    at = new Date(at.getTime() + 86400000); ambiguous = true;
  }
  if (at.getTime() <= now.getTime()) return null;
  return { at: at.toISOString(), ambiguous };
}
