/**
 * Tests for adding games by hand (mock data, in-memory database — no BGG calls).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchXml, parseThingInfoXml } from "../src/bgg/catalog.js";
import { createCatalog } from "../src/catalog.js";
import { openDatabase } from "../src/db/index.js";
import * as repo from "../src/db/repo.js";
import { createSyncService } from "../src/sync.js";

const setup = () => {
  const db = openDatabase(":memory:");
  return { db, catalog: createCatalog({ db, token: "", useMock: true }), sync: createSyncService({ db, token: "", useMock: true, detailsMaxAgeDays: 30 }) };
};

test("search XML: board games only, primary name", () => {
  const hits = parseSearchXml(`<items total="2">
    <item type="boardgame" id="162886"><name type="primary" value="Spirit Island"/><yearpublished value="2017"/></item>
    <item type="boardgameexpansion" id="235465"><name type="primary" value="Spirit Island: Jagged Earth"/></item>
  </items>`);
  assert.deepEqual(hits, [{ id: 162886, name: "Spirit Island", yearPublished: 2017 }]);
});

test("thing XML: game info, weight, poll and number of ratings", () => {
  const info = parseThingInfoXml(`<items><item type="boardgame" id="5">
    <name type="alternate" value="Alt"/><name type="primary" value="Real Name"/>
    <yearpublished value="2001"/><minplayers value="2"/><maxplayers value="5"/>
    <playingtime value="60"/><minplaytime value="45"/><maxplaytime value="60"/>
    <statistics><ratings><usersrated value="321"/><average value="7.5"/><averageweight value="2.5"/></ratings></statistics>
  </item></items>`).get(5)!;
  assert.equal(info.game.name, "Real Name");
  assert.equal(info.game.maxPlayers, 5);
  assert.equal(info.game.weight, 2.5);
  assert.equal(info.game.bggRating, 7.5);
  assert.equal(info.usersRated, 321);
});

test("add by id: creates a manual collection and stores the game with its details", async () => {
  const { db, catalog } = setup();
  const r = await catalog.addByIds("trevor", [162886, 999999]);
  assert.deepEqual(r.added, [162886]);
  assert.deepEqual(r.notFound, [999999]);
  assert.equal(repo.getUser(db, "trevor")!.source, "manual");
  const [g] = repo.getCollection(db, "trevor");
  assert.equal(g.name, "Spirit Island");
  assert.equal(g.weight, 4.08);
  assert.deepEqual(g.bestWith, [2]);
  assert.deepEqual((await catalog.addByIds("trevor", [162886])).already, [162886]);
});

test("add by name: picks the most-rated game with that exact name, reports misses", async () => {
  const { db, catalog } = setup();
  const r = await catalog.addByNames("sam", ["spirit island", "Arcs", "Not A Real Game", " "]);
  assert.deepEqual(r.matched.map((m) => [m.id, m.yearPublished]), [[162886, 2017], [359871, 2024]]);
  assert.deepEqual(r.notFound, ["Not A Real Game"]);
  assert.deepEqual(repo.manualGameIds(db, "sam").sort(), [162886, 359871]);
});

test("hand-added games survive a BGG sync, and can be removed by hand", async () => {
  const { db, catalog, sync } = setup();
  await sync.syncCollection("matthan"); // 15 mock games from "BGG"
  await catalog.addByIds("matthan", [359871, 13]); // Arcs (new) + CATAN (already from BGG)
  assert.equal(repo.getUser(db, "matthan")!.source, "bgg"); // stays a BGG collection
  await sync.syncCollection("matthan");
  const ids = repo.getCollection(db, "matthan").map((g) => g.id);
  assert.ok(ids.includes(359871));
  assert.equal(ids.length, 16);
  assert.deepEqual(repo.manualGameIds(db, "matthan"), [359871]);
  assert.equal(repo.removeManualGame(db, "matthan", 13), false); // came from BGG: not removable here
  assert.equal(repo.removeManualGame(db, "matthan", 359871), true);
  assert.equal(repo.getCollection(db, "matthan").length, 15);
});

test("manual collections are never synced from BGG", async () => {
  const { catalog, sync } = setup();
  await catalog.addByIds("marc", [43015]); // Hansa Teutonica
  await assert.rejects(sync.syncCollection("marc"), /added by hand/);
});

test("HTML codes in BGG names are decoded", async () => {
  const { decodeName } = await import("../src/bgg/client.js");
  assert.equal(decodeName("Tzolk&#039;in: The Mayan Calendar"), "Tzolk'in: The Mayan Calendar");
  assert.equal(decodeName("Dungeons &amp;amp; Dragons"), "Dungeons & Dragons");
  assert.equal(decodeName("Caf&#xE9; &quot;X&quot;"), 'Café "X"');
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO games (id, name, updated_at) VALUES (1, 'It&#039;s a Wonderful World', 'now')").run();
  const { migrations } = await import("../src/db/schema.js");
  db.exec(migrations.find((m) => m.version === 8)!.sql); // running it again is harmless
  assert.equal((db.prepare("SELECT name FROM games WHERE id = 1").get() as any).name, "It's a Wonderful World");
});

test("collection import keeps only owned base games", async () => {
  const { parseCollectionXml } = await import("../src/bgg/client.js");
  const item = (id: number, subtype: string, own: string) => `
    <item objecttype="thing" objectid="${id}" subtype="${subtype}"><name sortindex="1">G${id}</name>
      <stats minplayers="2" maxplayers="4" playingtime="60"><rating value="N/A"><average value="7"/></rating></stats>
      <status own="${own}" prevowned="0" want="0" wishlist="0"/><numplays>0</numplays></item>`;
  const games = parseCollectionXml(`<items>${item(1, "boardgame", "1")}${item(2, "boardgameexpansion", "1")}${item(3, "boardgame", "0")}</items>`);
  assert.deepEqual(games.map((g) => g.id), [1]);
});

test("expansions can't be added by hand", () => {
  const info = parseThingInfoXml(`<items>
    <item type="boardgame" id="1"><name type="primary" value="Base"/></item>
    <item type="boardgameexpansion" id="2"><name type="primary" value="Base: More"/></item></items>`);
  assert.deepEqual([...info.keys()], [1]);
});
