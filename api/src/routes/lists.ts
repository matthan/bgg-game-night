import { Router, type Request, type Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireAdmin } from "../auth.js";
import * as repo from "../db/repo.js";

const MAX_GAMES = 50;

/**
 * The shared game list: an admin builds it from filters, everyone sees it.
 *   GET  /api/lists/current          -> the current list (or null)     [anyone signed in]
 *   POST /api/lists { filters, gameIds } -> make a new current list    [admin]
 *   PUT  /api/lists/current/games { gameIds } -> change its games      [admin]
 *   PUT  /api/lists/current/games/:id/vote    -> vote for a game        [anyone signed in]
 *   DELETE /api/lists/current/games/:id/vote  -> take your vote back    [anyone signed in]
 */
export function listsRouter({ db }: { db: DatabaseSync }) {
  const router = Router();

  function sendCurrent(res: Response) {
    const list = repo.getCurrentList(db);
    if (!list) return res.json(null);
    const votes = repo.getListVotes(db, list.id);
    res.json({
      id: list.id,
      filters: list.filters,
      createdBy: list.createdBy,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
      games: repo.getGamesByIds(db, list.gameIds).map((g) => ({ ...g, votes: votes.get(g.id) ?? [] })),
    });
  }

  /** Check the posted game ids: a list of real games, no duplicates, not too many. */
  function readGameIds(req: Request, res: Response): number[] | null {
    const ids = req.body?.gameIds;
    if (!Array.isArray(ids) || ids.length > MAX_GAMES || !ids.every((id) => Number.isInteger(id))) {
      res.status(400).json({ error: `gameIds must be a list of up to ${MAX_GAMES} game ids.` });
      return null;
    }
    const unique = [...new Set(ids as number[])];
    const known = repo.existingGameIds(db, unique);
    const missing = unique.filter((id) => !known.has(id));
    if (missing.length) {
      res.status(400).json({ error: `Unknown game id(s): ${missing.join(", ")}` });
      return null;
    }
    return unique;
  }

  router.get("/current", (_req, res) => sendCurrent(res));

  router.post("/", requireAdmin, (req, res) => {
    const filters = req.body?.filters;
    if (typeof filters !== "object" || filters === null || JSON.stringify(filters).length > 2000) {
      return res.status(400).json({ error: "filters must be a small JSON object." });
    }
    const ids = readGameIds(req, res);
    if (!ids) return;
    repo.createList(db, filters, ids, req.account!.id);
    res.status(201);
    sendCurrent(res);
  });

  router.put("/current/games", requireAdmin, (req, res) => {
    const ids = readGameIds(req, res);
    if (!ids) return;
    if (!repo.updateCurrentListGames(db, ids)) return res.status(404).json({ error: "There's no game list yet." });
    sendCurrent(res);
  });

  // Votes: one per account per game; anyone signed in can vote for any number of games.
  router.put("/current/games/:id/vote", (req, res) => vote(req, res, true));
  router.delete("/current/games/:id/vote", (req, res) => vote(req, res, false));

  function vote(req: Request, res: Response, voted: boolean) {
    const gameId = Number(req.params.id);
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: "Invalid game id." });
    if (!repo.setVote(db, req.account!.id, gameId, voted)) {
      return res.status(404).json({ error: "That game isn't in the current game list." });
    }
    sendCurrent(res);
  }

  return router;
}
