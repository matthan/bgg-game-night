import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as auth from "../auth.js";

/**
 * Manage login accounts. Mounted behind requireLogin + requireAdmin,
 * so only an admin (matthan) can reach these.
 */
export function accountsRouter({ db }: { db: DatabaseSync }) {
  const router = Router();

  // GET /api/accounts -> every account (no password hashes, of course)
  router.get("/", (_req, res) => {
    res.json(auth.listAccounts(db));
  });

  // POST /api/accounts { username, password } -> new (non-admin) account
  router.post("/", async (req, res) => {
    const { username, password } = req.body ?? {};
    const problem = auth.validateNewAccount(username, password);
    if (problem) return res.status(400).json({ error: problem });
    if (auth.findAccountByUsername(db, username)) {
      return res.status(409).json({ error: `There's already an account called "${username}".` });
    }
    res.status(201).json(await auth.createAccount(db, username, password));
  });

  // PUT /api/accounts/:id/password { password } -> reset someone's password
  router.put("/:id/password", async (req, res) => {
    const id = Number(req.params.id);
    if (!auth.getAccount(db, id)) return res.status(404).json({ error: "No such account." });
    const { password } = req.body ?? {};
    if (typeof password !== "string" || password.length < auth.MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${auth.MIN_PASSWORD_LENGTH} characters.` });
    }
    await auth.setPassword(db, id, password); // also signs that account out everywhere
    res.status(204).end();
  });

  // DELETE /api/accounts/:id
  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (id === req.account!.id) return res.status(400).json({ error: "You can't delete your own account." });
    if (auth.getAccount(db, id)?.isAdmin) return res.status(400).json({ error: "Admin accounts can't be deleted here." });
    if (!auth.deleteAccount(db, id)) return res.status(404).json({ error: "No such account." });
    res.status(204).end();
  });

  return router;
}
