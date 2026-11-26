import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import { getMyInterest, setInterest } from "../api";
import { INTEREST_LEVELS, NO_OPINION, interestInfo } from "../interest";
import type { InterestLevel, OwnedGame } from "../types";
import { formatPlayersAndBest } from "./GameCard";
import { Die } from "./Die";
import "./RateInterestPage.css";

interface Props {
  games: OwnedGame[]; // every game in the loaded collections (hidden ones are left out here)
  collections: string[]; // collection names, for the "Collection" filter
  loading: boolean; // collections still loading
  // admin only: hide a game everywhere (it leaves this page and future lists)
  onHide?: (game: OwnedGame) => Promise<void>;
  onUnhide?: (game: OwnedGame) => Promise<void>;
}

// The dice under each card, left to right: no opinion, then six pips … one pip.
const CHOICES: (InterestLevel | null)[] = [null, ...INTEREST_LEVELS.map((l) => l.level)];
const PAGE_SIZE = 48; // cards added each time you scroll near the bottom

const bggUrl = (id: number) => `https://boardgamegeek.com/boardgame/${id}`;

/**
 * "Rate games": every (non-hidden) game in the database as a card grid, A–Z,
 * each with a row of dice to set YOUR interest in one tap (tap the chosen die
 * again to go back to no opinion). Filters: name search, unrated only, one
 * collection. Cards load in batches as you scroll.
 */
export function RateInterestPage({ games, collections, loading, onHide, onUnhide }: Props) {
  const [mine, setMine] = useState<Record<number, InterestLevel> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justHid, setJustHid] = useState<OwnedGame | null>(null); // admin: for the "Undo" message
  const [query, setQuery] = useState("");
  const [unratedOnly, setUnratedOnly] = useState(false);
  const [collection, setCollection] = useState(""); // "" = all
  // games rated while "Unrated only" is on stay visible until the filters
  // change, so a card doesn't vanish the moment you rate it
  const [justRated, setJustRated] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState(PAGE_SIZE);
  // The "load more" marker under the grid. Kept in state (a callback ref), so
  // the observer below is set up whenever the marker appears. It's only drawn
  // once your ratings have loaded; with a plain ref, opening this page from the
  // menu (games already loaded, ratings not yet) never observed it, and the
  // page stopped at the first 48 cards.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    getMyInterest()
      .then(setMine)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your ratings"));
  }, []);

  // A–Z, not hidden
  const all = useMemo(
    () =>
      games.filter((g) => !g.hidden).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [games],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (g) =>
        (!q || g.name.toLowerCase().includes(q)) &&
        (!collection || g.owners.includes(collection)) &&
        (!unratedOnly || mine?.[g.id] === undefined || justRated.has(g.id)),
    );
  }, [all, query, collection, unratedOnly, mine, justRated]);

  // New filters: start again at the top, and forget the "just rated" exceptions.
  useEffect(() => {
    setShown(PAGE_SIZE);
    setJustRated(new Set());
  }, [query, collection, unratedOnly]);

  // Load more cards when the bottom of the grid comes into view.
  useEffect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && setShown((n) => n + PAGE_SIZE), {
      rootMargin: "600px",
    });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel, visible.length, shown]);

  const ratedCount = mine ? all.filter((g) => mine[g.id] !== undefined).length : 0;

  // Show the new rating straight away, then save it (put it back if saving fails).
  async function rate(game: OwnedGame, level: InterestLevel | null) {
    if (!mine) return;
    const before = mine[game.id];
    const next = { ...mine };
    if (level === null) delete next[game.id];
    else next[game.id] = level;
    setMine(next);
    if (unratedOnly) setJustRated((s) => new Set(s).add(game.id));
    setError(null);
    try {
      await setInterest(game.id, level);
    } catch (e) {
      setMine((m) => {
        const back = { ...m };
        if (before === undefined) delete back[game.id];
        else back[game.id] = before;
        return back;
      });
      setError(`Couldn't save your rating for ${game.name}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  // Admin: hide a game (it disappears from this page), with Undo for a few seconds.
  async function hide(game: OwnedGame) {
    if (!onHide) return;
    setError(null);
    try {
      await onHide(game);
      setJustHid(game);
    } catch (e) {
      setError(`Couldn't hide ${game.name}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  async function undoHide() {
    if (!justHid || !onUnhide) return;
    const game = justHid;
    setJustHid(null);
    try {
      await onUnhide(game);
    } catch (e) {
      setError(`Couldn't undo that: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }
  useEffect(() => {
    if (!justHid) return;
    const t = setTimeout(() => setJustHid(null), 8000);
    return () => clearTimeout(t);
  }, [justHid]);

  return (
    <section id="rate-games" className="rate-page" aria-label="Rate your interest">
      <header className="rate-header">
        <h1>Rate my interest</h1>
        <p className="muted">
          Rate your interest in playing each game. Games of interest come up more often in the Boardgame Picker.
        </p>
      </header>

      <div className="rate-filters">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search games"
          aria-label="Search games by name"
        />
        <select value={collection} onChange={(e) => setCollection(e.target.value)} aria-label="Collection">
          <option value="">All collections</option>
          {collections.map((c) => (
            <option key={c} value={c}>
              {c}'s games
            </option>
          ))}
        </select>
        <label className="rate-unrated">
          <input type="checkbox" checked={unratedOnly} onChange={(e) => setUnratedOnly(e.target.checked)} />
          Unrated only
        </label>
      </div>

      <p className="rate-count muted" aria-live="polite">
        {loading || !mine
          ? "Loading games…"
          : `${visible.length} game${visible.length === 1 ? "" : "s"} · you've rated ${ratedCount} of ${all.length}`}
      </p>
      {error && <p className="status error">⚠️ {error}</p>}
      {justHid && (
        <p className="status rate-hidden-msg" role="status">
          Hid <strong>{justHid.name}</strong> from this page and future game lists.{" "}
          <button type="button" className="text-button" onClick={undoHide}>
            Undo
          </button>
        </p>
      )}

      {mine && (
        <ul className="rate-grid">
          {visible.slice(0, shown).map((g) => {
            const level = mine[g.id] ?? null;
            const info = level === null ? null : interestInfo(level);
            return (
              <li key={g.id} className={`rate-card${level === null ? " unrated" : ""}`}>
                <div className="rate-cover">
                  {g.image || g.thumbnail ? (
                    <img src={g.thumbnail ?? g.image ?? ""} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <span className="rate-placeholder" aria-hidden>
                      🎲
                    </span>
                  )}
                </div>
                <div className="rate-body">
                  <a className="rate-name" href={bggUrl(g.id)} target="_blank" rel="noreferrer">
                    {g.name}
                    <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="external-icon" aria-hidden />
                    <span className="visually-hidden"> (opens BoardGameGeek in a new tab)</span>
                  </a>
                  <span className="rate-stats muted">
                    👥 {formatPlayersAndBest(g)}
                    {onHide && (
                      <button
                        type="button"
                        className="rate-hide"
                        onClick={() => hide(g)}
                        aria-label={`Hide ${g.name}`}
                        title="Hide this game everywhere (kept in the database; unhide from the game list's summary)"
                      >
                        Hide
                      </button>
                    )}
                  </span>
                  <div className="rate-dice" role="radiogroup" aria-label={`Your interest in ${g.name}`}>
                    {CHOICES.map((c) => {
                      const ci = c === null ? NO_OPINION : interestInfo(c);
                      const chosen = c === level;
                      return (
                        <button
                          key={c ?? "none"}
                          type="button"
                          role="radio"
                          aria-checked={chosen}
                          className={`rate-die${chosen ? " chosen" : ""}`}
                          title={chosen && c !== null ? `${ci.label} (tap again to clear)` : ci.label}
                          onClick={() => rate(g, chosen ? null : c)}
                        >
                          <Die icon={ci.icon} color={ci.color} />
                          <span className="visually-hidden">{ci.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <span
                    className="rate-level"
                    style={{ color: info?.color ?? "var(--muted)" } as CSSProperties}
                    aria-hidden
                  >
                    {info ? info.label : NO_OPINION.label}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {mine && visible.length === 0 && !loading && (
        <p className="status">
          {unratedOnly ? "You've rated every game here. Nice!" : "No games match. Try a different search."}
        </p>
      )}
      {mine && shown < visible.length && <div ref={setSentinel} className="rate-more" aria-hidden />}
    </section>
  );
}
