import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-01",
        d1Databases: ["DB"],
        bindings: {
          SESSION_SECRET: "test-session-secret",
          DEV_MODE: "1",
          DEV_LOGIN_SECRET: "test-dev-secret",
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
