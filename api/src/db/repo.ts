import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./index.js";
import type { ThingInfo } from "../bgg/catalog.js";
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
  source: "bgg" | "manual";
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
      `SELECT u.username, u.source, u.added_at, u.last_synced_at, u.last_sync_error,
              (SELECT COUNT(*) FROM collection_items c
                WHERE c.username_key = u.username_key AND c.removed_at IS NULL) AS game_count
         FROM users u WHERE u.visible = 1 ORDER BY u.added_at`,
    )
    .all()
    .map((r: any) => ({
      username: r.username as string,
      source: r.source as "bgg" | "manual",
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
         removed_at = NULL, manual = 0, updated_at = excluded.updated_at`,
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
          WHERE username_key = ? AND removed_at IS NULL AND manual = 0
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

// ---------- games added by hand ----------

/** A collection for someone without a BGG account (or show it again). An existing BGG one is kept as is. */
export function ensureManualUser(db: DatabaseSync, username: string): UserRow {
  db.prepare(
    `INSERT INTO users (username_key, username, visible, added_at, source) VALUES (?, ?, 1, ?, 'manual')
     ON CONFLICT (username_key) DO UPDATE SET visible = 1`,
  ).run(userKey(username), username.trim(), now());
  return getUser(db, username)!;
}

/** Store full game info fetched from BGG's /thing (name, players, time, rating, weight, poll). */
export function saveThings(db: DatabaseSync, things: Iterable<ThingInfo>) {
  const ts = now();
  const list = [...things];
  transaction(db, () => {
    const upsert = db.prepare(
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
    for (const { game: g } of list) {
      upsert.run(g.id, g.name, g.yearPublished, g.thumbnail, g.image, g.minPlayers, g.maxPlayers,
        g.playingTime, g.minPlayTime, g.maxPlayTime, g.bggRating, ts);
    }
  });
  saveDetails(db, new Map(list.map((t) => [t.game.id, t.details])));
}

/**
 * Add games (already in the `games` table) to a collection by hand.
 * Returns which were added and which the collection already had.
 */
export function addManualGames(db: DatabaseSync, username: string, ids: number[]) {
  const key = userKey(username);
  const ts = now();
  return transaction(db, () => {
    const owned = new Set(
      db
        .prepare("SELECT game_id FROM collection_items WHERE username_key = ? AND removed_at IS NULL")
        .all(key)
        .map((r) => Number(r.game_id)),
    );
    const known = existingGameIds(db, ids);
    const insert = db.prepare(
      `INSERT INTO collection_items (username_key, game_id, num_plays, added_at, updated_at, manual)
       VALUES (?, ?, 0, ?, ?, 1)
       ON CONFLICT (username_key, game_id) DO UPDATE SET removed_at = NULL, manual = 1, updated_at = excluded.updated_at`,
    );
    const added: number[] = [];
    const already: number[] = [];
    for (const id of new Set(ids)) {
      if (!known.has(id)) continue;
      if (owned.has(id)) already.push(id);
      else {
        insert.run(key, id, ts, ts);
        added.push(id);
      }
    }
    return { added, already };
  });
}

/** Take a hand-added game out of a collection. Games that came from BGG can't be removed here. */
export function removeManualGame(db: DatabaseSync, username: string, gameId: number): boolean {
  const ts = now();
  return (
    Number(
      db
        .prepare(
          `UPDATE collection_items SET removed_at = ?, updated_at = ?
            WHERE username_key = ? AND game_id = ? AND manual = 1 AND removed_at IS NULL`,
        )
        .run(ts, ts, userKey(username), gameId).changes,
    ) > 0
  );
}

/** Ids of the games in a collection that were added by hand. */
export function manualGameIds(db: DatabaseSync, username: string): number[] {
  return db
    .prepare("SELECT game_id FROM collection_items WHERE username_key = ? AND manual = 1 AND removed_at IS NULL")
    .all(userKey(username))
    .map((r) => Number(r.game_id));
}

/** Games already in the database with exactly this name (any case). */
export function findGamesByName(db: DatabaseSync, name: string): { id: number; name: string; yearPublished: number | null }[] {
  return db
    .prepare("SELECT id, name, year_published FROM games WHERE name = ? COLLATE NOCASE")
    .all(name.trim())
    .map((r: any) => ({ id: Number(r.id), name: r.name, yearPublished: r.year_published ?? null }));
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
  transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO game_lists (filters, game_ids, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(JSON.stringify(filters), JSON.stringify(gameIds), accountId, ts, ts);
    // A new list starts with no votes: erase the votes from earlier lists.
    db.prepare("DELETE FROM list_votes WHERE list_id <> ?").run(lastInsertRowid);
  });
}

/** Change which games are in the current list (e.g. swap out a hidden one). */
export function updateCurrentListGames(db: DatabaseSync, gameIds: number[]): boolean {
  const current = getCurrentList(db);
  if (!current) return false;
  transaction(db, () => {
    db.prepare("UPDATE game_lists SET game_ids = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(gameIds),
      now(),
      current.id,
    );
    // Votes for games that left the list (e.g. hidden ones) go with them.
    db.prepare(
      "DELETE FROM list_votes WHERE list_id = ? AND game_id NOT IN (SELECT value FROM json_each(?))",
    ).run(current.id, JSON.stringify(gameIds));
  });
  return true;
}

// ---------- interest per user per game ----------

/** 5 yes please! · 4 sounds great · 3 sure thing · 2 slightly · 1 not particularly · 0 rather not */
export type InterestLevel = 0 | 1 | 2 | 3 | 4 | 5;
export const isInterestLevel = (v: unknown): v is InterestLevel =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 5;

export interface Interest {
  username: string;
  level: InterestLevel;
}

/** Everyone's interest in these games: { gameId -> [{ username, level }] }. No row = no opinion. */
/** One person's interest level for every game they've rated: { gameId: level }. */
export function myInterest(db: DatabaseSync, accountId: number): Record<number, InterestLevel> {
  const out: Record<number, InterestLevel> = {};
  for (const r of db.prepare("SELECT game_id, level FROM game_interest WHERE account_id = ?").all(accountId) as any[]) {
    out[Number(r.game_id)] = Number(r.level) as InterestLevel;
  }
  return out;
}

/**
 * Average interest per game, over everyone who rated it (no opinion = not
 * counted). Used to give better-liked games a better chance in new lists.
 * Returns { gameId: { average: 0–5, count } } for every rated game.
 */
export function interestSummary(db: DatabaseSync): Record<number, { average: number; count: number }> {
  const out: Record<number, { average: number; count: number }> = {};
  for (const r of db
    .prepare("SELECT game_id, AVG(level) AS average, COUNT(*) AS count FROM game_interest GROUP BY game_id")
    .all() as any[]) {
    out[Number(r.game_id)] = { average: Math.round(Number(r.average) * 100) / 100, count: Number(r.count) };
  }
  return out;
}

export function getInterest(db: DatabaseSync, gameIds: number[]): Map<number, Interest[]> {
  const out = new Map<number, Interest[]>();
  for (const r of db
    .prepare(
      `SELECT i.game_id, a.username, i.level FROM game_interest i JOIN accounts a ON a.id = i.account_id
        WHERE i.game_id IN (SELECT value FROM json_each(?))
        ORDER BY i.level DESC, a.username COLLATE NOCASE`,
    )
    .all(JSON.stringify(gameIds)) as any[]) {
    const id = Number(r.game_id);
    out.set(id, [...(out.get(id) ?? []), { username: r.username, level: Number(r.level) as InterestLevel }]);
  }
  return out;
}

/** Set your interest in a game (null = back to "no opinion"). False if the game doesn't exist. */
export function setInterest(db: DatabaseSync, accountId: number, gameId: number, level: InterestLevel | null): boolean {
  if (!db.prepare("SELECT 1 FROM games WHERE id = ?").get(gameId)) return false;
  if (level === null) {
    db.prepare("DELETE FROM game_interest WHERE account_id = ? AND game_id = ?").run(accountId, gameId);
  } else {
    db.prepare(
      `INSERT INTO game_interest (account_id, game_id, level, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, game_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    ).run(accountId, gameId, level, now());
  }
  return true;
}

/**
 * One-time import of interest levels (e.g. from an old poll). If the file
 * exists, each { username, gameId, level } is saved, then the file is DELETED.
 * Unknown usernames or games are skipped and reported. Existing levels are
 * overwritten. Format: { "entries": [{ "username": "sam", "gameId": 13, "level": 2 }] }
 */
export async function importInterest(db: DatabaseSync, file: string) {
  const { existsSync, readFileSync, unlinkSync } = await import("node:fs");
  if (!existsSync(file)) return;
  const { entries } = JSON.parse(readFileSync(file, "utf8")) as {
    entries: { username: string; gameId: number; level: InterestLevel }[];
  };
  const accountId = new Map(
    db.prepare("SELECT id, username FROM accounts").all().map((r: any) => [String(r.username).toLowerCase(), Number(r.id)]),
  );
  let saved = 0;
  const skipped: string[] = [];
  transaction(db, () => {
    for (const e of entries) {
      const id = accountId.get(e.username.toLowerCase());
      if (id === undefined || !isInterestLevel(e.level) || !setInterest(db, id, e.gameId, e.level)) {
        skipped.push(`${e.username}/${e.gameId}`);
      } else saved++;
    }
  });
  unlinkSync(file);
  console.log(`[interest] imported ${saved} interest levels from ${file} (then deleted it)`);
  if (skipped.length) console.log(`[interest] skipped ${skipped.length} (unknown user or game): ${skipped.join(", ")}`);
}

/** Every account's username (so the page can show who has "no opinion"). */
export const listMemberNames = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT username FROM accounts ORDER BY username COLLATE NOCASE")
    .all()
    .map((r: any) => r.username as string);

// ---------- votes on the current list ----------

/** Who voted for each game in a list: { gameId -> [usernames, in voting order] }. */
export function getListVotes(db: DatabaseSync, listId: number): Map<number, string[]> {
  const votes = new Map<number, string[]>();
  for (const r of db
    .prepare(
      `SELECT v.game_id, a.username FROM list_votes v JOIN accounts a ON a.id = v.account_id
        WHERE v.list_id = ? ORDER BY v.voted_at, a.username`,
    )
    .all(listId) as any[]) {
    votes.set(Number(r.game_id), [...(votes.get(Number(r.game_id)) ?? []), r.username]);
  }
  return votes;
}

/** Vote (or take the vote back) for a game in the current list. False if it isn't in the list. */
export function setVote(db: DatabaseSync, accountId: number, gameId: number, voted: boolean): boolean {
  const current = getCurrentList(db);
  if (!current || !current.gameIds.includes(gameId)) return false;
  if (voted) {
    db.prepare(
      `INSERT INTO list_votes (list_id, game_id, account_id, voted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(current.id, gameId, accountId, now());
  } else {
    db.prepare("DELETE FROM list_votes WHERE list_id = ? AND game_id = ? AND account_id = ?").run(
      current.id,
      gameId,
      accountId,
    );
  }
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
