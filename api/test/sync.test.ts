/**
 * Tests for the database + sync rules. Run with: npm test
 * Each test uses a fresh in-memory database, so nothing touches data/ or BGG.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/index.js";
import * as repo from "../src/db/repo.js";
import { createSyncService } from "../src/sync.js";
import type { Game } from "../src/types.js";

const game = (id: number, name: string, extra: Partial<Game> = {}): Game => ({
  id, name, yearPublished: 2000, thumbnail: null, image: null, minPlayers: 2, maxPlayers: 4,
  playingTime: 60, minPlayTime: 30, maxPlayTime: 60, myRating: null, bggRating: 7, numPlays: 0,
  weight: null, bestWith: [], recommendedWith: [], hidden: false, ...extra,
});

test("first save adds every game", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "Alice");
  const r = repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B"), game(3, "C")]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.added.sort(), [1, 2, 3]);
  assert.equal(r.removed, 0);
  assert.equal(repo.getCollection(db, "ALICE").length, 3); // usernames are case-insensitive
});

test("re-sync: new games added, missing games removed, plays updated", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B"), game(3, "C")]);
  const r = repo.saveCollection(db, "alice", [game(1, "A", { numPlays: 5 }), game(3, "C"), game(4, "D")]);
  assert.deepEqual(r.added, [4]);
  assert.equal(r.removed, 1);
  const names = repo.getCollection(db, "alice").map((g) => g.name);
  assert.deepEqual(names, ["A", "C", "D"]);
  assert.equal(repo.getCollection(db, "alice").find((g) => g.id === 1)!.numPlays, 5);
  // the removed game's row is kept (history), just marked removed
  const row = db.prepare("SELECT removed_at FROM collection_items WHERE game_id = 2").get() as any;
  assert.ok(row.removed_at);
});

test("a removed game that comes back is owned again", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B")]);
  repo.saveCollection(db, "alice", [game(1, "A")]);
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B")]);
  assert.equal(repo.getCollection(db, "alice").length, 2);
});

test("duplicate copies of a game count once", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  const r = repo.saveCollection(db, "alice", [game(1, "A"), game(1, "A")]);
  assert.equal(r.total, 1);
});

test("two users share one games row", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.ensureUser(db, "bob");
  repo.saveCollection(db, "alice", [game(1, "A")]);
  repo.saveCollection(db, "bob", [game(1, "A"), game(2, "B")]);
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM games").get() as any).n), 2);
});

test("details: only games without (or with old) details are fetched", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B")]);
  assert.deepEqual(repo.gamesNeedingDetails(db, [1, 2], 30).sort(), [1, 2]);
  repo.saveDetails(db, new Map([[1, { weight: 2.5, playerVotes: [] }]]));
  assert.deepEqual(repo.gamesNeedingDetails(db, [1, 2], 30), [2]);
  // pretend game 1's details are 40 days old
  db.prepare("UPDATE games SET details_synced_at = ? WHERE id = 1").run(new Date(Date.now() - 40 * 86_400_000).toISOString());
  assert.deepEqual(repo.gamesNeedingDetails(db, [1, 2], 30).sort(), [1, 2]);
});

test("poll votes become bestWith / recommendedWith", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A")]);
  repo.saveDetails(db, new Map([[1, { weight: 2.4, playerVotes: [
    { players: 1, best: 5, recommended: 40, notRecommended: 600 },   // neither
    { players: 2, best: 200, recommended: 800, notRecommended: 120 }, // recommended
    { players: 3, best: 500, recommended: 600, notRecommended: 30 },  // recommended
    { players: 4, best: 900, recommended: 300, notRecommended: 20 },  // best (and recommended)
  ] }]]));
  const g = repo.getCollection(db, "alice")[0];
  assert.equal(g.weight, 2.4);
  assert.deepEqual(g.bestWith, [4]);
  assert.deepEqual(g.recommendedWith, [2, 3, 4]);
});

test("hidden games stay in the database and survive a re-sync", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B")]);
  assert.equal(repo.setGameHidden(db, 2, true), true);
  assert.equal(repo.setGameHidden(db, 999, true), false); // unknown game
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B")]); // re-sync
  const byId = Object.fromEntries(repo.getCollection(db, "alice").map((g) => [g.id, g.hidden]));
  assert.deepEqual(byId, { 1: false, 2: true });
  assert.deepEqual(repo.listHiddenGames(db).map((g) => g.name), ["B"]);
  repo.setGameHidden(db, 2, false);
  assert.equal(repo.getCollection(db, "alice").some((g) => g.hidden), false);
  assert.equal(repo.listHiddenGames(db).length, 0);
});

test("game lists: newest is current, games come back in order with owners", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.ensureUser(db, "bob");
  repo.saveCollection(db, "alice", [game(1, "A", { numPlays: 2 }), game(2, "B"), game(3, "C")]);
  repo.saveCollection(db, "bob", [game(1, "A", { numPlays: 3 })]);
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_admin, created_at) VALUES (1, 'matthan', 'x', 1, 'now')").run();
  assert.equal(repo.getCurrentList(db), null);
  repo.createList(db, { players: 2 }, [3, 1], 1);
  repo.createList(db, { players: 4 }, [2, 1], 1);
  const current = repo.getCurrentList(db)!;
  assert.deepEqual([current.filters, current.gameIds, current.createdBy], [{ players: 4 }, [2, 1], "matthan"]);
  const games = repo.getGamesByIds(db, current.gameIds);
  assert.deepEqual(games.map((g) => g.name), ["B", "A"]); // list order, not alphabetical
  assert.deepEqual(games[1].owners, ["alice", "bob"]);
  assert.equal(games[1].numPlays, 5); // plays totalled across owners
  repo.updateCurrentListGames(db, [2, 3]);
  assert.deepEqual(repo.getCurrentList(db)!.gameIds, [2, 3]);
  assert.deepEqual([...repo.existingGameIds(db, [1, 99])], [1]);
});

test("hidden users disappear from the list and come back when added again", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  assert.equal(repo.listUsers(db).length, 1);
  repo.hideUser(db, "Alice");
  assert.equal(repo.listUsers(db).length, 0);
  repo.ensureUser(db, "alice");
  assert.equal(repo.listUsers(db).length, 1);
});

test("sync service (mock data): second sync fetches no details", async () => {
  const db = openDatabase(":memory:");
  const sync = createSyncService({ db, token: "", useMock: true, detailsMaxAgeDays: 30 });
  const first = await sync.syncCollection("matthan");
  assert.equal(first.total, 15);
  assert.equal(first.detailsFetched, 15);
  const second = await sync.syncCollection("matthan");
  assert.equal(second.added.length, 0);
  assert.equal(second.detailsFetched, 0);
  assert.ok(repo.getUser(db, "matthan")!.last_synced_at);
  assert.ok(repo.getCollection(db, "matthan").every((g) => g.weight !== null));
});

test("a new username that fails its first sync is not kept", async () => {
  const db = openDatabase(":memory:");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(`<errors><error><message>Invalid username specified</message></error></errors>`, { status: 200 })) as any;
  try {
    const sync = createSyncService({ db, token: "t", useMock: false, detailsMaxAgeDays: 30 });
    await assert.rejects(sync.syncCollection("not-a-real-user"), /Invalid username/);
    assert.equal(repo.getUser(db, "not-a-real-user"), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
