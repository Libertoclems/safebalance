import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import path from "node:path";

// Tests run against the same Postgres database as the app, but in their own
// "test" schema, so they never touch real data. They empty its tables freely.
const fileEnv = loadEnv("test", process.cwd(), "");
const base = process.env.DATABASE_URL_UNPOOLED ?? fileEnv.DATABASE_URL_UNPOOLED;
if (!base || !base.startsWith("postgres")) {
  throw new Error("Set DATABASE_URL_UNPOOLED in .env to your Postgres connection string to run the tests.");
}
const url = new URL(base);
url.searchParams.set("schema", "test");
process.env.TEST_DATABASE_URL = url.toString();

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    env: {
      DATABASE_URL: url.toString(),
      DATABASE_URL_UNPOOLED: url.toString(),
      PAYMENT_PROVIDER: "sandbox",
      SANDBOX_WEBHOOK_SECRET: "test-secret",
      WHATSAPP_MODE: "test",
      MEDIATOR_MODE: "demo",
      BLOB_READ_WRITE_TOKEN: "",
      BLOB_STORE_ID: "",
    },
    fileParallelism: false,
    testTimeout: 240000, // slow from far away: every query is a round trip to the database
    hookTimeout: 120000,
  },
});
