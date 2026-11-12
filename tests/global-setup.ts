import { execSync } from "node:child_process";

// Make sure the test database (prisma/test.db) matches the schema.
// Tests empty the tables themselves before each case.
export default function setup() {
  execSync("npx prisma db push --skip-generate", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  });
}
