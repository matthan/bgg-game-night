// Mirrors api/src/types.ts — the JSON contract between the API and the UI.
// (Later you could move these into a shared package so they can't drift.)

export interface Game {
  id: number;
  name: string;
  yearPublished: number | null;
  thumbnail: string | null;
  image: string | null;
  minPlayers: number | null;
  maxPlayers: number | null;
  playingTime: number | null;
  minPlayTime: number | null;
  maxPlayTime: number | null;
  myRating: number | null;
  bggRating: number | null;
  numPlays: number;
  weight: number | null; // complexity 1–5 from BGG, null if unknown
  bestWith: number[]; // player counts the BGG community votes "Best"
  recommendedWith: number[]; // player counts voted "Recommended" (includes Best)
  hidden: boolean; // you hid it from the results (kept in the database)
}

/** A game after merging collections: remembers who owns it. */
export interface OwnedGame extends Game {
  owners: string[];
}

export interface CollectionResponse {
  username: string;
  source: "bgg" | "mock";
  lastSyncedAt: string | null; // when this collection was last refreshed from BGG
  lastSyncError: string | null; // problem from the last refresh, if any
  syncing: boolean; // the API is refreshing it in the background right now
  kind: "bgg" | "manual"; // synced from a BGG account, or games added by hand only
  manualGameIds: number[]; // games added by hand (these can be removed)
  games: Game[];
}

/** A login account for this app (not a BGG username). */
export interface Account {
  id: number;
  username: string;
  isAdmin: boolean; // can hide games and manage accounts
  createdAt: string;
  lastLoginAt: string | null;
}

/** 2 yes please! · 1 sounds good · 0 take it or leave it · -1 rather not · -2 no thanks */
export type InterestLevel = -2 | -1 | 0 | 1 | 2;

/** One person's interest in a game ("no opinion" = not in the list). */
export interface Interest {
  username: string;
  level: InterestLevel;
}

/** A game in the shared list, with who voted for it and everyone's interest. */
export interface ListGame extends OwnedGame {
  votes: string[]; // usernames, in the order they voted
  interest: Interest[]; // keenest first
}

/** The shared game list (made by an admin from a set of filters). */
export interface GameList {
  id: number;
  filters: FilterState;
  games: ListGame[]; // in display order
  members: string[]; // everyone who can sign in (to show "no opinion")
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A collection saved in the API's database (GET /api/users). */
export interface SavedUser {
  username: string;
  source: "bgg" | "manual";
  addedAt: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  gameCount: number;
}

/** A BGG search result (GET /api/catalog/search). */
export interface SearchHit {
  id: number;
  name: string;
  yearPublished: number | null;
  inDatabase: boolean;
}

/** What happened when adding games by hand. */
export interface AddGamesResult {
  added: number[];
  already: number[];
  notFound: (string | number)[]; // names (bulk) or ids
  matched: { query: string; id: number; name: string; yearPublished: number | null }[]; // bulk only
  collection: CollectionResponse;
}

export interface FilterState {
  players: number | null; // null = any
  maxTime: number | null; // minutes; null = any
  weight: WeightClass | null; // null = any
  bestWith: boolean; // with a player count: only games voted "Best" at that count
  recommendedWith: boolean; // with a player count: only games voted "Recommended" at that count
}

/** Weight buckets — the cut-offs live in WEIGHT_CLASSES (filterGames.ts). */
export type WeightClass = "light" | "medium-light" | "medium" | "medium-heavy" | "heavy";
