import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
const migrations = await readD1Migrations('./migrations');
export default defineConfig({
  plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations,
        LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
        LINE_ALLOWED_USER_ID: 'Utest', MOCK_CLIENTS: 'true', AI_ENABLED: 'false', RESPONSE_MODE: 'agent' } }
  })],
  test: { include: ['tests/**/*.test.ts'] }
});
