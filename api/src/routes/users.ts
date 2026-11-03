import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as repo from "../db/repo.js";

/** Saved collections, so the page can remember which ones to show. */
export function usersRouter({ db }: { db: DatabaseSync }) {
  const router = Router();

  // GET /api/users -> [{ username, addedAt, lastSyncedAt, lastSyncError, gameCount }]
  router.get("/", (_req, res) => {
    res.json(repo.listUsers(db));
  });

  // DELETE /api/users/:username -> hides it from the page; its data stays in the database
  router.delete("/:username", (req, res) => {
    if (repo.hideUser(db, req.params.username)) res.status(204).end();
    else res.status(404).json({ error: "No saved collection with that username." });
  });

  return router;
}
