import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCollectionXml } from "./client.js";
import { parseThingInfoXml, type SearchHit, type ThingInfo } from "./catalog.js";
import { parseDetailsXml, type GameDetails } from "./details.js";
import type { Game } from "../types.js";

const MOCK_FILE = fileURLToPath(new URL("../../mock/collection.xml", import.meta.url));
const MOCK_DETAILS_FILE = fileURLToPath(new URL("../../mock/things.xml", import.meta.url));

/**
 * Mock mode: returns sample games from a local XML file shaped like BGG's.
 * It goes through the SAME parser as live data, so when your token arrives
 * the rest of the app keeps working unchanged.
 */
export async function fetchMockCollection(_username: string): Promise<Game[]> {
  await new Promise((r) => setTimeout(r, 400)); // fake network delay so you can see loading states
  const xml = await readFile(MOCK_FILE, "utf8");
  return parseCollectionXml(xml);
}

/** Mock version of fetchDetails: reads sample /thing data from a local file. */
export async function fetchMockDetails(ids: number[]): Promise<Map<number, GameDetails>> {
  const all = parseDetailsXml(await readFile(MOCK_DETAILS_FILE, "utf8"));
  const empty: GameDetails = { weight: null, playerVotes: [] };
  return new Map(ids.map((id) => [id, all.get(id) ?? empty]));
}

// ---------- looking up single games (mock "Add games") ----------

const MOCK_CATALOG_FILE = fileURLToPath(new URL("../../mock/catalog.xml", import.meta.url));

/** Every mock game: the mock collection's games plus a few extra ones in mock/catalog.xml. */
async function mockThings(): Promise<Map<number, ThingInfo>> {
  const all = parseThingInfoXml(await readFile(MOCK_CATALOG_FILE, "utf8"));
  const details = parseDetailsXml(await readFile(MOCK_DETAILS_FILE, "utf8"));
  for (const g of parseCollectionXml(await readFile(MOCK_FILE, "utf8"))) {
    if (all.has(g.id)) continue;
    const { myRating, numPlays, bestWith, recommendedWith, hidden, ...game } = g;
    const d = details.get(g.id) ?? { weight: null, playerVotes: [] };
    all.set(g.id, { game: { ...game, weight: d.weight }, details: d, usersRated: 1000 });
  }
  return all;
}

/** Mock version of searchBgg: matches names in the mock games. */
export async function searchMock(query: string, exact = false): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  return [...(await mockThings()).values()]
    .filter(({ game }) => (exact ? game.name.toLowerCase() === q : game.name.toLowerCase().includes(q)))
    .map(({ game }) => ({ id: game.id, name: game.name, yearPublished: game.yearPublished }));
}

/** Mock version of fetchThings. */
export async function fetchMockThings(ids: number[]): Promise<Map<number, ThingInfo>> {
  const all = await mockThings();
  return new Map(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]));
}
