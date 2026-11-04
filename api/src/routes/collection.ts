import { Router, type Request, type Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { BggError } from "../bgg/client.js";
import type { Catalog } from "../catalog.js";
import * as repo from "../db/repo.js";
import type { SyncService } from "../sync.js";
import type { CollectionResponse } from "../types.js";

interface Options {
  db: DatabaseSync;
  sync: SyncService;
  catalog: Catalog;
  useMock: boolean;
  refreshMinutes: number; // older than this → refresh in the background
}

const VALID_USERNAME = /^[\w .-]{1,50}$/;

const MAX_NAMES_PER_REQUEST = 25; // the page sends long lists in chunks

/** Members can add games to their own collection; the admin to anyone's. */
const canEdit = (req: Request, username: string) =>
  !!req.account && (req.account.isAdmin || repo.userKey(req.account.username) === repo.userKey(username));

export function collectionRouter({ db, sync, catalog, useMock, refreshMinutes }: Options) {
  const router = Router();

  function buildResponse(username: string): CollectionResponse {
    const user = repo.getUser(db, username)!;
    return {
      username: user.username,
      source: useMock ? "mock" : "bgg",
      lastSyncedAt: user.last_synced_at,
      lastSyncError: user.last_sync_error,
      syncing: sync.isSyncing(username),
      kind: user.source,
      manualGameIds: repo.manualGameIds(db, username),
      games: repo.getCollection(db, username),
    };
  }

  function sendError(res: Response, username: string, err: unknown) {
    const status = err instanceof BggError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error(`[collection] ${username}:`, message);
    res.status(status).json({ error: message });
  }

  /**
   * GET /api/collection/:username — answered from the database.
   * - never synced: sync now (first load waits for BGG)
   * - synced but stale: answer immediately, refresh in the background
   */
  router.get("/:username", async (req, res) => {
    const username = req.params.username.trim();
    if (!VALID_USERNAME.test(username)) {
      return res.status(400).json({ error: "That doesn't look like a valid BGG username." });
    }

    const user = repo.getUser(db, username);
    if (user?.source === "manual") {
      repo.ensureManualUser(db, username); // nothing to sync; just show it again if hidden
    } else if (!user?.last_synced_at) {
      try {
        await sync.syncCollection(username);
      } catch (err) {
        return sendError(res, username, err);
      }
    } else {
      repo.ensureUser(db, username); // asking for it again shows a hidden user
      const ageMinutes = (Date.now() - Date.parse(user.last_synced_at)) / 60_000;
      if (ageMinutes > refreshMinutes) {
        sync.syncCollection(username).catch(() => {}); // errors are logged + stored by the sync
      }
    }
    res.json(buildResponse(username));
  });

  /** POST /api/collection/:username/sync — refresh from BGG now, then return it. */
  router.post("/:username/sync", async (req, res) => {
    const username = req.params.username.trim();
    if (!VALID_USERNAME.test(username)) {
      return res.status(400).json({ error: "That doesn't look like a valid BGG username." });
    }
    if (repo.getUser(db, username)?.source === "manual") {
      return res.json(buildResponse(username)); // games added by hand: nothing to sync
    }
    try {
      await sync.syncCollection(username);
      res.json(buildResponse(username));
    } catch (err) {
      sendError(res, username, err);
    }
  });

  /**
   * POST /api/collection/:username/games — add games by hand.
   * Body: { ids: [162886, ...] } (from search) or { names: ["Spirit Island", ...] } (bulk).
   * Creates a collection for that name if there isn't one yet.
   */
  router.post("/:username/games", async (req, res) => {
    const username = req.params.username.trim();
    if (!VALID_USERNAME.test(username)) return res.status(400).json({ error: "That isn't a valid collection name." });
    if (!canEdit(req, username)) return res.status(403).json({ error: "You can only add games to your own collection." });

    const { ids, names } = req.body ?? {};
    try {
      if (Array.isArray(ids) && ids.length && ids.every((id) => Number.isInteger(id) && id > 0)) {
        const result = await catalog.addByIds(username, ids.slice(0, 50));
        return res.json({ ...result, matched: [], collection: buildResponse(username) });
      }
      if (Array.isArray(names) && names.length && names.every((n) => typeof n === "string")) {
        if (names.length > MAX_NAMES_PER_REQUEST) {
          return res.status(400).json({ error: `At most ${MAX_NAMES_PER_REQUEST} names at a time.` });
        }
        const result = await catalog.addByNames(username, names.map((n: string) => n.slice(0, 200)));
        return res.json({ ...result, collection: buildResponse(username) });
      }
      res.status(400).json({ error: "Send { ids: [...] } or { names: [...] }." });
    } catch (err) {
      sendError(res, username, err);
    }
  });

  /** DELETE /api/collection/:username/games/:id — remove a game that was added by hand. */
  router.delete("/:username/games/:id", (req, res) => {
    const username = req.params.username.trim();
    if (!canEdit(req, username)) return res.status(403).json({ error: "You can only change your own collection." });
    if (!repo.removeManualGame(db, username, Number(req.params.id))) {
      return res.status(404).json({ error: "That game wasn't added by hand to this collection." });
    }
    res.json(buildResponse(username));
  });

  return router;
}
