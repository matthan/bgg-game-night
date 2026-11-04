import { XMLParser } from "fast-xml-parser";
import type { Game } from "../types.js";

const BGG_BASE = "https://boardgamegeek.com/xmlapi2";

export class BggError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Force these to always be arrays, even when BGG returns a single one.
  isArray: (name) => name === "item" || name === "error",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * BGG double-encodes some characters in names ("Tzolk&#039;in"), so they're
 * still HTML codes after XML parsing. This turns them back into characters.
 */
export function decodeName(name: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  let out = name;
  for (let i = 0; i < 2 && out.includes("&"); i++) {
    out = out.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (m, code: string) => {
      if (code[0] !== "#") return named[code.toLowerCase()] ?? m;
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    });
  }
  return out;
}

/** Turn "7.5", "N/A", undefined, etc. into a number or null. */
function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fetch a user's owned board games from BGG.
 *
 * Quirk: the collection endpoint often replies "202 Accepted" first, meaning
 * "your request is queued, ask again in a moment". We retry a few times.
 */
export async function fetchCollection(username: string, token: string): Promise<Game[]> {
  const url = new URL(`${BGG_BASE}/collection`);
  url.searchParams.set("username", username);
  url.searchParams.set("own", "1");
  url.searchParams.set("stats", "1");
  url.searchParams.set("excludesubtype", "boardgameexpansion");

  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 202) {
      await sleep(Math.min(2000 * attempt, 8000));
      continue;
    }
    if (res.status === 429) throw new BggError("BGG rate limit hit — try again shortly.", 429);
    if (res.status === 401 || res.status === 403) {
      throw new BggError("BGG rejected the API token. Check BGG_TOKEN in your .env.", 502);
    }
    if (!res.ok) throw new BggError(`BGG responded with HTTP ${res.status}`);

    return parseCollectionXml(await res.text());
  }

  throw new BggError("BGG is still preparing this collection. Try again in a minute.", 503);
}

export function parseCollectionXml(xml: string): Game[] {
  const doc = parser.parse(xml);

  // Bad usernames come back as HTTP 200 with an <errors> body.
  const errors = doc?.errors?.error;
  if (errors?.length) {
    throw new BggError(errors[0].message ?? "BGG returned an error", 404);
  }

  const items: any[] = doc?.items?.item ?? [];
  return items.map((item): Game => {
    const stats = item.stats ?? {};
    const rating = stats.rating ?? {};
    const name = typeof item.name === "object" ? item.name["#text"] : item.name;

    return {
      id: Number(item.objectid),
      name: decodeName(String(name ?? "Unknown")),
      yearPublished: num(item.yearpublished),
      thumbnail: item.thumbnail ?? null,
      image: item.image ?? null,
      minPlayers: num(stats.minplayers),
      maxPlayers: num(stats.maxplayers),
      playingTime: num(stats.playingtime),
      minPlayTime: num(stats.minplaytime),
      maxPlayTime: num(stats.maxplaytime),
      myRating: num(rating.value),
      bggRating: num(rating.average?.value),
      numPlays: Number(item.numplays ?? 0),
      // filled in from /thing details by the sync (see sync.ts)
      weight: null,
      bestWith: [],
      recommendedWith: [],
      hidden: false,
    };
  });
}
