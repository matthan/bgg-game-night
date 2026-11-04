import { useCallback, useEffect, useRef, useState } from "react";
import { getCollection, syncCollection } from "../api";
import type { CollectionResponse } from "../types";

export interface CollectionEntry {
  status: "loading" | "success" | "error";
  data?: CollectionResponse;
  error?: string;
  refreshing?: boolean; // a manual refresh is running (data still shown)
}

/** Usernames are case-insensitive on BGG, so we key everything by lowercase. */
export const userKey = (name: string) => name.trim().toLowerCase();

const FOLLOW_UP_MS = 4000; // re-check while the API refreshes in the background
const MAX_FOLLOW_UPS = 8;

/**
 * Loads several collections at once and keeps them fresh.
 * Returns { entries: { [lowercased username]: entry }, refresh(username) }.
 *
 * - Loads any username in the list that hasn't loaded yet.
 * - If the API says it's refreshing a collection in the background
 *   (`syncing: true`), quietly re-fetches a few seconds later to pick up changes.
 * - refresh(username) asks the API to re-sync from BGG right now.
 *
 * Learning note: this is a lot of bookkeeping! In project #2, TanStack Query
 * (`useQueries` + `refetchInterval`) replaces most of this file.
 */
export function useCollections(usernames: string[]) {
  const [entries, setEntries] = useState<Record<string, CollectionEntry>>({});
  const entriesRef = useRef(entries); // latest entries without re-running effects
  entriesRef.current = entries;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setEntry = (key: string, update: (prev: CollectionEntry | undefined) => CollectionEntry) =>
    setEntries((prev) => ({ ...prev, [key]: update(prev[key]) }));

  // While the API reports a background sync, check back a few times.
  const followUp = useCallback((name: string, data: CollectionResponse, attempt = 1) => {
    const key = userKey(name);
    clearTimeout(timers.current.get(key));
    if (!data.syncing || attempt > MAX_FOLLOW_UPS) return;
    timers.current.set(
      key,
      setTimeout(async () => {
        try {
          const fresh = await getCollection(name);
          if (!entriesRef.current[key]) return; // removed meanwhile
          setEntry(key, (prev) => ({ ...prev, status: "success", data: fresh }));
          followUp(name, fresh, attempt + 1);
        } catch {
          /* keep showing what we have */
        }
      }, FOLLOW_UP_MS),
    );
  }, []);

  // A string dependency only changes when the list contents change.
  const depKey = usernames.map(userKey).join("|");

  useEffect(() => {
    const controllers: AbortController[] = [];

    for (const name of usernames) {
      const key = userKey(name);
      if (entriesRef.current[key]?.status === "success") continue;

      const controller = new AbortController();
      controllers.push(controller);
      setEntry(key, () => ({ status: "loading" }));

      getCollection(name, controller.signal)
        .then((data) => {
          setEntry(key, () => ({ status: "success", data }));
          followUp(name, data);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const error = err instanceof Error ? err.message : "Something went wrong";
          setEntry(key, () => ({ status: "error", error }));
        });
    }

    // Forget entries (and timers) for usernames that were removed.
    const keep = new Set(usernames.map(userKey));
    setEntries((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => keep.has(k))));
    for (const [k, t] of timers.current) if (!keep.has(k)) clearTimeout(t);

    return () => controllers.forEach((c) => c.abort());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []); // on unmount

  const refresh = useCallback(async (name: string) => {
    const key = userKey(name);
    setEntry(key, (prev) => ({ ...(prev ?? { status: "loading" }), refreshing: true }));
    try {
      const data = await syncCollection(name);
      setEntry(key, () => ({ status: "success", data }));
    } catch (err) {
      const error = err instanceof Error ? err.message : "Refresh failed";
      // keep the old data if we have it; just report the problem
      setEntry(key, (prev) => (prev?.data ? { ...prev, refreshing: false, error } : { status: "error", error }));
    }
  }, []);

  /** Update a game's hidden flag in every loaded collection (no refetch needed). */
  const markGameHidden = useCallback((gameId: number, hidden: boolean) => {
    setEntries((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([k, e]) => [
          k,
          e.data
            ? { ...e, data: { ...e.data, games: e.data.games.map((g) => (g.id === gameId ? { ...g, hidden } : g)) } }
            : e,
        ]),
      ),
    );
  }, []);

  /** Show a collection the API just sent back (e.g. after adding games by hand). */
  const setCollection = useCallback((data: CollectionResponse) => {
    setEntry(userKey(data.username), () => ({ status: "success", data }));
  }, []);

  return { entries, refresh, markGameHidden, setCollection };
}
