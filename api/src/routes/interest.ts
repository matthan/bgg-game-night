import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as repo from "../db/repo.js";

/**
 * Your interest in a game. Anyone signed in can set their OWN interest;
 * everyone can see everyone's (it comes with the game list).
 *   PUT    /api/interest/:gameId { level: -2..2 } -> set it
 *   DELETE /api/interest/:gameId                  -> back to "no opinion"
 * Both answer with everyone's interest in that game.
 */
export function interestRouter({ db }: { db: DatabaseSync }) {
  const router = Router();

  router.put("/:gameId", (req, res) => {
    const level = req.body?.level;
    if (!repo.isInterestLevel(level)) {
      return res.status(400).json({ error: "level must be 2, 1, 0, -1 or -2." });
    }
    save(Number(req.params.gameId), level, req, res);
  });
  router.delete("/:gameId", (req, res) => save(Number(req.params.gameId), null, req, res));

  function save(
    gameId: number,
    level: repo.InterestLevel | null,
    req: import("express").Request,
    res: import("express").Response,
  ) {
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: "Invalid game id." });
    if (!repo.setInterest(db, req.account!.id, gameId, level)) {
      return res.status(404).json({ error: "No game with that id." });
    }
    res.json(repo.getInterest(db, [gameId]).get(gameId) ?? []);
  }

  return router;
}
