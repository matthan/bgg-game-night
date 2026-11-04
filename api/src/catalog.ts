import type { DatabaseSync } from "node:sqlite";
import { fetchThings, searchBgg, type SearchHit, type ThingInfo } from "./bgg/catalog.js";
import { fetchMockThings, searchMock } from "./bgg/mock.js";
import * as repo from "./db/repo.js";

export interface CatalogOptions {
  db: DatabaseSync;
  token: string;
  useMock: boolean;
}

/** A game name from a bulk add, and the BGG game it was matched to. */
export interface NameMatch {
  query: string;
  id: number;
  name: string;
  yearPublished: number | null;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Adding games to a collection by hand (for people without a BGG account).
 * Game info still comes from BGG — only the "who owns it" part is manual.
 */
export function createCatalog({ db, token, useMock }: CatalogOptions) {
  const search = (query: string, exact = false): Promise<SearchHit[]> =>
    useMock ? searchMock(query, exact) : searchBgg(query, token, exact);
  const things = (ids: number[]): Promise<Map<number, ThingInfo>> =>
    useMock ? fetchMockThings(ids) : fetchThings(ids, token);

  /** Search BGG by name; best matches first, each marked if it's already in our database. */
  async function searchGames(query: string) {
    const q = query.trim().toLowerCase();
    const rank = (h: SearchHit) => (h.name.toLowerCase() === q ? 0 : h.name.toLowerCase().startsWith(q) ? 1 : 2);
    const hits = (await search(query)).sort(
      (a, b) => rank(a) - rank(b) || a.name.length - b.name.length || (b.yearPublished ?? 0) - (a.yearPublished ?? 0),
    );
    const top = hits.slice(0, 30);
    const known = repo.existingGameIds(db, top.map((h) => h.id));
    return { total: hits.length, hits: top.map((h) => ({ ...h, inDatabase: known.has(h.id) })) };
  }

  /** Make sure these games are in the `games` table, fetching only the missing ones from BGG. */
  async function ensureGames(ids: number[]) {
    const known = repo.existingGameIds(db, ids);
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) repo.saveThings(db, (await things(missing)).values());
  }

  /** Add games to a collection by BGG id (a manual collection is created if needed). */
  async function addByIds(username: string, ids: number[]) {
    await ensureGames(ids);
    repo.ensureManualUser(db, username);
    const result = repo.addManualGames(db, username, ids);
    const known = repo.existingGameIds(db, ids);
    return { ...result, notFound: ids.filter((id) => !known.has(id)) };
  }

  /**
   * Find the BGG game for a name. Uses a game already in the database with
   * exactly that name if there is one; otherwise BGG's exact-name search,
   * picking the most-rated game when several share the name.
   */
  async function matchName(query: string): Promise<{ match: NameMatch | null; askedBgg: boolean }> {
    const local = repo.findGamesByName(db, query);
    if (local.length) return { match: { query, ...local[0] }, askedBgg: false };

    const hits = await search(query, true);
    if (!hits.length) return { match: null, askedBgg: true };
    const infos = await things(hits.slice(0, 20).map((h) => h.id));
    const best = [...infos.values()].sort((a, b) => b.usersRated - a.usersRated)[0];
    if (!best) return { match: null, askedBgg: true };
    repo.saveThings(db, [best]);
    const { id, name, yearPublished } = best.game;
    return { match: { query, id, name, yearPublished }, askedBgg: true };
  }

  /** Add games by name (one name per entry). Reports what each name matched and what wasn't found. */
  async function addByNames(username: string, names: string[]) {
    const matched: NameMatch[] = [];
    const notFound: string[] = [];
    for (const raw of names) {
      const query = raw.trim();
      if (!query) continue;
      const { match, askedBgg } = await matchName(query);
      if (match) matched.push(match);
      else notFound.push(query);
      if (askedBgg && !useMock) await pause(1000); // go easy on BGG's rate limit
    }
    repo.ensureManualUser(db, username);
    const { added, already } = repo.addManualGames(db, username, matched.map((m) => m.id));
    return { matched, added, already, notFound };
  }

  return { searchGames, addByIds, addByNames };
}

export type Catalog = ReturnType<typeof createCatalog>;
