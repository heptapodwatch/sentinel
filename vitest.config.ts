import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    remoteBindings: false,
    miniflare: {
      bindings: {
        INSTANCE_URL: 'https://instance.example.com',
        PING_TOKEN: 'test-only-token-0123456789abcdef0123456789',
        WEBHOOK_URL: 'https://notifier.example.com/events',
      },
    },
  })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 5000 },
});
