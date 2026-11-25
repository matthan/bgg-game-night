import { useEffect, useMemo, useRef, useState } from "react";
import {
  createList,
  getCurrentList,
  getInterestSummary,
  getMe,
  hideUser,
  listUsers,
  logout,
  setGameHidden,
  setUnauthorizedHandler,
  setVeto,
  setVote,
  updateListGames,
} from "./api";
import { AccountsPanel } from "./components/AccountsPanel";
import { AddGamesPanel } from "./components/AddGamesPanel";
import { RateInterestPage } from "./components/RateInterestPage";
import { LoginPage } from "./components/LoginPage";
import { CollectionsBar } from "./components/CollectionsBar";
import { Filters } from "./components/Filters";
import { GameCarousel } from "./components/GameCarousel";
import { GameVoteList } from "./components/GameVoteList";
import { useCollections, userKey } from "./hooks/useCollections";
import { filterGames, mergeCollections, pickGames } from "./filterGames";
import type { Account, CollectionResponse, FilterState, GameList, ListGame, OwnedGame } from "./types";

const DEFAULT_FILTERS: FilterState = {
  players: null,
  bestWith: false,
  recommendedWith: false,
  interestBoost: "gentle", // lists made before this setting existed count as "gentle" too
};

// A game list has at most this many games, chosen at random from the matches.
const MAX_RESULTS = 7;

// How the game list is shown:
//   "fan"      — all games at once as tilted 3D cards (GameVoteList)
//   "carousel" — the GSAP slideshow (GameCarousel)
// Switch this one line to go back.
const LIST_DISPLAY = "fan" as "fan" | "carousel";
const ListDisplay = LIST_DISPLAY === "fan" ? GameVoteList : GameCarousel;

// How often the page re-checks the game list (new lists, other people's votes).
const LIST_REFRESH_MS = 15_000;

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

/** A saved list's filters with today's defaults filled in, and old settings
 * (e.g. the removed time and weight filters) dropped. */
const withDefaults = (saved: Partial<FilterState> | undefined): FilterState =>
  Object.fromEntries(
    (Object.keys(DEFAULT_FILTERS) as (keyof FilterState)[]).map((k) => [k, saved?.[k] ?? DEFAULT_FILTERS[k]]),
  ) as unknown as FilterState;

const sameFilters = (a: FilterState, b: FilterState) =>
  (Object.keys(DEFAULT_FILTERS) as (keyof FilterState)[]).every((k) => a[k] === b[k]);

function GamePicker({ account, onSignOut }: { account: Account; onSignOut: () => void }) {
  const isAdmin = account.isAdmin; // only admins (matthan) can make lists, hide games, manage users
  const [showAccounts, setShowAccounts] = useState(false);
  const [showAddGames, setShowAddGames] = useState(false);
  const canAddGames = userKey(account.username) !== "guest"; // the shared guest sign-in has no games

  // Which page: the game list, or "Rate games" (#rate in the address, so the
  // browser's back button and bookmarks work). Guest has no interest to rate.
  const pageFromHash = () => (window.location.hash === "#rate" && canAddGames ? "rate" : "list");
  const [page, setPage] = useState<"list" | "rate">(pageFromHash);
  useEffect(() => {
    const onHash = () => {
      const next = pageFromHash();
      setPage(next);
      window.scrollTo(0, 0);
      if (next === "list")
        getCurrentList()
          .then(setList)
          .catch(() => {}); // pick up ratings made meanwhile
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Load the current game list; then check again every 15 seconds while the
  // page is visible (and when the tab comes back), so everyone sees new
  // lists and each other's votes without reloading.
  useEffect(() => {
    const load = () =>
      getCurrentList()
        .then(setList)
        .catch((e) => setListError(e.message));
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => document.visibilityState === "visible" && load(), LIST_REFRESH_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  // Show the list's filters. Non-admins always see the saved ones; the admin's
  // own edits are kept until they create a new list.
  useEffect(() => {
    if (!list) return;
    if (!isAdmin || !filtersTouched.current) setFilters(withDefaults(list.filters));
  }, [list, isAdmin]);

  // --- Data fetching (custom hook) ---
  const { entries, refresh, markGameHidden, setCollection } = useCollections(usernames);
  const [showHidden, setShowHidden] = useState(false); // admin: allow hidden games in new lists
  // for "Undo": what happened (hidden or just replaced), the game, where it was, and the game that took its spot
  const [justHidden, setJustHidden] = useState<{
    kind: "hide" | "replace";
    game: OwnedGame;
    index: number;
    replacementId: number | null;
  } | null>(null);
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
  const filtersChanged = isAdmin && !!list && !sameFilters(filters, withDefaults(list.filters));

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

  // Games were added/removed by hand: show the new collection (and its chip, if it's new).
  function handleCollectionChanged(data: CollectionResponse) {
    setCollection(data);
    setUsernames((prev) =>
      (prev ?? []).some((u) => userKey(u) === userKey(data.username)) ? prev : [...(prev ?? []), data.username],
    );
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
      // random, but favouring games people are keen on (as the filters' "Favour well-liked games" says)
      const summary = await getInterestSummary();
      const picked = pickGames(matches, MAX_RESULTS, summary, filters.interestBoost).map((g) => g.id);
      setList(await createList(filters, picked));
      filtersTouched.current = false;
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Couldn't save the list");
    } finally {
      setCreating(false);
    }
  }

  /**
   * Another random game for the list: fits the list's filters, not hidden, not
   * already in it; favours well-liked games the same way the list did.
   */
  async function pickReplacement(exclude: Set<number>): Promise<OwnedGame | null> {
    if (!list) return null;
    const listFilters = withDefaults(list.filters);
    const pool = filterGames(allGames, listFilters).filter((g) => !g.hidden && !exclude.has(g.id));
    const summary = await getInterestSummary();
    return pickGames(pool, 1, summary, listFilters.interestBoost)[0] ?? null;
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
      const replacement = await pickReplacement(new Set([...ids, game.id]));
      const nextIds = replacement
        ? ids.map((id) => (id === game.id ? replacement.id : id))
        : ids.filter((id) => id !== game.id); // nothing else fits: the list just gets shorter
      setList(await updateListGames(nextIds));
      setJustHidden({ kind: "hide", game, index, replacementId: replacement?.id ?? null });
    } catch (err) {
      setHideError(`Couldn't save that: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  // Replace a game: swap it for another random match, WITHOUT hiding it (it can
  // still come up in future lists). Its votes go with it, as with Hide.
  async function handleReplace(game: OwnedGame) {
    if (!list) return;
    setHideError(null);
    const ids = list.games.map((g) => g.id);
    try {
      const replacement = await pickReplacement(new Set(ids));
      if (!replacement) {
        setHideError(`No other games match this list's filters, so ${game.name} stays.`);
        return;
      }
      const index = ids.indexOf(game.id);
      setList(await updateListGames(ids.map((id) => (id === game.id ? replacement.id : id))));
      setJustHidden({ kind: "replace", game, index, replacementId: replacement.id });
    } catch (err) {
      setHideError(`Couldn't replace it: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  // Vote / unvote. Show it straight away, then save; if saving fails, reload the list.
  async function handleToggleVote(game: ListGame) {
    if (!list) return;
    const me = account.username;
    const voted = !game.votes.includes(me);
    // (voting for the game you vetoed takes the veto back, as the API does)
    setList({
      ...list,
      games: list.games.map((g) =>
        g.id !== game.id
          ? g
          : {
              ...g,
              votes: voted ? [...g.votes, me] : g.votes.filter((v) => v !== me),
              vetoes: voted ? g.vetoes.filter((v) => v !== me) : g.vetoes,
            },
      ),
    });
    try {
      setList(await setVote(game.id, voted));
    } catch (err) {
      setListError(`Couldn't save your vote: ${err instanceof Error ? err.message : "unknown error"}`);
      getCurrentList()
        .then(setList)
        .catch(() => {});
    }
  }

  // Veto a game (or take the veto back). One veto per person: it moves from
  // wherever it was, and takes back your vote for that game. Shown straight
  // away, then saved.
  async function handleToggleVeto(game: ListGame) {
    if (!list) return;
    const me = account.username;
    const vetoed = !game.vetoes.includes(me);
    setList({
      ...list,
      games: list.games.map((g) => {
        const others = g.vetoes.filter((v) => v !== me);
        if (g.id !== game.id) return vetoed ? { ...g, vetoes: others } : g;
        return vetoed ? { ...g, vetoes: [...others, me], votes: g.votes.filter((v) => v !== me) } : { ...g, vetoes: others };
      }),
    });
    try {
      setList(await setVeto(game.id, vetoed));
    } catch (err) {
      setListError(`Couldn't save your veto: ${err instanceof Error ? err.message : "unknown error"}`);
      getCurrentList()
        .then(setList)
        .catch(() => {});
    }
  }

  // Undo a hide or replace: (show the game again and) put it back where it was.
  async function handleUndoHide() {
    if (!list || !justHidden) return;
    const { kind, game, index, replacementId } = justHidden;
    setJustHidden(null);
    try {
      if (kind === "hide") {
        await setGameHidden(game.id, false);
        markGameHidden(game.id, false);
      }
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

  // Who made the list and when: not shown on the page, kept in the page's
  // <meta name="game-list"> tag for now (e.g. for later use / debugging).
  useEffect(() => {
    if (!list) return;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="game-list"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "game-list";
      document.head.appendChild(meta);
    }
    const made = new Date(list.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    meta.content = `Game list #${list.id} made${list.createdBy ? ` by ${list.createdBy}` : ""} · ${made}`;
  }, [list?.id, list?.createdBy, list?.createdAt]);

  return (
    <main className="app">
      {/* 1. account */}
      <nav id="account-bar" className="account-bar" aria-label="Account">
        <span className="muted">
          Signed in as <strong>{account.username}</strong>
        </span>
        {canAddGames && (
          <button
            type="button"
            className="text-button"
            onClick={() => (window.location.hash = page === "rate" ? "" : "rate")}
          >
            {page === "rate" ? "Boardgame Picker" : "Rate games"}
          </button>
        )}
        {canAddGames && (
          <button type="button" className="text-button" onClick={() => setShowAddGames((s) => !s)}>
            Add games
          </button>
        )}
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
      {canAddGames && showAddGames && (
        <AddGamesPanel
          me={account}
          collections={Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, e.data]))}
          onChanged={handleCollectionChanged}
          onClose={() => setShowAddGames(false)}
        />
      )}

      {page === "rate" ? (
        /* "Rate games": every game in the collections, as a grid you rate in one tap each */
        <RateInterestPage
          games={allGames}
          collections={loaded.map((c) => c.username)}
          loading={anyLoading}
          onHide={isAdmin ? (g) => setGameHidden(g.id, true).then(() => markGameHidden(g.id, true)) : undefined}
          onUnhide={isAdmin ? (g) => setGameHidden(g.id, false).then(() => markGameHidden(g.id, false)) : undefined}
        />
      ) : (
        <>
          {/* 2. title */}
          <header id="site-header" className="site-header">
            <p className="eyebrow">Boardroom Game Night</p>
            <h1>Board Game Picker</h1>
            <p className="muted">Game night approaches. What are you excited to play?</p>
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
              <ListDisplay
                games={list.games.slice(0, MAX_RESULTS)} // older lists may have had 8
                showOwners={loaded.length > 1}
                onToggleHidden={isAdmin ? handleToggleHidden : undefined}
                onReplace={isAdmin ? handleReplace : undefined}
                me={account.username}
                onToggleVote={handleToggleVote}
                onToggleVeto={handleToggleVeto}
                members={list.members}
              />
              {justHidden && (
                <p id="hide-message" className="status" role="status">
                  {justHidden.kind === "replace" ? "Replaced " : "Hid "}
                  <strong>{justHidden.game.name}</strong>
                  {justHidden.kind === "replace"
                    ? " with another match."
                    : justHidden.replacementId !== null
                      ? " and filled its spot with another match."
                      : " (no other games match)."}{" "}
                  <button type="button" className="text-button" onClick={handleUndoHide}>
                    Undo
                  </button>
                </p>
              )}
              {hideError && <p className="status error">⚠️ {hideError}</p>}
            </>
          )}

          {/* Errors from votes, interest or making a list: everyone sees these. */}
          {listError && <p className="status error">⚠️ {listError}</p>}

          {/* 5–8. admin only (matthan): filters, Create game list, collections, summary.
          Everyone else just sees the game list above. */}
          {isAdmin && (
            <>
              {/* 5–6. filters + create button */}
              {loaded.length > 0 && (
                <>
                  <Filters value={filters} onChange={handleFiltersChange} />
                  <div id="list-actions" className="list-actions">
                    <button type="button" className="create-list-button" onClick={handleCreateList} disabled={creating}>
                      {creating ? "Creating…" : list ? "Create new game list" : "Create game list"}
                    </button>
                    <span className="muted">
                      {matches.length} game{matches.length === 1 ? "" : "s"} match
                      {filtersChanged && " · filters changed since the current list"}
                    </span>
                  </div>
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
                    {allGames.length - hiddenCount} games across {loaded.length} collection
                    {loaded.length > 1 ? "s" : ""}
                    {hiddenCount > 0 && (
                      <>
                        {" "}
                        · {hiddenCount} hidden ·{" "}
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
            </>
          )}
        </>
      )}
    </main>
  );
}
