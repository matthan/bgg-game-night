import { useEffect, useMemo, useRef, useState } from "react";
import {
  createList,
  getCurrentList,
  getMe,
  hideUser,
  listUsers,
  logout,
  setGameHidden,
  setUnauthorizedHandler,
  updateListGames,
} from "./api";
import { AccountsPanel } from "./components/AccountsPanel";
import { LoginPage } from "./components/LoginPage";
import { CollectionsBar } from "./components/CollectionsBar";
import { Filters } from "./components/Filters";
import { GameCarousel } from "./components/GameCarousel";
import { useCollections, userKey } from "./hooks/useCollections";
import { filterGames, mergeCollections, sampleRandom } from "./filterGames";
import type { Account, CollectionResponse, FilterState, GameList, OwnedGame } from "./types";

const DEFAULT_FILTERS: FilterState = {
  players: null,
  maxTime: null,
  weight: null,
  bestWith: false,
  recommendedWith: false,
};

// A game list has at most this many games, chosen at random from the matches.
const MAX_RESULTS = 8;

// Shown when the database has no saved collections yet (e.g. the very first run).
const DEFAULT_USERNAMES: string[] = ["matthan"];

/**
 * Top level: check whether we're signed in, then show either the login page
 * or the game picker.
 */
export default function App() {
  // undefined = still checking, null = signed out
  const [account, setAccount] = useState<Account | null | undefined>(undefined);

  useEffect(() => {
    setUnauthorizedHandler(() => setAccount(null)); // session expired → back to login
    getMe()
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);

  async function handleSignOut() {
    await logout().catch(() => {});
    setAccount(null);
  }

  if (account === undefined) return <main className="app" />;
  if (account === null) return <LoginPage onLogin={setAccount} />;
  return <GamePicker account={account} onSignOut={handleSignOut} />;
}

const sameFilters = (a: FilterState, b: FilterState) =>
  (Object.keys(DEFAULT_FILTERS) as (keyof FilterState)[]).every((k) => a[k] === b[k]);

function GamePicker({ account, onSignOut }: { account: Account; onSignOut: () => void }) {
  const isAdmin = account.isAdmin; // only admins (matthan) can make lists, hide games, manage users
  const [showAccounts, setShowAccounts] = useState(false);

  // --- State: the minimum data the UI needs to remember ---
  // null until the saved collections have been loaded from the API
  const [savedUsernames, setUsernames] = useState<string[] | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const usernames = useMemo(() => savedUsernames ?? [], [savedUsernames]);

  // The shared game list everyone sees. undefined = loading, null = none made yet.
  const [list, setList] = useState<GameList | null | undefined>(undefined);
  const [listError, setListError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const filtersTouched = useRef(false); // admin changed the filters since the list loaded

  // On page load, show every collection saved in the database.
  useEffect(() => {
    listUsers()
      .then((saved) => setUsernames(saved.length ? saved.map((u) => u.username) : DEFAULT_USERNAMES))
      .catch(() => setUsernames(DEFAULT_USERNAMES));
  }, []);

  // Load the current game list, and again whenever this tab comes back into
  // view, so everyone picks up a new list without reloading.
  useEffect(() => {
    const load = () =>
      getCurrentList()
        .then(setList)
        .catch((e) => setListError(e.message));
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Show the list's filters. Non-admins always see the saved ones; the admin's
  // own edits are kept until they create a new list.
  useEffect(() => {
    if (!list) return;
    if (!isAdmin || !filtersTouched.current) setFilters({ ...DEFAULT_FILTERS, ...list.filters });
  }, [list, isAdmin]);

  // --- Data fetching (custom hook) ---
  const { entries, refresh, markGameHidden } = useCollections(usernames);
  const [showHidden, setShowHidden] = useState(false); // admin: allow hidden games in new lists
  // for "Undo": the hidden game, where it was, and the game that replaced it
  const [justHidden, setJustHidden] = useState<{ game: OwnedGame; index: number; replacementId: number | null } | null>(null);
  const [hideError, setHideError] = useState<string | null>(null);

  // --- Derived state: computed from other state, NOT stored separately ---
  const loaded: CollectionResponse[] = useMemo(
    () =>
      usernames
        .map((u) => entries[userKey(u)])
        .filter((e) => e?.status === "success")
        .map((e) => e.data!),
    [usernames, entries],
  );
  const allGames = useMemo(() => mergeCollections(loaded), [loaded]);
  const hiddenCount = allGames.filter((g) => g.hidden).length;
  const matches = useMemo(
    () => filterGames(allGames, filters).filter((g) => showHidden || !g.hidden),
    [allGames, filters, showHidden],
  );
  const filtersChanged = isAdmin && !!list && !sameFilters(filters, { ...DEFAULT_FILTERS, ...list.filters });

  const anyLoading = usernames.some((u) => {
    const status = entries[userKey(u)]?.status;
    return status === undefined || status === "loading";
  });
  const errors = usernames
    .map((u) => ({ name: u, entry: entries[userKey(u)] }))
    .filter(({ entry }) => entry?.status === "error");
  const isMock = loaded.some((c) => c.source === "mock");

  function handleAdd(name: string) {
    setUsernames((prev) => [...(prev ?? []), name]); // loading it saves it in the database
  }

  function handleRemove(name: string) {
    setUsernames((prev) => (prev ?? []).filter((u) => userKey(u) !== userKey(name)));
    hideUser(name).catch(() => {}); // hidden in the database; its data is kept
  }

  function handleFiltersChange(next: FilterState) {
    filtersTouched.current = true;
    setFilters(next);
  }

  // Admin: pick random games that match the filters and save them as the list everyone sees.
  async function handleCreateList() {
    if (matches.length === 0) {
      setListError("No games match these filters, so there's nothing to put in a list.");
      return;
    }
    setCreating(true);
    setListError(null);
    setJustHidden(null);
    try {
      const picked = sampleRandom(matches, MAX_RESULTS).map((g) => g.id);
      setList(await createList(filters, picked));
      filtersTouched.current = false;
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Couldn't save the list");
    } finally {
      setCreating(false);
    }
  }

  /** Another random game for the list: fits the list's filters, not hidden, not already in it. */
  function pickReplacement(exclude: Set<number>): OwnedGame | null {
    if (!list) return null;
    const pool = filterGames(allGames, { ...DEFAULT_FILTERS, ...list.filters }).filter(
      (g) => !g.hidden && !exclude.has(g.id),
    );
    return sampleRandom(pool, 1)[0] ?? null;
  }

  // Hide a game: it leaves the results everywhere, and its spot in the list is
  // filled with another random game that fits the list's filters.
  async function handleToggleHidden(game: OwnedGame) {
    if (!list) return;
    setHideError(null);
    const ids = list.games.map((g) => g.id);
    try {
      if (game.hidden) {
        // showing a hidden game again (only possible with "show them" on)
        await setGameHidden(game.id, false);
        markGameHidden(game.id, false);
        setList({ ...list, games: list.games.map((g) => (g.id === game.id ? { ...g, hidden: false } : g)) });
        return;
      }
      await setGameHidden(game.id, true);
      markGameHidden(game.id, true);
      const index = ids.indexOf(game.id);
      const replacement = pickReplacement(new Set([...ids, game.id]));
      const nextIds = replacement
        ? ids.map((id) => (id === game.id ? replacement.id : id))
        : ids.filter((id) => id !== game.id); // nothing else fits: the list just gets shorter
      setList(await updateListGames(nextIds));
      setJustHidden({ game, index, replacementId: replacement?.id ?? null });
    } catch (err) {
      setHideError(`Couldn't save that: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  // Undo a hide: show the game again and put it back where it was.
  async function handleUndoHide() {
    if (!list || !justHidden) return;
    const { game, index, replacementId } = justHidden;
    setJustHidden(null);
    try {
      await setGameHidden(game.id, false);
      markGameHidden(game.id, false);
      const ids = list.games.map((g) => g.id);
      const nextIds =
        replacementId !== null && ids.includes(replacementId)
          ? ids.map((id) => (id === replacementId ? game.id : id))
          : [...ids.slice(0, index), game.id, ...ids.slice(index)];
      setList(await updateListGames(nextIds));
    } catch (err) {
      setHideError(`Couldn't undo that: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  // The "Undo" message disappears after a few seconds.
  useEffect(() => {
    if (!justHidden) return;
    const t = setTimeout(() => setJustHidden(null), 8000);
    return () => clearTimeout(t);
  }, [justHidden]);

  const listDate = list ? new Date(list.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";

  return (
    <main className="app">
      {/* 1. account */}
      <nav id="account-bar" className="account-bar" aria-label="Account">
        <span className="muted">
          Signed in as <strong>{account.username}</strong>
        </span>
        {isAdmin && (
          <button type="button" className="text-button" onClick={() => setShowAccounts((s) => !s)}>
            Manage users
          </button>
        )}
        <button type="button" className="text-button" onClick={onSignOut}>
          Sign out
        </button>
      </nav>

      {isAdmin && showAccounts && <AccountsPanel me={account} onClose={() => setShowAccounts(false)} />}

      {/* 2. title */}
      <header id="site-header" className="site-header">
        <p className="eyebrow">Boardroom Game Night</p>
        <h1>Game Night Picker</h1>
        <p className="muted">Combine BoardGameGeek collections, filter for tonight, and let fate decide.</p>
      </header>

      {/* 3–4. the shared game list */}
      {list === null && (
        <p id="no-list" className="status">
          {isAdmin
            ? "No game list yet. Choose filters, then click Create game list."
            : "No game list yet. Check back soon!"}
        </p>
      )}
      {list && (
        <>
          <p id="list-meta" className="muted list-meta">
            Game list made{list.createdBy ? ` by ${list.createdBy}` : ""} · {listDate}
          </p>
          <GameCarousel
            games={list.games}
            showOwners={loaded.length > 1}
            onToggleHidden={isAdmin ? handleToggleHidden : undefined}
          />
          {justHidden && (
            <p id="hide-message" className="status" role="status">
              Hid <strong>{justHidden.game.name}</strong>
              {justHidden.replacementId !== null ? " and filled its spot with another match." : " (no other games match)."}{" "}
              <button type="button" className="text-button" onClick={handleUndoHide}>
                Undo
              </button>
            </p>
          )}
          {hideError && <p className="status error">⚠️ {hideError}</p>}
        </>
      )}

      {/* 5–6. filters + create button (only the admin can change them) */}
      {loaded.length > 0 && (
        <>
          <Filters value={filters} onChange={handleFiltersChange} disabled={!isAdmin} />
          {isAdmin && (
            <div id="list-actions" className="list-actions">
              <button type="button" className="create-list-button" onClick={handleCreateList} disabled={creating}>
                {creating ? "Creating…" : list ? "Create new game list" : "Create game list"}
              </button>
              <span className="muted">
                {matches.length} game{matches.length === 1 ? "" : "s"} match
                {filtersChanged && " · filters changed since the current list"}
              </span>
            </div>
          )}
          {listError && <p className="status error">⚠️ {listError}</p>}
        </>
      )}

      {/* 7. collections */}
      {savedUsernames === null ? (
        <p className="muted">Loading saved collections…</p>
      ) : (
        <CollectionsBar
          usernames={usernames}
          entries={entries}
          onAdd={handleAdd}
          onRemove={handleRemove}
          onRefresh={refresh}
        />
      )}
      {anyLoading && <p className="status">Loading collections… (BGG can be slow the first time)</p>}
      {errors.map(({ name, entry }) => (
        <p key={name} className="status error">
          ⚠️ {name}: {entry.error}
        </p>
      ))}
      {savedUsernames?.length === 0 && <p className="muted">No collections yet. Add one to get started.</p>}

      {/* 8. collection summary */}
      {loaded.length > 0 && (
        <>
          <p id="collection-summary" className="muted">
            {allGames.length - hiddenCount} games across {loaded.length} collection{loaded.length > 1 ? "s" : ""}
            {isAdmin && hiddenCount > 0 && (
              <>
                {" "}· {hiddenCount} hidden ·{" "}
                <button type="button" className="text-button" onClick={() => setShowHidden((s) => !s)}>
                  {showHidden ? "leave them out of new lists" : "allow them in new lists"}
                </button>
              </>
            )}
          </p>
          {isMock && (
            <p id="mock-banner" className="banner">
              Mock mode: showing sample games. Add your BGG token to <code>.env</code> for real data.
            </p>
          )}
        </>
      )}
    </main>
  );
}
