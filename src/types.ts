export interface Env {
  RESPONSE_MODE?: string;
  DB: D1Database;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_ALLOWED_USER_ID: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  AI_ENABLED: string;
  MOCK_CLIENTS: string;
  MAX_MONTHLY_PUSH_MESSAGES: string;
  TIMEZONE: string;
  DAILY_BRIEFING_TIME: string;
}
export interface Task {
  id: string; user_id: string; title: string; due_at: string | null;
  completed_at: string | null;
}
export type LineEvent = {
  webhookEventId?: string; type?: string; replyToken?: string; timestamp?: number;
  source?: { type?: string; userId?: string };
  message?: { type?: string; id?: string; text?: string };
};
export const iso = (date: Date) => date.toISOString();
export const id = () => crypto.randomUUID();
