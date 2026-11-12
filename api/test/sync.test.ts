/**
 * Tests for the database + sync rules. Run with: npm test
 * Each test uses a fresh in-memory database, so nothing touches data/ or BGG.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("votes: per account, cleared by a new list, removed with a swapped-out game", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B"), game(3, "C")]);
  for (const [id, name] of [[1, "matthan"], [2, "sam"]] as const) {
    db.prepare("INSERT INTO accounts (id, username, password_hash, is_admin, created_at) VALUES (?, ?, 'x', 0, 'now')").run(id, name);
  }
  assert.equal(repo.setVote(db, 1, 1, true), false); // no list yet
  repo.createList(db, {}, [1, 2], 1);
  const listId = () => repo.getCurrentList(db)!.id;
  assert.equal(repo.setVote(db, 1, 3, true), false); // game 3 isn't in the list
  repo.setVote(db, 1, 1, true);
  repo.setVote(db, 2, 1, true);
  repo.setVote(db, 2, 1, true); // voting twice counts once
  repo.setVote(db, 2, 2, true);
  assert.deepEqual(repo.getListVotes(db, listId()).get(1), ["matthan", "sam"]);
  repo.setVote(db, 1, 1, false); // unvote
  assert.deepEqual(repo.getListVotes(db, listId()).get(1), ["sam"]);
  repo.updateCurrentListGames(db, [1, 3]); // game 2 swapped out -> its votes go
  assert.equal(repo.getListVotes(db, listId()).get(2), undefined);
  assert.deepEqual(repo.getListVotes(db, listId()).get(1), ["sam"]);
  repo.createList(db, {}, [1, 2], 1); // new list -> no votes at all
  assert.equal(repo.getListVotes(db, listId()).size, 0);
  assert.equal(Number((db.prepare("SELECT COUNT(*) n FROM list_votes").get() as any).n), 0);
});

test("interest: one level per user per game, clearable, kept across lists", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B")]);
  for (const [id, name] of [[1, "matthan"], [2, "sam"], [3, "trevor"]] as const) {
    db.prepare("INSERT INTO accounts (id, username, password_hash, is_admin, created_at) VALUES (?, ?, 'x', 0, 'now')").run(id, name);
  }
  assert.equal(repo.setInterest(db, 1, 999, 5), false); // unknown game
  repo.setInterest(db, 1, 1, 5);
  repo.setInterest(db, 2, 1, 1);
  repo.setInterest(db, 2, 1, 4); // changing your mind replaces the old level
  repo.setInterest(db, 3, 2, 0);
  assert.deepEqual(repo.getInterest(db, [1]).get(1), [
    { username: "matthan", level: 5 },
    { username: "sam", level: 4 },
  ]);
  repo.setInterest(db, 2, 1, null); // back to no opinion
  assert.deepEqual(repo.getInterest(db, [1]).get(1), [{ username: "matthan", level: 5 }]);
  repo.createList(db, {}, [1, 2], 1); // a new list doesn't touch interest
  assert.equal(repo.getInterest(db, [1, 2]).size, 2);
  assert.throws(() => db.prepare("INSERT INTO game_interest VALUES (1, 2, 6, 'now')").run()); // level out of range
  assert.deepEqual(repo.listMemberNames(db), ["matthan", "sam", "trevor"]);
  assert.equal(repo.isInterestLevel(6), false);
  assert.equal(repo.isInterestLevel(-1), false);
  assert.equal(repo.isInterestLevel(0), true);
});

test("interest summary: average and count per rated game", () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B"), game(3, "C")]);
  for (const [id, name] of [[1, "matthan"], [2, "sam"]] as const) {
    db.prepare("INSERT INTO accounts (id, username, password_hash, is_admin, created_at) VALUES (?, ?, 'x', 0, 'now')").run(id, name);
  }
  repo.setInterest(db, 1, 1, 5);
  repo.setInterest(db, 2, 1, 2);
  repo.setInterest(db, 1, 2, 0);
  assert.deepEqual(repo.interestSummary(db), { 1: { average: 3.5, count: 2 }, 2: { average: 0, count: 1 } }); // game 3: nobody rated it
  assert.deepEqual(repo.myInterest(db, 1), { 1: 5, 2: 0 }); // just matthan's own ratings
  assert.deepEqual(repo.myInterest(db, 2), { 1: 2 });
});

test("interest import: saves known users/games, skips the rest, deletes the file", async () => {
  const db = openDatabase(":memory:");
  repo.ensureUser(db, "alice");
  repo.saveCollection(db, "alice", [game(1, "A"), game(2, "B")]);
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_admin, created_at) VALUES (1, 'Trevor', 'x', 0, 'now')").run();
  const file = join(mkdtempSync(join(tmpdir(), "gn-")), "import-interest.json");
  writeFileSync(file, JSON.stringify({ entries: [
    { username: "trevor", gameId: 1, level: 5 },   // ok (usernames match case-insensitively)
    { username: "trevor", gameId: 2, level: 0 },   // ok
    { username: "nobody", gameId: 1, level: 1 },   // unknown user
    { username: "trevor", gameId: 999, level: 1 }, // unknown game
  ] }));
  await repo.importInterest(db, file);
  assert.equal(existsSync(file), false);
  assert.deepEqual(repo.getInterest(db, [1]).get(1), [{ username: "Trevor", level: 5 }]);
  assert.deepEqual(repo.getInterest(db, [2]).get(2), [{ username: "Trevor", level: 0 }]);
});

test("migration 9 moves old interest answers onto the six-level scale", async () => {
  const { migrations } = await import("../src/db/schema.js");
  const db = new (await import("node:sqlite")).DatabaseSync(":memory:");
  for (const m of migrations.filter((m) => m.version < 9)) db.exec(m.sql);
  db.exec("INSERT INTO accounts (id, username, password_hash, is_admin, created_at) VALUES (1, 'a', 'x', 0, 'now')");
  for (const id of [1, 2, 3, 4, 5]) db.exec(`INSERT INTO games (id, name, updated_at) VALUES (${id}, 'G${id}', 'now')`);
  [2, 1, 0, -1, -2].forEach((level, i) =>
    db.prepare("INSERT INTO game_interest VALUES (1, ?, ?, 'now')").run(i + 1, level));
  db.exec(migrations.find((m) => m.version === 9)!.sql);
  const levels = db.prepare("SELECT level FROM game_interest ORDER BY game_id").all().map((r) => Number(r.level));
  assert.deepEqual(levels, [5, 4, 2, 0, 0]);
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
