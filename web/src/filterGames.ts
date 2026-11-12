import type { CollectionResponse, FilterState, Game, InterestBoost, InterestSummary, OwnedGame } from "./types";

/** [2, 3, 4, 6] -> "2–4, 6" */
export function formatCounts(counts: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    let j = i;
    while (j + 1 < counts.length && counts[j + 1] === counts[j] + 1) j++;
    parts.push(i === j ? `${counts[i]}` : `${counts[i]}–${counts[j]}`);
    i = j;
  }
  return parts.join(", ");
}

/**
 * Pure function: same inputs -> same output, no side effects.
 * Keeping logic like this outside components makes it easy to test and reuse.
 */
export function filterGames<T extends Game>(games: T[], f: FilterState): T[] {
  return games.filter((g) => {
    if (f.players !== null) {
      if (g.minPlayers !== null && f.players < g.minPlayers) return false;
      if (g.maxPlayers !== null && f.players > g.maxPlayers) return false;

      // Community poll: with both boxes ticked, either one is enough.
      if (f.bestWith || f.recommendedWith) {
        const best = f.bestWith && g.bestWith.includes(f.players);
        const recommended = f.recommendedWith && g.recommendedWith.includes(f.players);
        if (!best && !recommended) return false;
      }
    }

    return true;
  });
}

/**
 * Combine several collections into one list with no duplicates.
 * A game owned by two people appears once, with both names in `owners`.
 */
export function mergeCollections(collections: CollectionResponse[]): OwnedGame[] {
  const byId = new Map<number, OwnedGame>();
  for (const c of collections) {
    for (const game of c.games) {
      const existing = byId.get(game.id);
      if (existing) existing.owners.push(c.username);
      else byId.set(game.id, { ...game, owners: [c.username] });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Up to `n` random items, without repeats (Fisher–Yates shuffle). */
export function sampleRandom<T>(items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * How likely a game is to be picked, from everyone's average interest in it.
 *
 *   weight = 2 ^ (strength × (average − 2.5))
 *
 * average: 0 = rather not … 5 = yes, please!  (2.5 is neutral)
 * strength: off 0 · gentle 1 · strong 2 ("strong" doubles the effect)
 *
 * Gentle: averaging "Yes, please!" ≈ 5.7×, "Sure thing" ≈ 1.4×, "Slightly"
 * ≈ 0.7×, "Rather not" ≈ 0.18×. Games nobody has rated count as neutral (1×).
 */
export const INTEREST_STRENGTH: Record<InterestBoost, number> = { off: 0, gentle: 1, strong: 2 };

export function interestWeight(average: number | undefined, boost: InterestBoost): number {
  if (average === undefined) return 1;
  return 2 ** (INTEREST_STRENGTH[boost] * (average - 2.5));
}

/**
 * Up to `n` items without repeats, where an item with weight 2 is twice as
 * likely to be picked as one with weight 1. (Each item gets a random key
 * u^(1/weight) and the n largest keys win: Efraimidis–Spirakis.)
 */
export function sampleWeighted<T>(items: T[], n: number, weight: (item: T) => number): T[] {
  return items
    .map((item) => ({ item, key: Math.random() ** (1 / Math.max(weight(item), 1e-9)) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, n)
    .map((x) => x.item);
}

/** Pick games for a list: random, but favouring well-liked ones as `boost` says. */
export function pickGames<T extends Game>(games: T[], n: number, summary: InterestSummary, boost: InterestBoost): T[] {
  if (boost === "off") return sampleRandom(games, n);
  return sampleWeighted(games, n, (g) => interestWeight(summary[g.id]?.average, boost));
}
