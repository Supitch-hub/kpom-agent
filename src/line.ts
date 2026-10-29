import type { Env } from './types';
export class DeliveryError extends Error {
  constructor(public code: string, public uncertain: boolean) { super(code); }
}
export interface LineClient {
  reply(token: string, text: string): Promise<void>;
  push(user: string, text: string, retryKey: string): Promise<void>;
}
export class MockLineClient implements LineClient {
  replies: { token: string; text: string }[] = [];
  pushes: { user: string; text: string; retryKey: string }[] = [];
  async reply(token: string, text: string) { this.replies.push({ token, text }); }
  async push(user: string, text: string, retryKey: string) { this.pushes.push({ user, text, retryKey }); }
}
export class HttpLineClient implements LineClient {
  constructor(private token: string) {}
  private async send(kind: string, body: unknown, retryKey?: string) {
    let response: Response;
    try {
      response = await fetch(`https://api.line.me/v2/bot/message/${kind}`, {
        method: 'POST', headers: {
          Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json',
          ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {})
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(7000)
      });
    } catch { throw new DeliveryError('line_network_or_timeout', true); }
    if (!response.ok) throw new DeliveryError(`line_http_${response.status}`, response.status >= 500 || response.status === 409);
  }
  async reply(replyToken: string, text: string) {
    await this.send('reply', { replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] });
  }
  async push(to: string, text: string, retryKey: string) {
    await this.send('push', { to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }, retryKey);
  }
}
export const lineClient = (env: Env): LineClient => env.MOCK_CLIENTS === 'true'
  ? new MockLineClient() : new HttpLineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
