import {
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
  const rootRef = useRef<HTMLElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const titleRef = useRef<HTMLDivElement>(null);
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

  // Keep the title centered under the selected card's cover (inside the fan's
  // width). While the cards animate it's re-measured every frame, so the title
  // glides along with its card instead of jumping when the animation ends.
  // (Written straight to the element's style: no React re-render per frame.)
  const placeTitle = useCallback(() => {
    const root = rootRef.current;
    const cover = index !== null ? cardRefs.current[index]?.querySelector(".fan-cover") : null;
    const title = titleRef.current;
    if (!root || !cover || !title) return;
    const r = root.getBoundingClientRect();
    const c = cover.getBoundingClientRect();
    const w = title.offsetWidth;
    const left = Math.max(0, Math.min(c.left + c.width / 2 - r.left - w / 2, r.width - w));
    title.style.transform = `translateX(${left}px)`;
  }, [index]);

  useLayoutEffect(() => {
    let frame = 0;
    const until = performance.now() + FOLLOW_MS;
    const follow = () => {
      placeTitle();
      if (performance.now() < until) frame = requestAnimationFrame(follow);
    };
    follow();
    window.addEventListener("resize", placeTitle);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", placeTitle);
    };
  }, [placeTitle, active?.id, active?.votes?.length]);

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
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    setSelected(((index ?? (step > 0 ? -1 : 0)) + step + games.length) % games.length);
  }

  return (
    <section id="carousel" className="fan" aria-label="Game list" ref={rootRef}>
      <div className={`fan-cards${index !== null ? " has-selection" : ""}`} onKeyDown={handleKeyDown}>
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

      {/* Under the selected card: the Hide button (admin) and the interest slider.
          With nothing selected, the first game's is rendered INVISIBLY, so the
          space is always reserved and the page below doesn't jump on hover. */}
      <div
        className={`carousel-active fan-info${active ? "" : " is-placeholder"}`}
        aria-live="polite"
        aria-hidden={active ? undefined : true}
      >
        {shown && (
          <>
            {/* admin only: Hide, centered under the selected card */}
            {onToggleHidden && (
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
            )}
            {onSetInterest && me && shown.interest && (
              <InterestPanel
                key={shown.id} // a fresh slider for each game
                game={shown as ListGame}
                me={me}
                onSetInterest={onSetInterest}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
