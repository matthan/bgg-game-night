import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronLeft, faChevronRight } from "@fortawesome/free-solid-svg-icons";
import type { ListGame, OwnedGame } from "../types";
import { GameCard, type BoardGame } from "./GameCard";
import "./GameVoteList.css";

interface Props {
  games: BoardGame[];
  showOwners?: boolean; // (not shown by the fan any more)
  onToggleHidden?: (game: OwnedGame) => void; // Hide / Unhide button (admin only)
  onReplace?: (game: OwnedGame) => void; // Replace button: swap for another match, not hidden (admin only)
  me?: string; // signed-in username, to show whether *you* voted
  onToggleVote?: (game: ListGame) => void; // vote button on each card
  members?: string[]; // everyone who can sign in (not used by the fan any more)
}

const FOLLOW_MS = 700; // the card animation (0.55s in GameVoteList.css) plus a little slack
const FOLLOW_EASE = 0.16; // share of the remaining distance the arrows / Hide buttons move each frame (~0.4s glide)
const ARROW_GAP = 12; // between the ‹ › arrows and the open card (or the ends of the list)
const VERTICAL_FAN = "(max-width: 1023px)"; // must match the phone section of GameVoteList.css

// Opening animation (once, when the fan first appears): after the page title
// has dropped in, the cards fly in one by one while a "Vote" box shows over
// them; the box fades out once the last card has landed. Passed to CSS as
// variables so GameVoteList.css uses the same timings.
const INTRO_START_MS = 550; // the page title's animation (index.css) is done by then
const INTRO_STAGGER_MS = 110; // between one card and the next
const INTRO_CARD_MS = 750; // each card's own animation

/**
 * Every game in the list visible at once
 *
 * - click / tap a card: it opens (selected) — straightened, zoomed in, the
 *   others blur; click it again to close it
 * - vote with the 👍 button only (hover it: "Vote" slides out). Cards you
 *   voted for sit higher (desktop) or further right (phones) than the rest.
 * - ‹ › beside the open card (left / right on desktop, above / below on
 *   phones) step to the previous / next game. They stay level with each other:
 *   on one line across the middle of the fan (desktop) or down the middle of
 *   the list (phones), whatever is open. Hidden with nothing open.
 * - click anywhere outside the open card (or press Escape): back to the fan.
 *   Clicking another card opens that one instead.
 * - the open card's name links to BoardGameGeek (closed cards: no link)
 * - interest is rated on the Rate games page; the cards just show everyone's dice
 *
 * The selection is stored by POSITION, so when a game is hidden and another
 * fills its spot, the new game is selected in its place.
 */
export function GameVoteList({ games, onToggleHidden, onReplace, me, onToggleVote }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  // true during the opening animation; cards added later (e.g. after a Hide) just appear
  const [intro, setIntro] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const rootRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const titleRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  // If the list got shorter, drop a selection that no longer exists.
  const index = selected !== null && selected < games.length ? selected : null;
  const active = index !== null ? games[index] : null;
  const shown = active ?? games[0]; // what the info area under the fan renders (invisibly when nothing's selected)

  // Click anywhere outside the cards (including the gaps around them) or press
  // Escape to deselect. Clicks on a card are left to the card: its 👍 button,
  // or another card (which opens instead). The ‹ › arrows and the Hide /
  // Replace buttons under the open card keep a card open too.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // composedPath: where the click happened, even if that element has since
      // been removed (e.g. the ‹ › button, which moves to the next card)
      const onCardOrButtons = e
        .composedPath()
        .some(
          (el) =>
            el instanceof Element &&
            (el.classList.contains("game-vote-list-card") ||
              el.classList.contains("game-vote-list-info") ||
              el.classList.contains("card-arrow")),
        );
      if (!onCardOrButtons) setSelected(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setSelected(null);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Things that follow the open card, written straight to their style (no
  // React re-render), every frame while the cards animate so they glide along:
  // - Hide / Replace (admin): centered under the open card, within the list
  // - ‹ ›: beside the open card. Only the position ALONG the list follows it;
  //   across the list they stay on one fixed line (the middle of the fan's row
  //   on desktop, the middle of the list's column on phones), so the two
  //   arrows are always level with each other. They track the card exactly
  //   (no easing), and are only there while a card is open.
  // `pos` is where each one is now (px), so each frame can ease it a fraction
  // of the way toward its target: one smooth glide, even while the card it
  // follows is itself moving.
  type Key = "title" | "prevX" | "prevY" | "nextX" | "nextY";
  const pos = useRef<Record<Key, number | null> & { vertical: boolean | null }>({
    title: null,
    prevX: null,
    prevY: null,
    nextX: null,
    nextY: null,
    vertical: null,
  });

  /** Move the followers toward their targets; `snap` jumps straight there
   * (`snapTitle`: just the Hide buttons). Returns true once all have arrived. */
  const placeFollowers = useCallback(
    (snap = false, snapTitle = false) => {
      const root = rootRef.current;
      const body = bodyRef.current;
      const cards = cardsRef.current;
      if (!root || !body || !cards) return true;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
      const vertical = window.matchMedia(VERTICAL_FAN).matches;
      if (pos.current.vertical !== vertical) snap = true; // switched layouts (e.g. rotated a tablet)
      pos.current.vertical = vertical;

      // ease `key` toward `target`: a fixed share of the remaining distance per frame
      let done = true;
      const ease = (key: Key, target: number, jump = snap) => {
        const cur = pos.current[key];
        let next = jump || cur === null ? target : cur + (target - cur) * FOLLOW_EASE;
        if (Math.abs(target - next) < 0.5) next = target;
        pos.current[key] = next;
        done &&= next === target;
        return next;
      };

      const coverOf = (i: number) => cardRefs.current[i]?.querySelector(".game-vote-list-cover")?.getBoundingClientRect();
      const c = index !== null ? coverOf(index) : undefined;

      const title = titleRef.current;
      if (title && c) {
        const r = root.getBoundingClientRect();
        const w = title.offsetWidth;
        const x = ease("title", clamp(c.left + c.width / 2 - r.left - w / 2, 0, r.width - w), snap || snapTitle);
        title.style.transform = `translateX(${x}px)`;
      }

      const prev = prevRef.current;
      const next = nextRef.current;
      if (prev && next && c) {
        const b = body.getBoundingClientRect();
        const list = cards.getBoundingClientRect();
        const w = prev.offsetWidth; // wider on phones (a pill)
        const h = prev.offsetHeight;
        let p: [number, number];
        let n: [number, number];
        if (vertical) {
          // one column down the middle of the list; above / below the open card
          const x = list.left + list.width / 2 - w / 2 - b.left;
          p = [x, c.top - b.top - ARROW_GAP - h];
          n = [x, c.bottom - b.top + ARROW_GAP];
        } else {
          // one row across the middle of the fan; left / right of the open card
          const y = list.top + list.height / 2 - h / 2 - b.top;
          p = [clamp(c.left - b.left - ARROW_GAP - w, 0, b.width - w), y];
          n = [clamp(c.right - b.left + ARROW_GAP, 0, b.width - w), y];
        }
        // straight to the target every frame: they stay right beside the card as it moves
        prev.style.translate = `${ease("prevX", p[0], true)}px ${ease("prevY", p[1], true)}px`;
        next.style.translate = `${ease("nextX", n[0], true)}px ${ease("nextY", n[1], true)}px`;
      }
      return done;
    },
    [index],
  );

  // When nothing was selected, the Hide buttons were invisible: put them
  // straight in place (they fade in there) instead of gliding from wherever
  // they were.
  const wasVisible = useRef(false);

  useLayoutEffect(() => {
    let frame = 0;
    const until = performance.now() + FOLLOW_MS; // the cards are still moving until then
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const follow = (snapTitle = false) => {
      const arrived = placeFollowers(reduced, snapTitle);
      if (performance.now() < until || !arrived) frame = requestAnimationFrame(() => follow());
    };
    follow(!wasVisible.current);
    wasVisible.current = active !== null;
    const onResize = () => placeFollowers(true);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [placeFollowers, intro, active?.id, active?.votes?.length]);

  // End the opening animation once the last card and the "Vote" box are done.
  const introMs = INTRO_START_MS + Math.max(games.length - 1, 0) * INTRO_STAGGER_MS + INTRO_CARD_MS + 500;
  useEffect(() => {
    if (!intro) return;
    const t = setTimeout(() => setIntro(false), introMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (games.length === 0) {
    return <p className="empty">No games match those filters. Try loosening them.</p>;
  }

  // Clicking / tapping a card opens (selects) it; clicking it again closes it.
  // Voting is the 👍 button only. Clicking outside the fan or Escape also closes.
  function handleCardClick(i: number) {
    setSelected(i === index ? null : i);
  }

  // The ‹ › arrows (only there while a card is open): one step along the
  // list, stopping at the ends.
  function step(by: 1 | -1) {
    if (index !== null) setSelected(Math.min(Math.max(index + by, 0), games.length - 1));
  }

  // Arrow keys move the selection along the fan.
  function handleKeyDown(e: KeyboardEvent) {
    // ← → on the desktop, ↑ ↓ on the vertical mobile
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    setSelected(((index ?? (dir > 0 ? -1 : 0)) + dir + games.length) % games.length);
  }

  return (
    <section id="game-vote-list" className="game-vote-list" aria-label="Game list" ref={rootRef}>
      <div
        ref={bodyRef}
        className="game-vote-list-body"
        style={
          {
            "--intro-start": `${INTRO_START_MS}ms`,
            "--intro-stagger": `${INTRO_STAGGER_MS}ms`,
            "--intro-card": `${INTRO_CARD_MS}ms`,
            "--intro-count": games.length, // also used by the phone layout and the ‹ › arrows
          } as CSSProperties
        }
      >
        {active && !intro && (
          <button
            ref={prevRef}
            type="button"
            className="card-arrow prev"
            onClick={() => step(-1)}
            disabled={index === 0}
            aria-label="Previous game"
            title="Previous game"
          >
            <FontAwesomeIcon icon={faChevronLeft} aria-hidden />
          </button>
        )}
        <div
          ref={cardsRef}
          className={`game-vote-list-cards${index !== null ? " has-selection" : ""}${intro ? " intro" : ""}`}
          onKeyDown={handleKeyDown}
        >
          {intro && (
            <div className="game-vote-list-intro-vote" aria-hidden>
              <span>Vote</span>
            </div>
          )}
          {games.map((g, i) => (
            <GameCard
              key={g.id}
              game={g}
              index={i}
              selected={i === index}
              me={me}
              onSelect={() => handleCardClick(i)}
              onToggleVote={onToggleVote}
              cardRef={(el) => {
                cardRefs.current[i] = el;
              }}
            />
          ))}
        </div>
        {/* ‹ › only while a card is open (and the opening animation is over) */}
        {active && !intro && (
          <button
            ref={nextRef}
            type="button"
            className="card-arrow next"
            onClick={() => step(1)}
            disabled={index === games.length - 1}
            aria-label="Next game"
            title="Next game"
          >
            <FontAwesomeIcon icon={faChevronRight} aria-hidden />
          </button>
        )}

        {/* Under the selected card: Hide and Replace (admin only).
          With nothing selected, the first game's is rendered INVISIBLY, so the
          space is always reserved and the page below doesn't jump on hover. */}
        {shown && onToggleHidden && (
          <div
            className={`game-vote-list-info${active ? "" : " is-placeholder"}`}
            aria-hidden={active ? undefined : true}
          >
            <div className="game-vote-list-title" ref={titleRef}>
              <button
                type="button"
                className="hide-button"
                onClick={() => onToggleHidden(shown)}
                aria-label={`${shown.hidden ? "Show" : "Hide"} ${shown.name} ${shown.hidden ? "in" : "from"} the results`}
                title={
                  shown.hidden
                    ? "Show this game in the results again"
                    : "Hide this game from the results (kept in the database)"
                }
              >
                {shown.hidden ? "Unhide" : "Hide"}
              </button>
              {onReplace && !shown.hidden && (
                <button
                  type="button"
                  className="hide-button replace-button"
                  onClick={() => onReplace(shown)}
                  aria-label={`Replace ${shown.name} with another random match`}
                  title="Swap this game for another random match (it isn't hidden, so it can come up again)"
                >
                  Replace
                </button>
              )}
            </div>
          </div>
        )}

      </div>
    </section>
  );
}
