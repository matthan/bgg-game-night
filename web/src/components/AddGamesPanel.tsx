import { useEffect, useMemo, useState, type FormEvent } from "react";
import { addGames, listAccounts, removeGame, searchGames } from "../api";
import { userKey } from "../hooks/useCollections";
import type { Account, AddGamesResult, CollectionResponse, SearchHit } from "../types";

const NAMES_PER_REQUEST = 10; // long lists are sent in small chunks so we can show progress
const NOT_A_COLLECTION = ["guest"]; // shared sign-in, not a person with games

interface Props {
  me: Account;
  /** Collections already loaded on the page, by lowercase name. */
  collections: Record<string, CollectionResponse | undefined>;
  /** The API sent back a changed collection: show it on the page. */
  onChanged: (collection: CollectionResponse) => void;
  onClose: () => void;
}

/** Summary of a bulk add, built up chunk by chunk. */
interface BulkSummary {
  added: string[];
  already: string[];
  renamed: string[]; // "Viticulture → Viticulture Essential Edition (2015)"
  notFound: string[];
}

const label = (name: string, year: number | null) => (year ? `${name} (${year})` : name);

/**
 * Add games to a collection by hand, for people without a BGG account.
 * Everyone can add to their own collection; the admin can pick anyone's.
 * Game info (players, time, weight, poll) still comes from BGG.
 */
export function AddGamesPanel({ me, collections, onChanged, onClose }: Props) {
  const [targets, setTargets] = useState<string[]>([me.username]);
  const [target, setTarget] = useState(me.username);
  const collection = collections[userKey(target)];

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [names, setNames] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  // The admin can add games for any member (their sign-in name is their collection).
  useEffect(() => {
    if (!me.isAdmin) return;
    listAccounts()
      .then((accounts) =>
        setTargets([
          me.username,
          ...accounts
            .map((a) => a.username)
            .filter((u) => userKey(u) !== userKey(me.username) && !NOT_A_COLLECTION.includes(userKey(u))),
        ]),
      )
      .catch(() => {});
  }, [me]);

  const owned = useMemo(() => new Set(collection?.games.map((g) => g.id) ?? []), [collection]);
  const manualGames = useMemo(() => {
    const ids = new Set(collection?.manualGameIds ?? []);
    return (collection?.games ?? []).filter((g) => ids.has(g.id));
  }, [collection]);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setMessage(null);
    try {
      const result = await searchGames(query.trim());
      setHits(result.hits);
      setTotal(result.total);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Search failed", error: true });
    } finally {
      setSearching(false);
    }
  }

  async function handleAdd(hit: SearchHit) {
    setBusyId(hit.id);
    setMessage(null);
    try {
      const result = await addGames(target, { ids: [hit.id] });
      onChanged(result.collection);
      setMessage({ text: `Added ${label(hit.name, hit.yearPublished)} to ${target}'s games.` });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Couldn't add it", error: true });
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(gameId: number, name: string) {
    setMessage(null);
    try {
      onChanged(await removeGame(target, gameId));
      setMessage({ text: `Removed ${name}.` });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Couldn't remove it", error: true });
    }
  }

  // Bulk add: one game name per line, sent in chunks of 10.
  async function handleBulk(e: FormEvent) {
    e.preventDefault();
    const list = [...new Set(names.split("\n").map((n) => n.trim()).filter(Boolean))];
    if (!list.length) return;
    const totals: BulkSummary = { added: [], already: [], renamed: [], notFound: [] };
    setSummary(null);
    setMessage(null);
    try {
      for (let i = 0; i < list.length; i += NAMES_PER_REQUEST) {
        setProgress(`Looking up ${Math.min(i + NAMES_PER_REQUEST, list.length)} of ${list.length}…`);
        const r: AddGamesResult = await addGames(target, { names: list.slice(i, i + NAMES_PER_REQUEST) });
        for (const m of r.matched) {
          const text = label(m.name, m.yearPublished);
          if (r.added.includes(m.id)) totals.added.push(text);
          else totals.already.push(text);
          if (m.name.toLowerCase() !== m.query.toLowerCase()) totals.renamed.push(`${m.query} → ${text}`);
        }
        totals.notFound.push(...r.notFound.map(String));
        onChanged(r.collection);
        setSummary({ ...totals });
      }
      setNames(totals.notFound.join("\n")); // leave only the misses, to fix and retry
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Couldn't add those", error: true });
    } finally {
      setProgress(null);
    }
  }

  return (
    <section id="add-games" className="accounts-panel add-games" aria-label="Add games">
      <div className="accounts-header">
        <h2>Add games</h2>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">
        For games that aren't in a BGG collection. Details like players, time and weight still come from BoardGameGeek.
      </p>

      <label className="add-games-target">
        Collection{" "}
        {targets.length > 1 ? (
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        ) : (
          <strong>{target}</strong>
        )}
        <span className="muted">
          {" "}
          · {collection ? `${collection.games.length} games` : "no games yet"}
        </span>
      </label>

      {/* 1. search and add one at a time */}
      <form className="add-games-search" onSubmit={handleSearch}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search BoardGameGeek, e.g. Spirit Island"
          aria-label="Game name"
        />
        <button type="submit" disabled={searching || query.trim().length < 2}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {hits && (
        <ul className="search-hits">
          {hits.length === 0 && <li className="muted">No board games found with that name.</li>}
          {hits.map((h) => (
            <li key={h.id}>
              <a href={`https://boardgamegeek.com/boardgame/${h.id}`} target="_blank" rel="noreferrer">
                {label(h.name, h.yearPublished)}
              </a>
              {owned.has(h.id) ? (
                <span className="muted">✓ in collection</span>
              ) : (
                <button type="button" className="text-button" onClick={() => handleAdd(h)} disabled={busyId !== null}>
                  {busyId === h.id ? "Adding…" : "+ Add"}
                </button>
              )}
            </li>
          ))}
          {total > hits.length && <li className="muted">…and {total - hits.length} more. Try a longer name.</li>}
        </ul>
      )}

      {/* 2. a whole list at once */}
      <details className="add-games-bulk">
        <summary>Add a list of games</summary>
        <form onSubmit={handleBulk}>
          <textarea
            value={names}
            onChange={(e) => setNames(e.target.value)}
            rows={8}
            placeholder={"One game per line, spelled like on BGG:\nSpirit Island\nBrass: Birmingham\nArcs"}
            aria-label="Game names, one per line"
          />
          <button type="submit" disabled={!!progress || !names.trim()}>
            {progress ?? "Add these games"}
          </button>
        </form>
        <p className="muted">
          Each name is matched exactly. If several games share a name, the most-rated one is used — check the list
          below and fix any wrong ones with search.
        </p>
        {summary && (
          <div className="bulk-summary">
            <p>
              Added <strong>{summary.added.length}</strong>
              {summary.already.length > 0 && <> · already had {summary.already.length}</>}
              {summary.notFound.length > 0 && <> · not found {summary.notFound.length}</>}
            </p>
            {summary.renamed.length > 0 && (
              <p className="muted">Matched as: {summary.renamed.join(" · ")}</p>
            )}
            {summary.notFound.length > 0 && (
              <p className="error-text">
                Not found (left in the box to fix): {summary.notFound.join(", ")}
              </p>
            )}
          </div>
        )}
      </details>

      {message && <p className={`status${message.error ? " error" : ""}`}>{message.text}</p>}

      {/* 3. what's been added by hand (removable) */}
      {manualGames.length > 0 && (
        <>
          <h3 className="add-games-subhead">Added by hand ({manualGames.length})</h3>
          <ul className="chips manual-games">
            {manualGames.map((g) => (
              <li key={g.id} className="chip success">
                <span>{label(g.name, g.yearPublished)}</span>
                <button
                  type="button"
                  className="chip-remove"
                  onClick={() => handleRemove(g.id, g.name)}
                  aria-label={`Remove ${g.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
