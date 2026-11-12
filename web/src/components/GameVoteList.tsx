import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { InterestLevel, ListGame, OwnedGame } from "../types";
import { InterestPanel } from "./InterestPanel";
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
  onSetInterest?: (game: ListGame, level: InterestLevel | null) => void;
}

const FOLLOW_MS = 700; // the card animation (0.55s in GameVoteList.css) plus a little slack
const FOLLOW_EASE = 0.16; // share of the remaining distance the slider/Hide move each frame (~0.4s glide)
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
 * - click anywhere else (or press Escape): back to the fan
 * - the game's name on the card links to BoardGameGeek
 *
 * The selection is stored by POSITION, so when a game is hidden and another
 * fills its spot, the new game is selected in its place.
 */
export function GameVoteList({ games, onToggleHidden, onReplace, me, onToggleVote, onSetInterest }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  // true during the opening animation; cards added later (e.g. after a Hide) just appear
  const [intro, setIntro] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const rootRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const titleRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const rateRef = useRef<HTMLDivElement>(null); // the interest slider's moving box

  // If the list got shorter, drop a selection that no longer exists.
  const index = selected !== null && selected < games.length ? selected : null;
  const active = index !== null ? games[index] : null;
  const shown = active ?? games[0]; // what the info area under the fan renders (invisibly when nothing's selected)

  // Click outside the fan (and its info line) or press Escape to deselect.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // composedPath: where the click happened, even if that element has since
      // been removed (e.g. the ‹ › button, which moves to the next card)
      if (rootRef.current && !e.composedPath().includes(rootRef.current)) setSelected(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setSelected(null);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Keep the Hide button and the interest slider lined up with the selected
  // card, but inside the card list:
  // - Hide (admin): centered under the card
  // - slider, desktop: centered under the card, within the row's width
  // - slider, phones (vertical fan): beside the card, rotated, centered on it
  //   vertically, within the column's height
  // While the cards animate this runs every frame, so they glide along with
  // the card. (Written straight to the elements' style: no React re-render.)
  // Where the Hide button and the slider are now (px), so each frame can ease
  // them a fraction of the way toward where they should be. That gives one
  // smooth glide, even when the card they follow is itself moving.
  const pos = useRef<{ title: number | null; rate: number | null; vertical: boolean | null }>({
    title: null,
    rate: null,
    vertical: null,
  });

  /** Move the followers toward their targets; `snap` jumps straight there. Returns true once both have arrived. */
  const placeTitle = useCallback(
    (snap = false) => {
      const root = rootRef.current;
      const cards = cardsRef.current;
      const cover = index !== null ? cardRefs.current[index]?.querySelector(".game-vote-list-cover") : null;
      if (!root || !cards || !cover) return true;
      const c = cover.getBoundingClientRect();
      const list = cards.getBoundingClientRect();
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
      const vertical = window.matchMedia(VERTICAL_FAN).matches;
      if (pos.current.vertical !== vertical) snap = true; // switched layouts (e.g. rotated a tablet)
      pos.current.vertical = vertical;

      // ease `key` toward `target`: a fixed share of the remaining distance per frame
      const ease = (key: "title" | "rate", target: number) => {
        const cur = pos.current[key];
        let next = snap || cur === null ? target : cur + (target - cur) * FOLLOW_EASE;
        if (Math.abs(target - next) < 0.5) next = target;
        pos.current[key] = next;
        return next;
      };
      let done = true;

      const title = titleRef.current;
      if (title) {
        const r = root.getBoundingClientRect();
        const w = title.offsetWidth;
        const target = clamp(c.left + c.width / 2 - r.left - w / 2, 0, r.width - w);
        const x = ease("title", target);
        title.style.transform = `translateX(${x}px)`;
        done &&= x === target;
      }

      const rate = rateRef.current;
      const box = rate?.parentElement; // .game-vote-list-rate: the slider's lane
      if (rate && box) {
        const b = box.getBoundingClientRect();
        if (vertical) {
          const h = rate.offsetHeight;
          const target = clamp(c.top + c.height / 2 - b.top - h / 2, list.top - b.top, list.bottom - b.top - h);
          const y = ease("rate", target);
          rate.style.transform = `translateY(${y}px)`;
          done &&= y === target;
        } else {
          const w = rate.offsetWidth;
          const target = clamp(c.left + c.width / 2 - b.left - w / 2, list.left - b.left, list.right - b.left - w);
          const x = ease("rate", target);
          rate.style.transform = `translateX(${x}px)`;
          done &&= x === target;
        }
      }
      return done;
    },
    [index],
  );

  // When nothing was selected, the followers were invisible: put them straight
  // in place (they fade in there) instead of gliding from wherever they were.
  const wasVisible = useRef(false);

  useLayoutEffect(() => {
    let frame = 0;
    const until = performance.now() + FOLLOW_MS; // the card is still moving until then
    const follow = (snap = false) => {
      const arrived = placeTitle(snap || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      if (performance.now() < until || !arrived) frame = requestAnimationFrame(() => follow());
    };
    follow(!wasVisible.current);
    wasVisible.current = active !== null;
    const onResize = () => placeTitle(true);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [placeTitle, active?.id, active?.votes?.length]);

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

  // Arrow keys move the selection along the fan.
  function handleKeyDown(e: KeyboardEvent) {
    // ← → on the desktop, ↑ ↓ on the vertical mobile
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    setSelected(((index ?? (step > 0 ? -1 : 0)) + step + games.length) % games.length);
  }

  return (
    <section id="game-vote-list" className="game-vote-list" aria-label="Game list" ref={rootRef}>
      <div className="game-vote-list-body">
        <div
          ref={cardsRef}
          className={`game-vote-list-cards${index !== null ? " has-selection" : ""}${intro ? " intro" : ""}`}
          onKeyDown={handleKeyDown}
          style={
            {
              "--intro-start": `${INTRO_START_MS}ms`,
              "--intro-stagger": `${INTRO_STAGGER_MS}ms`,
              "--intro-card": `${INTRO_CARD_MS}ms`,
              "--intro-count": games.length, // also used by the phone layout
            } as CSSProperties
          }
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
              onPrev={i > 0 ? () => setSelected(i - 1) : undefined} // no ‹ on the first game
              onNext={i < games.length - 1 ? () => setSelected(i + 1) : undefined} // no › on the last
            />
          ))}
        </div>

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

        {/* The interest slider: under the game list on desktop, beside it (rotated) on
          phones; lined up with the selected card (see placeTitle). With nothing
          selected the slider is invisible (still taking its space) and a
          placeholder in its place says what to do. */}
        {shown && onSetInterest && me && shown.interest && (
          <div className={`game-vote-list-rate${active ? "" : " is-placeholder"}`}>
            <div className="game-vote-list-rate-hint" aria-hidden={active ? true : undefined}>
              <span className="hint-hover">Select a game to rate your interest</span>
              <span className="hint-touch">Tap a game to rate your interest</span>
            </div>
            <div className="game-vote-list-rate-follow" ref={rateRef} aria-hidden={active ? undefined : true}>
              <InterestPanel
                key={shown.id} // a fresh slider for each game
                game={shown as ListGame}
                me={me}
                onSetInterest={onSetInterest}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
