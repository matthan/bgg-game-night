import { Router, type Request } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as auth from "../auth.js";

/** Sign in / sign out / who am I. */
export function authRouter({ db, secureCookies }: { db: DatabaseSync; secureCookies: boolean }) {
  const router = Router();
  const lockKey = (req: Request, username: string) => `${req.ip}|${username.toLowerCase()}`;

  // POST /api/auth/login { username, password } -> sets the session cookie
  router.post("/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return res.status(400).json({ error: "Enter a username and password." });
    }
    const key = lockKey(req, username);
    if (auth.isLockedOut(key)) {
      return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
    }
    const account = await auth.checkLogin(db, username, password);
    if (!account) {
      auth.recordFailure(key);
      return res.status(401).json({ error: "Wrong username or password." });
    }
    auth.clearFailures(key);
    const token = auth.createSession(db, account.id);
    res.setHeader("Set-Cookie", auth.sessionCookie(token, secureCookies));
    res.json(account);
  });

  // POST /api/auth/logout -> ends this session
  router.post("/logout", (req, res) => {
    auth.deleteSession(db, auth.readSessionCookie(req));
    res.setHeader("Set-Cookie", auth.clearedSessionCookie);
    res.status(204).end();
  });

  // GET /api/auth/me -> the signed-in account, or 401
  router.get("/me", auth.requireLogin(db), (req, res) => {
    res.json(req.account);
  });

  return router;
}
