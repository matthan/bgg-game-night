import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as repo from "../db/repo.js";

/**
 * Per-game settings that are yours, not BGG's (stored in game_notes).
 * Hiding a game removes it from the results but keeps it in the database.
 */
export function gamesRouter({ db }: { db: DatabaseSync }) {
  const router = Router();

  // GET /api/games/hidden -> [{ id, name, hiddenAt }]
  router.get("/hidden", (_req, res) => {
    res.json(repo.listHiddenGames(db));
  });

  // PUT /api/games/:id/hidden -> hide;  DELETE /api/games/:id/hidden -> show again
  router.put("/:id/hidden", (req, res) => setHidden(Number(req.params.id), true, res));
  router.delete("/:id/hidden", (req, res) => setHidden(Number(req.params.id), false, res));

  function setHidden(id: number, hidden: boolean, res: import("express").Response) {
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid game id." });
    if (!repo.setGameHidden(db, id, hidden)) return res.status(404).json({ error: "No game with that id." });
    res.status(204).end();
  }

  return router;
}
