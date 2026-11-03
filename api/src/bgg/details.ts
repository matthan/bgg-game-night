import { XMLParser } from "fast-xml-parser";
import { BggError } from "./client.js";

/**
 * Extra game details that aren't in BGG's collection data. They come from the
 * /thing endpoint (max 20 ids per request):
 * - weight: statistics.ratings.averageweight (complexity 1–5)
 * - playerVotes: the community "suggested_numplayers" poll, where users vote
 *   Best / Recommended / Not Recommended for each player count.
 *
 * The database stores these, so each game is only fetched when it's new or
 * its details are old (see sync.ts).
 */
export interface PlayerVotes {
  players: number;
  best: number;
  recommended: number;
  notRecommended: number;
}

export interface GameDetails {
  weight: number | null;
  playerVotes: PlayerVotes[];
}

const BGG_BASE = "https://boardgamegeek.com/xmlapi2";
const BATCH_SIZE = 20;
const PAUSE_BETWEEN_BATCHES_MS = 500; // be gentle with BGG

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Force these to always be arrays, even when BGG returns a single one.
  isArray: (name) => ["item", "poll", "results", "result"].includes(name),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Turn poll votes into the two lists the app filters on:
 * - Best:        "Best" got the most votes (≥ Recommended, > Not Recommended)
 * - Recommended: Best + Recommended votes beat Not Recommended (includes Best)
 * This matches how BGG summarises the poll on game pages.
 */
export function classifyPlayerVotes(votes: PlayerVotes[]) {
  const bestWith: number[] = [];
  const recommendedWith: number[] = [];
  for (const v of [...votes].sort((a, b) => a.players - b.players)) {
    if (v.best + v.recommended + v.notRecommended === 0) continue; // nobody voted
    if (v.best + v.recommended > v.notRecommended) recommendedWith.push(v.players);
    if (v.best >= v.recommended && v.best > v.notRecommended) bestWith.push(v.players);
  }
  return { bestWith, recommendedWith };
}

/** Read the raw votes from the "suggested_numplayers" poll ("5+" entries are skipped). */
function parsePlayerPoll(polls: any[]): PlayerVotes[] {
  const poll = polls.find((p) => p.name === "suggested_numplayers");
  const out: PlayerVotes[] = [];
  for (const r of poll?.results ?? []) {
    if (!/^\d+$/.test(String(r.numplayers))) continue;
    const votes = (label: string) => Number(r.result?.find((x: any) => x.value === label)?.numvotes ?? 0);
    out.push({
      players: Number(r.numplayers),
      best: votes("Best"),
      recommended: votes("Recommended"),
      notRecommended: votes("Not Recommended"),
    });
  }
  return out;
}

/** Parse a /thing?stats=1 response into { gameId -> details }. */
export function parseDetailsXml(xml: string): Map<number, GameDetails> {
  const doc = parser.parse(xml);
  const result = new Map<number, GameDetails>();
  for (const item of doc?.items?.item ?? []) {
    const ratings = item?.statistics?.ratings ?? {};
    const weight = Number(ratings.averageweight?.value);
    const weightVotes = Number(ratings.numweights?.value ?? 1);
    result.set(Number(item.id), {
      weight: Number.isFinite(weight) && weight > 0 && weightVotes > 0 ? weight : null,
      playerVotes: parsePlayerPoll(item.poll ?? []),
    });
  }
  return result;
}

/** Fetch details for many games from BGG, 20 per request. */
export async function fetchDetails(ids: number[], token: string): Promise<Map<number, GameDetails>> {
  const result = new Map<number, GameDetails>();

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(PAUSE_BETWEEN_BATCHES_MS);
    const batch = ids.slice(i, i + BATCH_SIZE);
    const url = `${BGG_BASE}/thing?stats=1&id=${batch.join(",")}`;

    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      await sleep(5000); // rate limited: wait once and retry
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!res.ok) throw new BggError(`BGG /thing responded with HTTP ${res.status}`);

    const details = parseDetailsXml(await res.text());
    for (const id of batch) result.set(id, details.get(id) ?? { weight: null, playerVotes: [] });
  }

  return result;
}
