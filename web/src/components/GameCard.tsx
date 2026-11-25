import type { CSSProperties } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faThumbsUp } from "@fortawesome/free-solid-svg-icons";
import type { ListGame, OwnedGame } from "../types";
import { interestInfo, showInInterest } from "../interest";
import { formatCounts } from "../filterGames";
import { Die } from "./Die";

/** A game as GameVoteList gets it: votes and interest are there when it's from the shared list. */
export type BoardGame = OwnedGame & Partial<Pick<ListGame, "votes" | "interest">>;

interface Props {
  game: BoardGame;
  index: number; // its place in the fan (drives the opening animation via --i)
  selected: boolean; // this card is open
  me?: string; // signed-in username, to show whether *you* voted
  onSelect: () => void; // click / Enter / Space on the cover
  onToggleVote?: (game: ListGame) => void; // the 👍 button
  cardRef?: (el: HTMLDivElement | null) => void; // GameVoteList measures the cards (see placeTitle)
}

const bggUrl = (id: number) => `https://boardgamegeek.com/boardgame/${id}`;

function formatPlayers(g: OwnedGame) {
  if (!g.minPlayers) return "?";
  return g.minPlayers === g.maxPlayers ? `${g.minPlayers}` : `${g.minPlayers}–${g.maxPlayers}`;
}

/** "2–5 (3)": player count, then the counts BGG voters say are best, in brackets. */
export function formatPlayersAndBest(g: OwnedGame) {
  return g.bestWith.length ? `${formatPlayers(g)} (${formatCounts(g.bestWith)})` : formatPlayers(g);
}

/**
 * One card in the fan: the cover (click to open), the game's name linking to
 * BoardGameGeek, players, everyone's interest dice, and the 👍 vote button.
 *
 * The class names and nesting are relied on by GameVoteList.css (selected / blur /
 * tilt / intro) and by GameVoteList's placeTitle (it measures `.game-vote-list-cover`), so
 * keep them as they are. The Hide button and the interest slider are NOT part
 * of the card: GameVoteList renders them once and lines them up with the open card.
 */
export function GameCard({ game: g, index, selected, me, onSelect, onToggleVote, cardRef }: Props) {
  const votes = g.votes ?? [];
  const iVoted = !!me && votes.includes(me);
  const interest = (g.interest ?? []).filter((it) => showInInterest(it.username));

  return (
    <div
      ref={cardRef}
      className={`game-vote-list-card${selected ? " selected" : ""}${g.hidden ? " is-hidden" : ""}${iVoted ? " my-vote" : ""}`}
      style={{ "--i": index } as CSSProperties} // its place in the opening animation
    >
      {/* The cover: click = select. A div acting as a button (not a <button>),
          because it contains a real link (the game's name). */}
      <div
        role="button"
        tabIndex={0}
        className="game-vote-list-select"
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onSelect();
        }}
        aria-pressed={selected}
        aria-label={selected ? `Close ${g.name}` : `Open ${g.name}`}
      >
        <span className="game-vote-list-cover">
          {g.image || g.thumbnail ? (
            <img src={g.image ?? g.thumbnail ?? ""} alt="" draggable={false} />
          ) : (
            <span className="game-vote-list-placeholder" aria-hidden>
              🎲
            </span>
          )}
          {/* name (links to BGG), then players (best with) · everyone's interest */}
          <span className="game-vote-list-caption">
            {/* Only the open card's name is a link: on a closed card there's no
                href, so clicking the name just opens the card like the rest of it. */}
            <a
              className="game-vote-list-name"
              href={selected ? bggUrl(g.id) : undefined}
              target="_blank"
              rel="noreferrer"
              tabIndex={selected ? 0 : -1} // reachable by keyboard on the selected card
              onClick={selected ? (e) => e.stopPropagation() : undefined} // following the link doesn't close the card
              onKeyDown={(e) => e.stopPropagation()}
            >
              {g.name}
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="external-icon" aria-hidden />
              {selected && <span className="visually-hidden"> (opens BoardGameGeek in a new tab)</span>}
            </a>
            <span className="game-vote-list-meta">
              <span className="game-vote-list-stats">👥 {formatPlayersAndBest(g)}</span>
              {/* everyone's interest at a glance, keenest first */}
              {interest.length > 0 && (
                <span className="game-vote-list-interest" aria-hidden>
                  {interest.map((it) => (
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
          {/* slides out on hover */}
          <span className="vote-label" aria-hidden>
            {iVoted ? "Voted" : "Vote"}
          </span>
          {votes.length > 0 && <span className="vote-count">{votes.length}</span>}
        </button>
      )}
    </div>
  );
}
