import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./schema.js";

/**
 * Opens the SQLite database (a single file) and brings its schema up to date.
 *
 * We use Node's built-in `node:sqlite`, so there's no native library to
 * compile in Docker. Pass ":memory:" for a throwaway database (used by tests).
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL"); // safer + faster for a small web app
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const done = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number(r.version)),
  );
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
    console.log(`[db] applied migration ${m.version}: ${m.name}`);
  }
}

/** Run `fn` inside a transaction: all of its writes happen, or none do. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
