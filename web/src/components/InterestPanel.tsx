import type { CSSProperties } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { InterestLevel, ListGame } from "../types";
import { INTEREST_LEVELS, NO_OPINION, interestInfo, showInInterest } from "../interest";
import "./InterestPanel.css";

interface Props {
  game: ListGame;
  members: string[]; // everyone who can sign in
  me: string;
  onSetInterest: (game: ListGame, level: InterestLevel | null) => void;
}

/**
 * Under the selected game: pick YOUR interest level (click it again to go back
 * to "no opinion"), and see everyone's level for this game.
 */
export function InterestPanel({ game, members, me, onSetInterest }: Props) {
  const levelOf = new Map(game.interest.map((i) => [i.username.toLowerCase(), i.level]));
  const mine = levelOf.get(me.toLowerCase()) ?? null;

  // You first, then everyone else alphabetically.
  // (accounts like "guest" are left out — except to themselves)
  const people = [me, ...members.filter((m) => m.toLowerCase() !== me.toLowerCase() && showInInterest(m))];

  return (
    <div className="interest-panel">
      <div className="interest-choices" role="group" aria-label={`Your interest in ${game.name}`}>
        <span className="interest-heading">Your interest</span>
        {INTEREST_LEVELS.map((l) => (
          <button
            key={l.level}
            type="button"
            className={`interest-choice${mine === l.level ? " chosen" : ""}`}
            style={{ "--level-color": l.color } as CSSProperties}
            aria-pressed={mine === l.level}
            title={mine === l.level ? "Click again to clear (no opinion)" : undefined}
            onClick={() => onSetInterest(game, mine === l.level ? null : l.level)}
          >
            <FontAwesomeIcon icon={l.icon} className="interest-die" aria-hidden /> {l.label}
          </button>
        ))}
      </div>

      <ul className="interest-everyone" aria-label={`Everyone's interest in ${game.name}`}>
        {people.map((name) => {
          const level = levelOf.get(name.toLowerCase());
          const info = level === undefined ? null : interestInfo(level);
          return (
            <li
              key={name}
              className={info ? "" : "no-opinion"}
              style={info ? ({ "--level-color": info.color } as CSSProperties) : undefined}
            >
              <strong>{name.toLowerCase() === me.toLowerCase() ? `${name} (you)` : name}</strong>{" "}
              {info ? (
                <FontAwesomeIcon icon={info.icon} className="interest-die" aria-hidden />
              ) : (
                <span aria-hidden>{NO_OPINION.symbol}</span>
              )}{" "}
              {info ? info.label : NO_OPINION.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
