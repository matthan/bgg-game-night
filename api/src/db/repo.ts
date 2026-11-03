import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./index.js";
import { classifyPlayerVotes, type GameDetails, type PlayerVotes } from "../bgg/details.js";
import type { Game } from "../types.js";

/**
 * All SQL lives here. Routes and the sync service call these functions
 * instead of writing queries themselves ("repository" pattern), so the
 * database could be swapped later without touching the rest of the API.
 */

export interface UserRow {
  username_key: string;
  username: string;
  visible: number;
  added_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
}

export const userKey = (username: string) => username.trim().toLowerCase();
const now = () => new Date().toISOString();

// ---------- users ----------

/** Add a user, or show a hidden one again. Keeps the latest spelling for display. */
export function ensureUser(db: DatabaseSync, username: string): UserRow {
  db.prepare(
    `INSERT INTO users (username_key, username, visible, added_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (username_key) DO UPDATE SET username = excluded.username, visible = 1`,
  ).run(userKey(username), username.trim(), now());
  return getUser(db, username)!;
}

export function getUser(db: DatabaseSync, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username_key = ?").get(userKey(username)) as UserRow | undefined;
}

/** Users shown on the page, oldest first, with how many games they own. */
export function listUsers(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT u.username, u.added_at, u.last_synced_at, u.last_sync_error,
              (SELECT COUNT(*) FROM collection_items c
                WHERE c.username_key = u.username_key AND c.removed_at IS NULL) AS game_count
         FROM users u WHERE u.visible = 1 ORDER BY u.added_at`,
    )
    .all()
    .map((r: any) => ({
      username: r.username as string,
      addedAt: r.added_at as string,
      lastSyncedAt: r.last_synced_at as string | null,
      lastSyncError: r.last_sync_error as string | null,
      gameCount: Number(r.game_count),
    }));
}

/** Remove from the page but keep the data (adding the user again brings it back). */
export function hideUser(db: DatabaseSync, username: string): boolean {
  return Number(db.prepare("UPDATE users SET visible = 0 WHERE username_key = ?").run(userKey(username)).changes) > 0;
}

/** Fully delete a user that never synced (e.g. a mistyped username). */
export function deleteUser(db: DatabaseSync, username: string) {
  db.prepare("DELETE FROM users WHERE username_key = ?").run(userKey(username));
}

export function recordSync(db: DatabaseSync, username: string, error: string | null) {
  if (error === null || error.startsWith("details:")) {
    // collection synced (details may have partly failed)
    db.prepare("UPDATE users SET last_synced_at = ?, last_sync_error = ? WHERE username_key = ?").run(
      now(),
      error,
      userKey(username),
    );
  } else {
    db.prepare("UPDATE users SET last_sync_error = ? WHERE username_key = ?").run(error, userKey(username));
  }
}

// ---------- collections ----------

/**
 * Save a freshly fetched collection:
 * - insert or update each game's basic info (shared `games` table)
 * - new games in the collection get added_at = now
 * - games that came back again get their rating/plays updated (and un-removed)
 * - games that are no longer in the collection get removed_at = now
 */
export function saveCollection(db: DatabaseSync, username: string, games: Game[]) {
  const key = userKey(username);
  const ts = now();

  return transaction(db, () => {
    const upsertGame = db.prepare(
      `INSERT INTO games (id, name, year_published, thumbnail, image, min_players, max_players,
                          playing_time, min_play_time, max_play_time, bgg_rating, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, year_published = excluded.year_published,
         thumbnail = excluded.thumbnail, image = excluded.image,
         min_players = excluded.min_players, max_players = excluded.max_players,
         playing_time = excluded.playing_time, min_play_time = excluded.min_play_time,
         max_play_time = excluded.max_play_time, bgg_rating = excluded.bgg_rating,
         updated_at = excluded.updated_at`,
    );
    const existing = new Set(
      db
        .prepare("SELECT game_id FROM collection_items WHERE username_key = ? AND removed_at IS NULL")
        .all(key)
        .map((r) => Number(r.game_id)),
    );
    const upsertItem = db.prepare(
      `INSERT INTO collection_items (username_key, game_id, my_rating, num_plays, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (username_key, game_id) DO UPDATE SET
         my_rating = excluded.my_rating, num_plays = excluded.num_plays,
         removed_at = NULL, updated_at = excluded.updated_at`,
    );

    const seen = new Set<number>();
    for (const g of games) {
      if (seen.has(g.id)) continue; // BGG lists a game twice if you own two copies
      seen.add(g.id);
      upsertGame.run(g.id, g.name, g.yearPublished, g.thumbnail, g.image, g.minPlayers, g.maxPlayers,
        g.playingTime, g.minPlayTime, g.maxPlayTime, g.bggRating, ts);
      upsertItem.run(key, g.id, g.myRating, g.numPlays, ts, ts);
    }

    const removed = db
      .prepare(
        `UPDATE collection_items SET removed_at = ?, updated_at = ?
          WHERE username_key = ? AND removed_at IS NULL
            AND game_id NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(ts, ts, key, JSON.stringify([...seen]));

    return {
      total: seen.size,
      added: [...seen].filter((id) => !existing.has(id)),
      removed: Number(removed.changes),
    };
  });
}

/** Which of these games have no details yet, or details older than `maxAgeDays`. */
export function gamesNeedingDetails(db: DatabaseSync, ids: number[], maxAgeDays: number): number[] {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT id FROM games WHERE id IN (SELECT value FROM json_each(?))
         AND (details_synced_at IS NULL OR details_synced_at < ?)`,
    )
    .all(JSON.stringify(ids), cutoff)
    .map((r) => Number(r.id));
}

/** Store weight + poll votes from BGG's /thing endpoint. */
export function saveDetails(db: DatabaseSync, details: Map<number, GameDetails>) {
  const ts = now();
  transaction(db, () => {
    const setGame = db.prepare("UPDATE games SET weight = ?, details_synced_at = ? WHERE id = ?");
    const clearVotes = db.prepare("DELETE FROM game_player_counts WHERE game_id = ?");
    const addVotes = db.prepare(
      `INSERT INTO game_player_counts (game_id, players, best_votes, recommended_votes, not_recommended_votes)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [id, d] of details) {
      setGame.run(d.weight, ts, id);
      clearVotes.run(id);
      for (const v of d.playerVotes) addVotes.run(id, v.players, v.best, v.recommended, v.notRecommended);
    }
  });
}

/** A user's current collection (removed games excluded), in the API's Game shape. */
export function getCollection(db: DatabaseSync, username: string): Game[] {
  const key = userKey(username);
  const rows = db
    .prepare(
      `SELECT g.*, c.my_rating, c.num_plays, n.hidden_at
         FROM collection_items c JOIN games g ON g.id = c.game_id
         LEFT JOIN game_notes n ON n.game_id = g.id
        WHERE c.username_key = ? AND c.removed_at IS NULL
        ORDER BY g.name COLLATE NOCASE`,
    )
    .all(key) as any[];

  // One query for every owned game's poll votes, grouped by game in JS.
  const votesByGame = groupVotes(
    db
      .prepare(
        `SELECT p.* FROM game_player_counts p
           JOIN collection_items c ON c.game_id = p.game_id
          WHERE c.username_key = ? AND c.removed_at IS NULL`,
      )
      .all(key) as any[],
  );

  return rows.map((r) => toGame(r, votesByGame.get(Number(r.id)) ?? []));
}

/** A database row (games + optional my_rating/num_plays/hidden_at) in the API's Game shape. */
function toGame(r: any, votes: PlayerVotes[]): Game {
  return {
    id: Number(r.id),
    name: r.name,
    yearPublished: r.year_published,
    thumbnail: r.thumbnail,
    image: r.image,
    minPlayers: r.min_players,
    maxPlayers: r.max_players,
    playingTime: r.playing_time,
    minPlayTime: r.min_play_time,
    maxPlayTime: r.max_play_time,
    myRating: r.my_rating,
    bggRating: r.bgg_rating,
    numPlays: Number(r.num_plays ?? 0),
    weight: r.weight,
    ...classifyPlayerVotes(votes),
    hidden: r.hidden_at != null,
  };
}

/** Group poll-vote rows by game id. */
function groupVotes(rows: any[]) {
  const byGame = new Map<number, PlayerVotes[]>();
  for (const v of rows) {
    const list = byGame.get(Number(v.game_id)) ?? [];
    list.push({
      players: Number(v.players),
      best: Number(v.best_votes),
      recommended: Number(v.recommended_votes),
      notRecommended: Number(v.not_recommended_votes),
    });
    byGame.set(Number(v.game_id), list);
  }
  return byGame;
}

/**
 * Specific games by id, in the order given, plus who owns each one (among the
 * collections shown on the page). Plays are totalled across owners.
 */
export function getGamesByIds(db: DatabaseSync, ids: number[]): (Game & { owners: string[] })[] {
  const json = JSON.stringify(ids);
  const rows = db
    .prepare(
      `SELECT g.*, n.hidden_at,
              (SELECT COALESCE(SUM(c.num_plays), 0) FROM collection_items c
                WHERE c.game_id = g.id AND c.removed_at IS NULL) AS num_plays
         FROM games g LEFT JOIN game_notes n ON n.game_id = g.id
        WHERE g.id IN (SELECT value FROM json_each(?))`,
    )
    .all(json) as any[];
  const votes = groupVotes(
    db.prepare("SELECT * FROM game_player_counts WHERE game_id IN (SELECT value FROM json_each(?))").all(json) as any[],
  );
  const owners = new Map<number, string[]>();
  for (const o of db
    .prepare(
      `SELECT c.game_id, u.username FROM collection_items c JOIN users u ON u.username_key = c.username_key
        WHERE c.removed_at IS NULL AND u.visible = 1 AND c.game_id IN (SELECT value FROM json_each(?))
        ORDER BY u.added_at`,
    )
    .all(json) as any[]) {
    owners.set(Number(o.game_id), [...(owners.get(Number(o.game_id)) ?? []), o.username]);
  }
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => ({ ...toGame(byId.get(id), votes.get(id) ?? []), myRating: null, owners: owners.get(id) ?? [] }));
}

/** Which of these ids are real games in the database. */
export function existingGameIds(db: DatabaseSync, ids: number[]): Set<number> {
  return new Set(
    db
      .prepare("SELECT id FROM games WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids))
      .map((r) => Number(r.id)),
  );
}

// ---------- shared game lists ----------

export interface GameListRow {
  id: number;
  filters: unknown;
  gameIds: number[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The newest game list (the one everyone sees), or null if none was made yet. */
export function getCurrentList(db: DatabaseSync): GameListRow | null {
  const r = db
    .prepare(
      `SELECT l.*, a.username AS created_by_name FROM game_lists l
         LEFT JOIN accounts a ON a.id = l.created_by
        ORDER BY l.id DESC LIMIT 1`,
    )
    .get() as any;
  if (!r) return null;
  return {
    id: Number(r.id),
    filters: JSON.parse(r.filters),
    gameIds: JSON.parse(r.game_ids),
    createdBy: r.created_by_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createList(db: DatabaseSync, filters: unknown, gameIds: number[], accountId: number) {
  const ts = now();
  db.prepare(
    "INSERT INTO game_lists (filters, game_ids, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(JSON.stringify(filters), JSON.stringify(gameIds), accountId, ts, ts);
}

/** Change which games are in the current list (e.g. swap out a hidden one). */
export function updateCurrentListGames(db: DatabaseSync, gameIds: number[]): boolean {
  const current = getCurrentList(db);
  if (!current) return false;
  db.prepare("UPDATE game_lists SET game_ids = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(gameIds),
    now(),
    current.id,
  );
  return true;
}

// ---------- your own per-game settings (game_notes) ----------

/** Hide or show a game in the results. Returns false if the game isn't in the database. */
export function setGameHidden(db: DatabaseSync, gameId: number, hidden: boolean): boolean {
  if (!db.prepare("SELECT 1 FROM games WHERE id = ?").get(gameId)) return false;
  const ts = now();
  db.prepare(
    `INSERT INTO game_notes (game_id, hidden_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (game_id) DO UPDATE SET hidden_at = excluded.hidden_at, updated_at = excluded.updated_at`,
  ).run(gameId, hidden ? ts : null, ts);
  return true;
}

export function listHiddenGames(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT g.id, g.name, n.hidden_at FROM game_notes n JOIN games g ON g.id = n.game_id
        WHERE n.hidden_at IS NOT NULL ORDER BY g.name COLLATE NOCASE`,
    )
    .all()
    .map((r: any) => ({ id: Number(r.id), name: r.name as string, hiddenAt: r.hidden_at as string }));
}
