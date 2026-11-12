import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    env: {
      DATABASE_URL: "file:./test.db",
      PAYMENT_PROVIDER: "sandbox",
      SANDBOX_WEBHOOK_SECRET: "test-secret",
    },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
