import { execSync } from "node:child_process";

// Make sure the "test" schema in Postgres matches the data model.
// Tests empty the tables themselves before each case.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see vitest.config.ts)");
  execSync("npx prisma db push --skip-generate", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
  });
}
