import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { InterestLevel, ListGame, OwnedGame } from "../types";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faThumbsUp } from "@fortawesome/free-solid-svg-icons";
import { interestInfo, showInInterest } from "../interest";
import { InterestPanel } from "./InterestPanel";
import { formatCounts } from "../filterGames";
import { Die } from "./Die";
import "./GameFan.css";

interface Props {
  games: (OwnedGame & Partial<Pick<ListGame, "votes" | "interest">>)[];
  showOwners?: boolean; // (not shown by the fan any more)
  onToggleHidden?: (game: OwnedGame) => void; // Hide / Unhide button (admin only)
  me?: string; // signed-in username, to show whether *you* voted
  onToggleVote?: (game: ListGame) => void; // vote button on each card
  members?: string[]; // everyone who can sign in (not used by the fan any more)
  onSetInterest?: (game: ListGame, level: InterestLevel | null) => void;
}

const HOVER_DELAY_MS = 150; // hovering this long selects a card (sweeping across the fan doesn't)
const FOLLOW_MS = 700; // the card animation (0.55s in GameFan.css) plus a little slack
const FOLLOW_EASE = 0.16; // share of the remaining distance the slider/Hide move each frame (~0.4s glide)
const VERTICAL_FAN = "(max-width: 1023px)"; // must match the phone section of GameFan.css

// Opening animation (once, when the fan first appears): after the page title
// has dropped in, the cards fly in one by one while a "Vote" box shows over
// them; the box fades out once the last card has landed. Passed to CSS as
// variables so GameFan.css uses the same timings.
const INTRO_START_MS = 550; // the page title's animation (index.css) is done by then
const INTRO_STAGGER_MS = 90; // between one card and the next
const INTRO_CARD_MS = 600; // each card's own animation

const bggUrl = (id: number) => `https://boardgamegeek.com/boardgame/${id}`;

function formatPlayers(g: OwnedGame) {
  if (!g.minPlayers) return "?";
  return g.minPlayers === g.maxPlayers ? `${g.minPlayers}` : `${g.minPlayers}–${g.maxPlayers}`;
}

/** "2–5 (3)": player count, then the counts BGG voters say are best, in brackets. */
function formatPlayersAndBest(g: OwnedGame) {
  return g.bestWith.length ? `${formatPlayers(g)} (${formatCounts(g.bestWith)})` : formatPlayers(g);
}

/**
 * Every game in the list visible at once, as a fan of tilted 3D cards
 * (adapted from a CodePen). Same props as GameCarousel, so App can swap them.
 *
 * - hover a card (mouse): it's selected — straightened, zoomed in, the others
 *   blur. It STAYS selected when the mouse leaves, so you can reach the
 *   title and the interest slider below it.
 * - click a card: vote for it (click again to take the vote back). Cards you
 *   voted for sit 42px higher than the rest.
 * - tap a card (touch screens, no hover): the first tap selects it, the next
 *   tap votes
 * - click anywhere else (or press Escape): back to the fan
 * - the title under the fan (a link to BoardGameGeek) sits centered under
 *   the selected card
 *
 * The selection is stored by POSITION, so when a game is hidden and another
 * fills its spot, the new game is selected in its place.
 */
export function GameFan({ games, onToggleHidden, me, onToggleVote, onSetInterest }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  // true during the opening animation; cards added later (e.g. after a Hide) just appear
  const [intro, setIntro] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const rootRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const titleRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const rateRef = useRef<HTMLDivElement>(null); // the interest slider's moving box
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const hoverTarget = useRef<number | null>(null); // the card the hover timer will select
  const lastPointer = useRef<string>("mouse"); // "touch" taps select before they vote

  // If the list got shorter, drop a selection that no longer exists.
  const index = selected !== null && selected < games.length ? selected : null;
  const active = index !== null ? games[index] : null;
  const shown = active ?? games[0]; // what the info area under the fan renders (invisibly when nothing's selected)

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

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

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
      const cover = index !== null ? cardRefs.current[index]?.querySelector(".fan-cover") : null;
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
      const box = rate?.parentElement; // .fan-rate: the slider's lane
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

  // Mouse: resting on a card selects it (after a short pause). Uses pointer
  // MOVE, not just enter, so a mouse that was already over a card (e.g. after
  // a reload) still works. Touch has no hover, so taps select instead.
  function handlePointerMove(e: PointerEvent, i: number) {
    if (e.pointerType !== "mouse" || i === index || hoverTarget.current === i) return;
    clearTimeout(hoverTimer.current);
    hoverTarget.current = i;
    hoverTimer.current = setTimeout(() => {
      hoverTarget.current = null;
      setSelected(i);
    }, HOVER_DELAY_MS);
  }
  function cancelHover() {
    clearTimeout(hoverTimer.current);
    hoverTarget.current = null;
  }

  function handleCardClick(i: number) {
    cancelHover();
    const g = games[i];
    const canVote = !!onToggleVote && !!g.votes;
    // touch has no hover: the first tap selects, so you can see the card before voting
    if (!canVote || (lastPointer.current !== "mouse" && i !== index)) {
      setSelected(i === index ? null : i);
      return;
    }
    setSelected(i);
    onToggleVote(g as ListGame); // clicking a card votes for it (or takes the vote back)
  }

  // Arrow keys move the selection along the fan.
  function handleKeyDown(e: KeyboardEvent) {
    // ← → on the desktop fan, ↑ ↓ on the vertical (phone) fan
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    setSelected(((index ?? (step > 0 ? -1 : 0)) + step + games.length) % games.length);
  }

  return (
    <section id="carousel" className="fan" aria-label="Game list" ref={rootRef}>
      <div className="fan-body">
        <div
          ref={cardsRef}
          className={`fan-cards${index !== null ? " has-selection" : ""}${intro ? " intro" : ""}`}
          onKeyDown={handleKeyDown}
          style={
            {
              "--intro-start": `${INTRO_START_MS}ms`,
              "--intro-stagger": `${INTRO_STAGGER_MS}ms`,
              "--intro-card": `${INTRO_CARD_MS}ms`,
              "--intro-count": games.length,
            } as CSSProperties
          }
        >
          {intro && (
            <div className="fan-intro-vote" aria-hidden>
              <span>Vote</span>
            </div>
          )}
          {games.map((g, i) => {
            const votes = g.votes ?? [];
            const iVoted = !!me && votes.includes(me);
            return (
              <div
                key={g.id}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                className={`fan-card${i === index ? " selected" : ""}${g.hidden ? " is-hidden" : ""}${iVoted ? " my-vote" : ""}`}
                style={{ "--i": i } as CSSProperties} // its place in the opening animation
                onPointerMove={(e) => handlePointerMove(e, i)}
                onPointerDown={(e) => (lastPointer.current = e.pointerType)}
                onPointerLeave={cancelHover}
              >
                {/* The cover: click = vote. A div acting as a button (not a <button>),
                  because it contains a real link (the game's name). */}
                <div
                  role="button"
                  tabIndex={0}
                  className="fan-select"
                  onClick={() => handleCardClick(i)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    handleCardClick(i);
                  }}
                  aria-pressed={onToggleVote && g.votes ? iVoted : i === index}
                  aria-label={
                    onToggleVote && g.votes
                      ? `${iVoted ? "Remove your vote for" : "Vote for"} ${g.name}`
                      : i === index
                        ? `${g.name} (selected): unselect`
                        : `Select ${g.name}`
                  }
                >
                  <span className="fan-cover">
                    {g.image || g.thumbnail ? (
                      <img src={g.image ?? g.thumbnail ?? ""} alt="" draggable={false} />
                    ) : (
                      <span className="fan-placeholder" aria-hidden>
                        🎲
                      </span>
                    )}
                    {/* name (links to BGG), then players (best with) · everyone's interest */}
                    <span className="fan-caption">
                      <a
                        className="fan-name"
                        href={bggUrl(g.id)}
                        target="_blank"
                        rel="noreferrer"
                        tabIndex={i === index ? 0 : -1} // reachable by keyboard on the selected card
                        onClick={(e) => e.stopPropagation()} // opening the link isn't a vote
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {g.name}
                        <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="external-icon" aria-hidden />
                        <span className="visually-hidden"> (opens BoardGameGeek in a new tab)</span>
                      </a>
                      <span className="fan-meta">
                        <span className="fan-stats">👥 {formatPlayersAndBest(g)}</span>
                        {/* everyone's interest at a glance, keenest first */}
                        {(g.interest?.filter((it) => showInInterest(it.username)).length ?? 0) > 0 && (
                          <span className="fan-interest" aria-hidden>
                            {g
                              .interest!.filter((it) => showInInterest(it.username))
                              .map((it) => (
                                <Die
                                  key={it.username}
                                  icon={interestInfo(it.level).icon}
                                  color={interestInfo(it.level).color}
                                  title={`${it.username}: ${interestInfo(it.level).label}`}
                                />
                              ))}
                          </span>
                        )}
                      </span>
                    </span>
                  </span>
                </div>
                {onToggleVote && g.votes && (
                  <button
                    type="button"
                    className={`vote-button${iVoted ? " voted" : ""}${votes.length > 0 ? " has-votes" : ""}`}
                    onClick={() => onToggleVote(g as ListGame)}
                    aria-pressed={iVoted}
                    aria-label={`${iVoted ? "Remove your vote for" : "Vote for"} ${g.name} (${votes.length} vote${votes.length === 1 ? "" : "s"})`}
                    title={votes.length ? `Votes: ${votes.join(", ")}` : "Vote for this game"}
                  >
                    <FontAwesomeIcon icon={faThumbsUp} aria-hidden />
                    {votes.length > 0 && <span className="vote-count">{votes.length}</span>}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Under the selected card: the Hide button (admin only).
          With nothing selected, the first game's is rendered INVISIBLY, so the
          space is always reserved and the page below doesn't jump on hover. */}
        {shown && onToggleHidden && (
          <div className={`fan-info${active ? "" : " is-placeholder"}`} aria-hidden={active ? undefined : true}>
            <div className="fan-title" ref={titleRef}>
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
            </div>
          </div>
        )}

        {/* The interest slider: under the fan on desktop, beside it (rotated) on
          phones; lined up with the selected card (see placeTitle). Invisible
          but still taking its space when nothing is selected. */}
        {shown && onSetInterest && me && shown.interest && (
          <div className={`fan-rate${active ? "" : " is-placeholder"}`} aria-hidden={active ? undefined : true}>
            <div className="fan-rate-follow" ref={rateRef}>
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
