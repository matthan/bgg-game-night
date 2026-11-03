import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";

/**
 * Login accounts for the app itself (not BGG usernames).
 *
 * - Passwords are stored as scrypt hashes, never as plain text.
 * - Logging in creates a random session token. The browser keeps it in an
 *   HttpOnly cookie (page JavaScript can't read it); the database stores only
 *   a SHA-256 hash of it, so a copied database can't be used to log in.
 */

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 30;
export const COOKIE_NAME = "gn_session";

export interface Account {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const now = () => new Date().toISOString();
const toAccount = (r: any): Account => ({
  id: Number(r.id),
  username: r.username,
  isAdmin: Number(r.is_admin) === 1,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at ?? null,
});
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- passwords ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected); // constant-time comparison
}

// ---------- accounts ----------

export const USERNAME_RULE = /^[a-zA-Z0-9_.-]{2,32}$/;
export const MIN_PASSWORD_LENGTH = 8;

export function validateNewAccount(username: unknown, password: unknown): string | null {
  if (typeof username !== "string" || !USERNAME_RULE.test(username)) {
    return "Username must be 2–32 characters: letters, numbers, dot, dash or underscore.";
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export async function createAccount(db: DatabaseSync, username: string, password: string, isAdmin = false) {
  const row = db
    .prepare(
      `INSERT INTO accounts (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .get(username.trim(), await hashPassword(password), isAdmin ? 1 : 0, now());
  return toAccount(row);
}

export const listAccounts = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM accounts ORDER BY created_at, id").all().map(toAccount);

export const getAccount = (db: DatabaseSync, id: number) => {
  const r = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return r ? toAccount(r) : undefined;
};

export const findAccountByUsername = (db: DatabaseSync, username: string) =>
  db.prepare("SELECT * FROM accounts WHERE username = ? COLLATE NOCASE").get(username.trim()) as any;

export async function setPassword(db: DatabaseSync, id: number, password: string) {
  db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(await hashPassword(password), id);
  db.prepare("DELETE FROM sessions WHERE account_id = ?").run(id); // sign out everywhere
}

export function deleteAccount(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes) > 0; // sessions cascade
}

/** Returns the account if the username + password are right, otherwise null. */
export async function checkLogin(db: DatabaseSync, username: string, password: string): Promise<Account | null> {
  const row = findAccountByUsername(db, username);
  // Still do the (slow) hash work for unknown usernames, so timing doesn't reveal which exist.
  const ok = await verifyPassword(password, row?.password_hash ?? `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`);
  if (!row || !ok) return null;
  db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(now(), row.id);
  return toAccount(row);
}

// ---------- sessions ----------

export function createSession(db: DatabaseSync, accountId: number): string {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    accountId,
    now(),
    expires,
  );
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now()); // tidy up old ones
  return token;
}

export function getSessionAccount(db: DatabaseSync, token: string | undefined): Account | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), now());
  return row ? toAccount(row) : null;
}

export function deleteSession(db: DatabaseSync, token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

// ---------- cookies ----------

export function readSessionCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean) {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly", // not readable by page JavaScript
    "SameSite=Lax", // not sent on requests from other sites
    `Max-Age=${SESSION_DAYS * 86_400}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export const clearedSessionCookie = `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// ---------- middleware ----------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: Account; // set by requireLogin
    }
  }
}

/** Blocks the request with 401 unless it carries a valid session cookie. */
export function requireLogin(db: DatabaseSync) {
  return (req: Request, res: Response, next: NextFunction) => {
    const account = getSessionAccount(db, readSessionCookie(req));
    if (!account) return res.status(401).json({ error: "Please sign in." });
    req.account = account;
    next();
  };
}

/** Use after requireLogin: only admin accounts (matthan) may continue. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.account?.isAdmin) return res.status(403).json({ error: "Only an admin can do that." });
  next();
}

// ---------- slow down password guessing ----------

const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

/** true if this ip+username has failed too often in the last 15 minutes. */
export function isLockedOut(key: string) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) return false;
  return f.count >= MAX_FAILURES;
}
export function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}
export const clearFailures = (key: string) => failures.delete(key);

// ---------- first-run accounts ----------

/**
 * One-time import: if data/initial-accounts.json exists, create those accounts
 * (passwords get hashed) and then DELETE the file so the plain-text passwords
 * don't stay on disk. Format: [{ "username": "...", "password": "...", "isAdmin": true }]
 */
export async function importInitialAccounts(db: DatabaseSync, file: string) {
  const { existsSync, readFileSync, unlinkSync } = await import("node:fs");
  if (!existsSync(file)) return;
  const list = JSON.parse(readFileSync(file, "utf8")) as { username: string; password: string; isAdmin?: boolean }[];
  for (const a of list) {
    if (findAccountByUsername(db, a.username)) {
      console.log(`[auth] account "${a.username}" already exists, skipped`);
      continue;
    }
    await createAccount(db, a.username, a.password, !!a.isAdmin);
    console.log(`[auth] created account "${a.username}"${a.isAdmin ? " (admin)" : ""}`);
  }
  unlinkSync(file);
  console.log(`[auth] imported ${list.length} accounts and deleted ${file}`);
}
