import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCollectionXml } from "./client.js";
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
