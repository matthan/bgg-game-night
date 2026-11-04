import type {
  Account,
  AddGamesResult,
  CollectionResponse,
  FilterState,
  GameList,
  Interest,
  InterestLevel,
  SavedUser,
  SearchHit,
} from "./types";

// Called when the API says we're not signed in (e.g. the session expired).
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

/**
 * Calls OUR Express API (never BGG directly — the token lives on the server).
 * The browser sends the session cookie automatically (same origin).
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/me") onUnauthorized();
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---------- signing in ----------

export const getMe = () => request<Account>("/api/auth/me");
export const login = (username: string, password: string) =>
  request<Account>("/api/auth/login", json("POST", { username, password }));
export const logout = () => request<void>("/api/auth/logout", { method: "POST" });

// ---------- accounts (admin only) ----------

export const listAccounts = () => request<Account[]>("/api/accounts");
export const createAccount = (username: string, password: string) =>
  request<Account>("/api/accounts", json("POST", { username, password }));
export const resetPassword = (id: number, password: string) =>
  request<void>(`/api/accounts/${id}/password`, json("PUT", { password }));
export const deleteAccount = (id: number) => request<void>(`/api/accounts/${id}`, { method: "DELETE" });

// ---------- the shared game list ----------

export const getCurrentList = () => request<GameList | null>("/api/lists/current");
/** Admin: save a new list (the filters used + the picked game ids, in order). */
export const createList = (filters: FilterState, gameIds: number[]) =>
  request<GameList>("/api/lists", json("POST", { filters, gameIds }));
/** Admin: change the games in the current list (e.g. after hiding one). */
export const updateListGames = (gameIds: number[]) =>
  request<GameList>("/api/lists/current/games", json("PUT", { gameIds }));

/** Vote for a game in the current list (or take the vote back). */
export const setVote = (gameId: number, voted: boolean) =>
  request<GameList>(`/api/lists/current/games/${gameId}/vote`, { method: voted ? "PUT" : "DELETE" });

/** Set your interest in a game (null = back to "no opinion"). Returns everyone's interest in it. */
export const setInterest = (gameId: number, level: InterestLevel | null) =>
  level === null
    ? request<Interest[]>(`/api/interest/${gameId}`, { method: "DELETE" })
    : request<Interest[]>(`/api/interest/${gameId}`, json("PUT", { level }));

// ---------- collections & games ----------

const path = (username: string) => `/api/collection/${encodeURIComponent(username)}`;

/** A collection from the database (the first load of a new username syncs from BGG). */
export const getCollection = (username: string, signal?: AbortSignal) =>
  request<CollectionResponse>(path(username), { signal });

/** Re-sync a collection from BGG now. */
export const syncCollection = (username: string) =>
  request<CollectionResponse>(`${path(username)}/sync`, { method: "POST" });

// ---------- adding games by hand ----------

/** Search BoardGameGeek by name. */
export const searchGames = (q: string) =>
  request<{ total: number; hits: SearchHit[] }>(`/api/catalog/search?q=${encodeURIComponent(q)}`);

/** Add games to a collection by BGG id, or by name (creates the collection if needed). */
export const addGames = (username: string, games: { ids: number[] } | { names: string[] }) =>
  request<AddGamesResult>(`${path(username)}/games`, json("POST", games));

/** Remove a game that was added by hand. */
export const removeGame = (username: string, gameId: number) =>
  request<CollectionResponse>(`${path(username)}/games/${gameId}`, { method: "DELETE" });

/** Collections saved in the database (shown on page load). */
export const listUsers = () => request<SavedUser[]>("/api/users");

/** Hide a game from the results (or show it again). It stays in the database. */
export const setGameHidden = (gameId: number, hidden: boolean) =>
  request<void>(`/api/games/${gameId}/hidden`, { method: hidden ? "PUT" : "DELETE" });

/** Remove a collection from the page (its data stays in the database). */
export const hideUser = (username: string) =>
  request<void>(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
