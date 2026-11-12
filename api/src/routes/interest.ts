import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import * as repo from "../db/repo.js";

/**
 * Your interest in a game. Anyone signed in can set their OWN interest;
 * everyone can see everyone's (it comes with the game list).
 *   PUT    /api/interest/:gameId { level: 0..5 } -> set it
 *   DELETE /api/interest/:gameId                  -> back to "no opinion"
 * Both answer with everyone's interest in that game.
 *   GET    /api/interest -> { gameId: { average, count } } for every rated game
 *                           (used to favour well-liked games in new lists)
 *   GET    /api/interest/mine -> { gameId: level } for every game YOU rated
 *                                (the "Rate games" page)
 */
export function interestRouter({ db }: { db: DatabaseSync }) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(repo.interestSummary(db));
  });

  router.get("/mine", (req, res) => {
    res.json(repo.myInterest(db, req.account!.id));
  });

  router.put("/:gameId", (req, res) => {
    const level = req.body?.level;
    if (!repo.isInterestLevel(level)) {
      return res.status(400).json({ error: "level must be a whole number from 0 (rather not) to 5 (yes, please!)." });
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
