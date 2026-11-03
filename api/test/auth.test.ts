/** Tests for accounts, passwords and sessions. Run with: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/index.js";
import * as auth from "../src/auth.js";

test("passwords are hashed and verified", async () => {
  const hash = await auth.hashPassword("boardroom");
  assert.ok(hash.startsWith("scrypt$") && !hash.includes("boardroom"));
  assert.equal(await auth.verifyPassword("boardroom", hash), true);
  assert.equal(await auth.verifyPassword("Boardroom", hash), false);
  assert.notEqual(hash, await auth.hashPassword("boardroom")); // random salt each time
});

test("login: right password, wrong password, unknown user, case-insensitive username", async () => {
  const db = openDatabase(":memory:");
  await auth.createAccount(db, "sam", "boardroom");
  assert.equal((await auth.checkLogin(db, "sam", "boardroom"))?.username, "sam");
  assert.equal((await auth.checkLogin(db, "SAM", "boardroom"))?.username, "sam");
  assert.equal(await auth.checkLogin(db, "sam", "wrong-password"), null);
  assert.equal(await auth.checkLogin(db, "nobody", "boardroom"), null);
});

test("sessions: valid token works, logout and expiry end it", async () => {
  const db = openDatabase(":memory:");
  const a = await auth.createAccount(db, "sam", "boardroom");
  const token = auth.createSession(db, a.id);
  assert.equal(auth.getSessionAccount(db, token)?.id, a.id);
  assert.equal(auth.getSessionAccount(db, "made-up-token"), null);
  // the raw token is never stored
  assert.equal(db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(token), undefined);
  auth.deleteSession(db, token);
  assert.equal(auth.getSessionAccount(db, token), null);

  const old = auth.createSession(db, a.id);
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal(auth.getSessionAccount(db, old), null);
});

test("resetting a password signs that account out everywhere", async () => {
  const db = openDatabase(":memory:");
  const a = await auth.createAccount(db, "sam", "boardroom");
  const token = auth.createSession(db, a.id);
  await auth.setPassword(db, a.id, "new-password");
  assert.equal(auth.getSessionAccount(db, token), null);
  assert.ok(await auth.checkLogin(db, "sam", "new-password"));
  assert.equal(await auth.checkLogin(db, "sam", "boardroom"), null);
});

test("deleting an account removes its sessions", async () => {
  const db = openDatabase(":memory:");
  const a = await auth.createAccount(db, "guest", "boardroom");
  const token = auth.createSession(db, a.id);
  assert.equal(auth.deleteAccount(db, a.id), true);
  assert.equal(auth.getSessionAccount(db, token), null);
});

test("usernames are unique regardless of case", async () => {
  const db = openDatabase(":memory:");
  await auth.createAccount(db, "Marc", "boardroom");
  await assert.rejects(auth.createAccount(db, "marc", "boardroom"));
});

test("new-account validation", () => {
  assert.equal(auth.validateNewAccount("sam", "boardroom"), null);
  assert.match(auth.validateNewAccount("s", "boardroom")!, /Username/);
  assert.match(auth.validateNewAccount("bad name!", "boardroom")!, /Username/);
  assert.match(auth.validateNewAccount("sam", "short")!, /at least 8/);
});

test("initial accounts are imported once, then the file is deleted", async () => {
  const db = openDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "gn-"));
  const file = join(dir, "initial-accounts.json");
  writeFileSync(file, JSON.stringify([
    { username: "matthan", password: "secret-1", isAdmin: true },
    { username: "sam", password: "boardroom" },
  ]));
  await auth.importInitialAccounts(db, file);
  assert.equal(existsSync(file), false);
  const accounts = auth.listAccounts(db);
  assert.deepEqual(accounts.map((a) => [a.username, a.isAdmin]), [["matthan", true], ["sam", false]]);
  assert.ok(await auth.checkLogin(db, "matthan", "secret-1"));
});

test("repeated failed logins are locked out for a while", () => {
  const key = "1.2.3.4|someone";
  for (let i = 0; i < 4; i++) auth.recordFailure(key);
  assert.equal(auth.isLockedOut(key), false);
  auth.recordFailure(key);
  assert.equal(auth.isLockedOut(key), true);
  auth.clearFailures(key);
  assert.equal(auth.isLockedOut(key), false);
});
