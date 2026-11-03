import type { CollectionResponse, FilterState, Game, OwnedGame, WeightClass } from "./types";

/**
 * Weight buckets, lightest first. A game belongs to the first bucket whose
 * `below` is greater than its weight. Change the cut-offs here and the
 * filter dropdown labels update automatically.
 */
export const WEIGHT_CLASSES: { id: WeightClass; label: string; below: number }[] = [
  { id: "light", label: "Light", below: 1.5 },
  { id: "medium-light", label: "Medium Light", below: 2.0 },
  { id: "medium", label: "Medium", below: 2.6 },
  { id: "medium-heavy", label: "Medium Heavy", below: 3.5 },
  { id: "heavy", label: "Heavy", below: Infinity },
];

/** Which weight bucket a game falls in (null if BGG has no weight votes). */
export function weightClass(weight: number | null): WeightClass | null {
  if (weight === null) return null;
  return WEIGHT_CLASSES.find((c) => weight < c.below)!.id;
}

export function weightLabel(id: WeightClass): string {
  return WEIGHT_CLASSES.find((c) => c.id === id)!.label;
}

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

    if (f.maxTime !== null) {
      const time = g.minPlayTime ?? g.playingTime;
      if (time !== null && time > f.maxTime) return false;
    }

    // Games with no weight data are left out when a weight is chosen.
    if (f.weight !== null && weightClass(g.weight) !== f.weight) return false;

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

export function pickRandom<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}
