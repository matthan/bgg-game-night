import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { OwnedGame } from "../types";
import { formatCounts } from "../filterGames";
import "./GameFan.css";

interface Props {
  games: OwnedGame[];
  showOwners?: boolean;
  onToggleHidden?: (game: OwnedGame) => void; // Hide / Unhide button (admin only)
}

const bggUrl = (id: number) => `https://boardgamegeek.com/boardgame/${id}`;

function formatPlayers(g: OwnedGame) {
  if (!g.minPlayers) return "?";
  return g.minPlayers === g.maxPlayers ? `${g.minPlayers}` : `${g.minPlayers}–${g.maxPlayers}`;
}

function formatTime(g: OwnedGame) {
  if (g.minPlayTime && g.maxPlayTime && g.minPlayTime !== g.maxPlayTime) {
    return `${g.minPlayTime}–${g.maxPlayTime}m`;
  }
  return g.playingTime ? `${g.playingTime}m` : "?";
}

/**
 * Every game in the list visible at once, as a fan of tilted 3D cards
 * (adapted from a CodePen). Same props as GameCarousel, so App can swap them.
 *
 * - hover a card: it widens and straightens a little
 * - click a card: it's selected — straightened, zoomed in, the others blur
 * - click the selected card again: opens its BoardGameGeek page in a new tab
 * - click anywhere else (or press Escape): back to the fan
 *
 * The selection is stored by POSITION, so when a game is hidden and another
 * fills its spot, the new game is selected in its place.
 */
export function GameFan({ games, showOwners = false, onToggleHidden }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  // If the list got shorter, drop a selection that no longer exists.
  const index = selected !== null && selected < games.length ? selected : null;
  const active = index !== null ? games[index] : null;

  // Click outside the fan (and its info line) or press Escape to deselect.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setSelected(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setSelected(null);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (games.length === 0) {
    return <p className="empty">No games match those filters. Try loosening them.</p>;
  }

  function handleCardClick(i: number) {
    if (i === index) window.open(bggUrl(games[i].id), "_blank", "noopener,noreferrer");
    else setSelected(i);
  }

  // Arrow keys move the selection along the fan.
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    setSelected(((index ?? (step > 0 ? -1 : 0)) + step + games.length) % games.length);
  }

  return (
    <section id="carousel" className="fan" aria-label="Game list" ref={rootRef}>
      <div className={`fan-cards${index !== null ? " has-selection" : ""}`} onKeyDown={handleKeyDown}>
        {games.map((g, i) => (
          <button
            key={g.id}
            type="button"
            className={`fan-card${i === index ? " selected" : ""}${g.hidden ? " is-hidden" : ""}`}
            onClick={() => handleCardClick(i)}
            aria-pressed={i === index}
            aria-label={i === index ? `${g.name}: open on BoardGameGeek (new tab)` : `Select ${g.name}`}
          >
            <span className="fan-cover">
              {g.image || g.thumbnail ? (
                <img src={g.image ?? g.thumbnail ?? ""} alt="" draggable={false} />
              ) : (
                <span className="fan-placeholder" aria-hidden>
                  🎲
                </span>
              )}
              {/* same details the slideshow cards showed */}
              <span className="fan-caption">
                <span className="fan-name">{g.name}</span>
                <span className="fan-stats">
                  👥 {formatPlayers(g)} · ⏱ {formatTime(g)}
                  {g.weight ? ` · ⚖ ${g.weight.toFixed(1)}` : ""}
                  {g.bggRating ? ` · ⭐ ${g.bggRating.toFixed(1)}` : ""}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>

      {/* Title line for the selected game (screen readers hear changes). */}
      <div className="carousel-active fan-info" aria-live="polite">
        {active ? (
          <>
            <a href={bggUrl(active.id)} target="_blank" rel="noreferrer">
              {active.name}
              {active.yearPublished ? ` (${active.yearPublished})` : ""}
            </a>
            <span className="muted">
              {active.bestWith.length ? ` · Best with ${formatCounts(active.bestWith)}` : ""}
            </span>
            {onToggleHidden && (
              <button
                type="button"
                className="hide-button"
                onClick={() => onToggleHidden(active)}
                aria-label={`${active.hidden ? "Show" : "Hide"} ${active.name} ${active.hidden ? "in" : "from"} the results`}
                title={active.hidden ? "Show this game in the results again" : "Hide this game from the results (kept in the database)"}
              >
                {active.hidden ? "Unhide" : "Hide"}
              </button>
            )}
            {showOwners && <p className="owners">Owned by {active.owners.join(", ")}</p>}
          </>
        ) : null}
      </div>
    </section>
  );
}
