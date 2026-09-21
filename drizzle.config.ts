import { defineConfig } from "drizzle-kit";

// Resolve VELARIS_DB_PATH relative to the project root. drizzle-kit operates
// from the CWD, so use process.cwd() (the project root when run via npm scripts).
function dbPath(): string {
  const raw = process.env.VELARIS_DB_PATH ?? "./db/velaris.db";
  return raw.startsWith("/") || raw.startsWith("./")
    ? raw
    : `./${raw}`;
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: dbPath(),
  },
  verbose: true,
  strict: true,
});
