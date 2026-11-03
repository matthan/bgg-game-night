import { Router, type Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { BggError } from "../bgg/client.js";
import * as repo from "../db/repo.js";
import type { SyncService } from "../sync.js";
import type { CollectionResponse } from "../types.js";

interface Options {
  db: DatabaseSync;
  sync: SyncService;
  useMock: boolean;
  refreshMinutes: number; // older than this → refresh in the background
}

const VALID_USERNAME = /^[\w .-]{1,50}$/;

export function collectionRouter({ db, sync, useMock, refreshMinutes }: Options) {
  const router = Router();

  function buildResponse(username: string): CollectionResponse {
    const user = repo.getUser(db, username)!;
    return {
      username: user.username,
      source: useMock ? "mock" : "bgg",
      lastSyncedAt: user.last_synced_at,
      lastSyncError: user.last_sync_error,
      syncing: sync.isSyncing(username),
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
    if (!user?.last_synced_at) {
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
    try {
      await sync.syncCollection(username);
      res.json(buildResponse(username));
    } catch (err) {
      sendError(res, username, err);
    }
  });

  return router;
}
