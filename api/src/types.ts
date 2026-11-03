/**
 * The clean JSON shape our API returns to the React app.
 * BGG's raw XML is messy; we normalise it into this once, on the server.
 */
export interface Game {
  id: number;
  name: string;
  yearPublished: number | null;
  thumbnail: string | null;
  image: string | null;
  minPlayers: number | null;
  maxPlayers: number | null;
  playingTime: number | null; // minutes
  minPlayTime: number | null;
  maxPlayTime: number | null;
  myRating: number | null; // the user's own rating, if they gave one
  bggRating: number | null; // community average
  numPlays: number;
  weight: number | null; // complexity 1–5 from BGG, null if unknown
  bestWith: number[]; // player counts the BGG community votes "Best"
  recommendedWith: number[]; // player counts voted "Recommended" (includes Best)
  hidden: boolean; // you hid it from the results (kept in the database)
}

export interface CollectionResponse {
  username: string;
  source: "bgg" | "mock";
  lastSyncedAt: string | null; // when this collection was last refreshed from BGG
  lastSyncError: string | null; // problem from the last refresh, if any
  syncing: boolean; // a refresh is running right now (data may update shortly)
  games: Game[];
}
