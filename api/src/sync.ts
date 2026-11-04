import type { DatabaseSync } from "node:sqlite";
import { BggError, fetchCollection } from "./bgg/client.js";
import { fetchDetails } from "./bgg/details.js";
import { fetchMockCollection, fetchMockDetails } from "./bgg/mock.js";
import * as repo from "./db/repo.js";

export interface SyncOptions {
  db: DatabaseSync;
  token: string;
  useMock: boolean;
  detailsMaxAgeDays: number; // re-fetch a game's weight/poll after this many days
}

export type SyncResult = ReturnType<typeof repo.saveCollection> & { detailsFetched: number };

/**
 * Keeps the database in step with BGG.
 *
 * syncCollection(username):
 *   1. fetch the collection from BGG (or the mock file)
 *   2. save it: new games added, removed games marked, ratings/plays updated
 *   3. fetch /thing details ONLY for games that are new or have old details
 *
 * If a sync for the same user is already running, callers share it instead
 * of starting a second one.
 */
export function createSyncService(opts: SyncOptions) {
  const { db } = opts;
  const running = new Map<string, Promise<SyncResult>>();

  async function run(username: string): Promise<SyncResult> {
    if (repo.getUser(db, username)?.source === "manual") {
      throw new BggError(`${username}'s games are added by hand, so there's nothing to sync from BGG.`, 400);
    }
    const neverSynced = !repo.getUser(db, username)?.last_synced_at;
    repo.ensureUser(db, username);

    let games;
    try {
      games = opts.useMock ? await fetchMockCollection(username) : await fetchCollection(username, opts.token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A brand-new user that fails (e.g. a typo) shouldn't stay on the list.
      if (neverSynced) repo.deleteUser(db, username);
      else repo.recordSync(db, username, message);
      throw err;
    }

    const result = repo.saveCollection(db, username, games);

    // Details (weight + player-count poll) only for games that need them.
    const needed = repo.gamesNeedingDetails(db, games.map((g) => g.id), opts.detailsMaxAgeDays);
    let detailsError: string | null = null;
    if (needed.length) {
      try {
        const details = opts.useMock ? await fetchMockDetails(needed) : await fetchDetails(needed, opts.token);
        repo.saveDetails(db, details);
      } catch (err) {
        // Keep the collection; the details will be retried on the next sync.
        detailsError = `details: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[sync] ${username}:`, detailsError);
      }
    }

    repo.recordSync(db, username, detailsError);
    console.log(
      `[sync] ${username}: ${result.total} games (${result.added.length} new, ${result.removed} removed), ` +
        `details fetched for ${needed.length}`,
    );
    return { ...result, detailsFetched: needed.length };
  }

  function syncCollection(username: string): Promise<SyncResult> {
    const key = repo.userKey(username);
    let job = running.get(key);
    if (!job) {
      job = run(username).finally(() => running.delete(key));
      running.set(key, job);
    }
    return job;
  }

  /** Sync every user shown on the page, one at a time (used by the nightly job). */
  async function syncAll() {
    for (const u of repo.listUsers(db).filter((u) => u.source === "bgg")) {
      try {
        await syncCollection(u.username);
      } catch (err) {
        console.error(`[sync] ${u.username} failed:`, err instanceof Error ? err.message : err);
      }
      await new Promise((r) => setTimeout(r, 5000)); // spread requests out for BGG
    }
  }

  return {
    syncCollection,
    syncAll,
    isSyncing: (username: string) => running.has(repo.userKey(username)),
  };
}

export type SyncService = ReturnType<typeof createSyncService>;

/** Run syncAll() every day at `hour` (container local time; set TZ to control it). */
export function scheduleNightlySync(sync: SyncService, hour: number) {
  const scheduleNext = () => {
    const next = new Date();
    next.setHours(hour, 0, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    console.log(`[sync] next nightly sync at ${next.toString()}`);
    setTimeout(async () => {
      await sync.syncAll();
      scheduleNext();
    }, next.getTime() - Date.now());
  };
  scheduleNext();
}
