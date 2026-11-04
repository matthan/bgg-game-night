import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { OwnedGame } from "../types";
import { formatCounts } from "../filterGames";

gsap.registerPlugin(useGSAP);

interface Props {
  games: OwnedGame[];
  highlightId?: number;
  showOwners?: boolean;
  onToggleHidden?: (game: OwnedGame) => void; // Hide / Unhide button
  me?: string; // voting isn't shown in the slideshow (see GameFan)
  onToggleVote?: (game: never) => void;
}

/**
 * Infinite "seamless loop" card carousel, adapted from GreenSock's CodePen demo.
 *
 * The idea:
 * 1. Build one long timeline (rawSequence) where every card slides from right
 *    to left, growing as it nears the center and shrinking/fading after.
 *    Cards start `spacing` seconds apart, so they follow each other in a line.
 * 2. Add extra copies of the first/last animations so the ends overlap.
 * 3. A second timeline (seamlessLoop) scrubs rawSequence's playhead through the
 *    middle section and repeats forever, so the line never runs out.
 * 4. Prev/Next move the playhead by one `spacing` step (one card).
 *
 * Differences from the CodePen: no ScrollTrigger (it would hijack page
 * scrolling); we drive it with buttons, arrow keys and swipes instead.
 */
export function GameCarousel({ games, highlightId, showOwners = false, onToggleHidden }: Props) {
  const galleryRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<(delta: number) => void>(() => {});
  const dragStartX = useRef<number | null>(null);
  const justSwiped = useRef(false); // a swipe ends with a click; this blocks that click
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(0); // read when the loop is rebuilt, to keep your place
  activeRef.current = activeIndex;
  const narrow = useMediaQuery(NARROW_SCREEN); // phones: cards sit closer together

  const count = games.length;
  // Each card's pass lasts 1s, so cards must be >= 1/count apart or a card
  // would need to be in two places at once. With 10+ cards this is 0.1 like the demo.
  const spacing = Math.max(0.1, 1 / Math.max(count, 1));
  const idsKey = games.map((g) => g.id).join(",");

  // useGSAP is like useEffect, but automatically reverts every animation
  // created inside it when the component unmounts or the dependencies change.
  useGSAP(
    () => {
      if (count === 0) return;
      const cards = gsap.utils.toArray<HTMLElement>(".carousel-card", galleryRef.current);
      const loop = buildSeamlessLoop(cards, spacing, narrow ? SLOT_WIDTH_NARROW : SLOT_WIDTH);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // Start far from zero so stepping backwards never hits a negative time.
      // When the games change (e.g. one was hidden), stay at the same position:
      // the next game slides into the front spot instead of jumping to the start.
      let step = count * 1000 + Math.min(activeRef.current, count - 1);
      loop.totalTime(step * spacing);

      // One reusable tween that eases the loop's playhead to a target time.
      const scrub = gsap.to(loop, {
        totalTime: step * spacing,
        duration: reduceMotion ? 0 : 0.5,
        ease: "power3",
        paused: true,
      });

      stepRef.current = (delta: number) => {
        step += delta;
        scrub.vars.totalTime = step * spacing;
        scrub.invalidate().restart();
        setActiveIndex(((step % count) + count) % count);
      };
      setActiveIndex(step % count);

      // Gentle fade-in of each card's contents (the cards' own opacity belongs to the loop).
      gsap.to(".carousel-card > *", { opacity: 1, duration: 0.4, delay: 0.1 });
    },
    { scope: galleryRef, dependencies: [idsKey, spacing, narrow], revertOnUpdate: true },
  );

  if (count === 0) {
    return <p className="empty">No games match those filters. Try loosening them.</p>;
  }

  // The list can shrink before the loop rebuilds, so never index past the end.
  const active = games[Math.min(activeIndex, count - 1)];

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight") stepRef.current(1);
    if (e.key === "ArrowLeft") stepRef.current(-1);
  }

  // Simple swipe: drag more than 40px left/right to move one card.
  function handlePointerDown(e: PointerEvent) {
    dragStartX.current = e.clientX;
  }
  function handlePointerUp(e: PointerEvent) {
    if (dragStartX.current === null) return;
    const dx = e.clientX - dragStartX.current;
    dragStartX.current = null;
    if (Math.abs(dx) > 40) {
      justSwiped.current = true;
      stepRef.current(dx < 0 ? 1 : -1);
    }
  }
  // Clicking a cover: the front one opens its BGG page (the link's normal
  // behaviour); one on the right moves Next, one on the left moves Prev.
  function handleCardClick(e: MouseEvent, index: number) {
    if (e.defaultPrevented) return; // it was a swipe
    const front = Math.min(activeIndex, count - 1);
    if (index === front) return; // let the link open in a new tab
    e.preventDefault();
    // How many slots away is it? Cards to the right are the upcoming ones.
    let offset = (((index - front) % count) + count) % count;
    if (offset > count / 2) offset -= count;
    stepRef.current(offset > 0 ? 1 : -1);
  }

  function handleClickCapture(e: MouseEvent) {
    if (justSwiped.current) {
      e.preventDefault(); // it was a swipe, not a click on a cover
      justSwiped.current = false;
    }
  }

  return (
    <section id="carousel" className="carousel" aria-roledescription="carousel" aria-label="Game list">
      <div
        ref={galleryRef}
        className="carousel-gallery"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => (dragStartX.current = null)}
        onClickCapture={handleClickCapture}
      >
        <ul className="carousel-cards">
          {games.map((g, i) => (
            <li
              key={g.id}
              className={`carousel-card${g.id === highlightId ? " highlighted" : ""}${g.hidden ? " is-hidden" : ""}`}
              aria-hidden={g.id !== active.id}
            >
              <a
                className="carousel-link"
                href={`https://boardgamegeek.com/boardgame/${g.id}`}
                target="_blank"
                rel="noopener noreferrer"
                draggable={false}
                tabIndex={g.id === active.id ? 0 : -1} // only the front card is in the tab order
                aria-label={`${g.name} on BoardGameGeek (opens in a new tab)`}
                onClick={(e) => handleCardClick(e, i)}
              >
                {g.image || g.thumbnail ? (
                  <img src={g.image ?? g.thumbnail ?? ""} alt="" draggable={false} />
                ) : (
                  <div className="carousel-placeholder" aria-hidden>
                    🎲
                  </div>
                )}
                <div className="carousel-caption">
                  <h3>{g.name}</h3>
                  <p>
                    👥 {formatPlayers(g)} · ⏱ {formatTime(g)}
                    {g.weight ? ` · ⚖ ${g.weight.toFixed(1)}` : ""}
                    {g.bggRating ? ` · ⭐ ${g.bggRating.toFixed(1)}` : ""}
                  </p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </div>

      {/* Screen readers hear which game is in front after each move. */}
      <div className="carousel-active" aria-live="polite">
        <a href={`https://boardgamegeek.com/boardgame/${active.id}`} target="_blank" rel="noreferrer">
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
      </div>

      <div className="carousel-actions">
        <button type="button" className="secondary" onClick={() => stepRef.current(-1)} aria-label="Previous game">
          ← Prev
        </button>
        <button type="button" className="secondary" onClick={() => stepRef.current(1)} aria-label="Next game">
          Next →
        </button>
      </div>
    </section>
  );
}

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

/** Distance between neighbouring cards, as a % of a card's width (they overlap a little). */
const SLOT_WIDTH = 72;
const SLOT_WIDTH_NARROW = 55; // tighter on phones so five still fit
const NARROW_SCREEN = "(max-width: 640px)"; // keep in sync with the @media rule in index.css

/** true while the media query matches; updates when the window is resized. */
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
/** Fully visible cards on each side of the center card (2 → five on screen). */
const VISIBLE_EACH_SIDE = 2;

/**
 * Based on the GreenSock demo, with the loop math reworked so that one lap of
 * `seamlessLoop` is exactly one trip through the cards (count × spacing).
 * That makes "move one card" = "move the playhead by `spacing`" for ANY
 * number of games, and card 0 is in front at the start.
 */
function buildSeamlessLoop(items: HTMLElement[], spacing: number, slotWidth: number) {
  const count = items.length;
  const lap = count * spacing; // one full trip through all the cards
  // Each pass across the screen lasts 1s, so at any moment up to 1/spacing
  // passes are visible. Add that many extra passes on each side (plus one).
  const pad = Math.ceil(1 / spacing) + 1;
  const startIndex = Math.ceil(pad / count) * count; // a multiple of count → card 0 in front
  const startTime = startIndex * spacing + 0.5; // +0.5 = middle of a pass = center of screen
  const total = startIndex + count + pad; // passes needed to cover one full lap

  const rawSequence = gsap.timeline({ paused: true }); // all the "real" animations
  const seamlessLoop = gsap.timeline({ paused: true, repeat: -1 }); // scrubs rawSequence forever

  // How a card looks `k` slots away from the center. The center card is full
  // size; the two on each side stay fully visible at 85% and 70%; further
  // out they fade away. (`half` = slots from the center to the end of a pass.)
  const half = 0.5 / spacing;
  const look = (k: number) => ({
    scale: Math.max(0.55, 1 - 0.15 * k),
    opacity: k >= Math.min(VISIBLE_EACH_SIDE + 1, half) ? 0 : 1,
    zIndex: 100 - 10 * k, // nearer the center = on top
  });

  // Keyframes along one 1s pass: right edge (0%) → center (50%) → left edge (100%).
  const ks = [...new Set([half, 3, 2, 1, 0].filter((k) => k <= half))].sort((a, b) => b - a);
  const keyframes: Record<string, gsap.TweenVars> = {};
  for (const k of ks) keyframes[`${(0.5 - k * spacing) * 100}%`] = look(k);
  for (const k of [...ks].reverse()) keyframes[`${(0.5 + k * spacing) * 100}%`] = look(k);

  const xEdge = slotWidth * half; // xPercent at either end of a pass
  gsap.set(items, { xPercent: xEdge, ...look(half) });

  for (let i = 0; i < total; i++) {
    const item = items[i % count];
    const time = i * spacing;
    rawSequence
      .to(
        item,
        { keyframes: { ...keyframes, easeEach: "none" }, duration: 1, snap: "zIndex", immediateRender: false },
        time,
      )
      .fromTo(item, { xPercent: xEdge }, { xPercent: -xEdge, duration: 1, ease: "none", immediateRender: false }, time);
  }

  // After one lap every card has moved exactly `count` slots, so the end of the
  // lap looks identical to its start — repeating it is seamless.
  rawSequence.time(startTime);
  seamlessLoop.fromTo(
    rawSequence,
    { time: startTime },
    { time: startTime + lap, duration: lap, ease: "none", immediateRender: false },
  );
  return seamlessLoop;
}
