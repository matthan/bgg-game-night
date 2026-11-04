import { XMLParser } from "fast-xml-parser";
import { BggError, decodeName } from "./client.js";
import { parseDetailsXml, type GameDetails } from "./details.js";
import type { Game } from "../types.js";

/**
 * Looking games up on BGG one at a time (for games added by hand, e.g. by
 * members who don't have a BGG account):
 * - searchBgg("spirit island")  -> candidates from BGG's /search
 * - fetchThings([162886])       -> full game info + weight + poll from /thing
 */

const BGG_BASE = "https://boardgamegeek.com/xmlapi2";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["item", "name"].includes(name),
});

export interface SearchHit {
  id: number;
  name: string;
  yearPublished: number | null;
}

/** Everything needed to store a game we haven't seen in any collection. */
export interface ThingInfo {
  game: Omit<Game, "myRating" | "numPlays" | "bestWith" | "recommendedWith" | "hidden">;
  details: GameDetails;
  usersRated: number; // how many people rated it on BGG (used to pick between same-named games)
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const primaryName = (item: any): string =>
  decodeName(String((item.name?.find((n: any) => n.type === "primary") ?? item.name?.[0])?.value ?? "Unknown"));

async function get(url: string, token: string) {
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 5000)); // rate limited: wait once and retry
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new BggError(`BGG responded with HTTP ${res.status}`);
  return res.text();
}

export function parseSearchXml(xml: string): SearchHit[] {
  const items: any[] = parser.parse(xml)?.items?.item ?? [];
  return items.filter((it) => !it.type || it.type === "boardgame").map((it) => ({
    id: Number(it.id),
    name: primaryName(it),
    yearPublished: num(it.yearpublished?.value),
  }));
}

/** Search BGG board games by name. exact=true only returns games with exactly that name. */
export async function searchBgg(query: string, token: string, exact = false): Promise<SearchHit[]> {
  const url = `${BGG_BASE}/search?type=boardgame&query=${encodeURIComponent(query)}${exact ? "&exact=1" : ""}`;
  return parseSearchXml(await get(url, token));
}

export function parseThingInfoXml(xml: string): Map<number, ThingInfo> {
  // expansions can't be added (only base games count as owning a game)
  const items: any[] = (parser.parse(xml)?.items?.item ?? []).filter((it: any) => it.type !== "boardgameexpansion");
  const details = parseDetailsXml(xml); // weight + player-count poll, already handled there
  const out = new Map<number, ThingInfo>();
  for (const it of items) {
    const id = Number(it.id);
    const ratings = it.statistics?.ratings ?? {};
    out.set(id, {
      game: {
        id,
        name: primaryName(it),
        yearPublished: num(it.yearpublished?.value),
        thumbnail: it.thumbnail ?? null,
        image: it.image ?? null,
        minPlayers: num(it.minplayers?.value),
        maxPlayers: num(it.maxplayers?.value),
        playingTime: num(it.playingtime?.value),
        minPlayTime: num(it.minplaytime?.value),
        maxPlayTime: num(it.maxplaytime?.value),
        bggRating: num(ratings.average?.value),
        weight: details.get(id)?.weight ?? null,
      },
      details: details.get(id) ?? { weight: null, playerVotes: [] },
      usersRated: Number(ratings.usersrated?.value ?? 0),
    });
  }
  return out;
}

/** Full info for up to 20 games per request from BGG's /thing endpoint. */
export async function fetchThings(ids: number[], token: string): Promise<Map<number, ThingInfo>> {
  const out = new Map<number, ThingInfo>();
  for (let i = 0; i < ids.length; i += 20) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    const batch = ids.slice(i, i + 20);
    for (const [id, info] of parseThingInfoXml(await get(`${BGG_BASE}/thing?stats=1&id=${batch.join(",")}`, token))) {
      out.set(id, info);
    }
  }
  return out;
}
