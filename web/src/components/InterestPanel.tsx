import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { InterestLevel, ListGame } from "../types";
import { INTEREST_LEVELS, NO_OPINION, interestInfo } from "../interest";
import { Die, dieImage } from "./Die";
import "./InterestPanel.css";

interface Props {
  game: ListGame;
  me: string;
  onSetInterest: (game: ListGame, level: InterestLevel | null) => void;
}

// The slider's stops, left to right: "no opinion", then keenest → least keen (six pips … one pip).
const STOPS = [null, ...INTEREST_LEVELS.map((l) => l.level)] as (InterestLevel | null)[];
const SAVE_DELAY_MS = 400; // save once the slider has stopped moving
/**
 * Under the selected game: "Rate your interest" as a sliding scale (adapted
 * from a CodePen): label on the left, the slider, the chosen level on the right.
 *
 * The slider shows the new level straight away while you drag; it's saved a
 * moment after you stop (or right away if you move on to another game).
 * Everyone's dice are still shown on each card.
 */
export function InterestPanel({ game, me, onSetInterest }: Props) {
  const levelOf = new Map(game.interest.map((i) => [i.username.toLowerCase(), i.level]));
  const saved = levelOf.get(me.toLowerCase()) ?? null;

  // What the slider shows (can be ahead of what's saved while you drag).
  const [draft, setDraft] = useState<InterestLevel | null>(saved);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; level: InterestLevel | null } | null>(null);
  const latest = useRef({ game, onSetInterest });
  latest.current = { game, onSetInterest };

  const flush = () => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    latest.current.onSetInterest(latest.current.game, pending.current.level);
    pending.current = null;
  };
  useEffect(() => flush, []); // leaving this game: save a change that's still waiting

  // Someone else's change (or the 15s refresh) updates the slider, unless you're mid-drag.
  useEffect(() => {
    if (!pending.current) setDraft(saved);
  }, [saved]);

  function handleSlide(stop: number) {
    const level = STOPS[stop];
    setDraft(level);
    if (pending.current) clearTimeout(pending.current.timer);
    if (level === saved) {
      pending.current = null; // back where it started: nothing to save
      return;
    }
    pending.current = { level, timer: setTimeout(flush, SAVE_DELAY_MS) };
  }

  const info = draft === null ? null : interestInfo(draft);
  const shown = info ?? NO_OPINION; // what the handle and the label show

  return (
    <div className="interest-panel">
      <div className="interest-rate" style={{ "--level-color": info?.color ?? "var(--muted)" } as CSSProperties}>
        <div className="interest-rate-heading" id={`rate-${game.id}`}>
          Rate your interest
        </div>

        {/* a line with a die at each stop; the handle is the chosen die */}
        <div className="interest-track">
          <span className="interest-line" aria-hidden />
          <div className="interest-ticks" aria-hidden>
            {STOPS.map((level, i) => {
              const l = level === null ? NO_OPINION : interestInfo(level);
              return (
                <span key={i} className="interest-tick">
                  <Die icon={l.icon} color={l.color} />
                </span>
              );
            })}
          </div>
          <input
            type="range"
            className="interest-slider"
            min={0}
            max={STOPS.length - 1}
            step={1}
            value={STOPS.indexOf(draft)}
            onChange={(e) => handleSlide(Number(e.target.value))}
            aria-labelledby={`rate-${game.id}`}
            aria-valuetext={info ? info.label : NO_OPINION.label}
            title="Drag (or click a die) to choose"
            style={{ "--handle-img": dieImage(shown.icon, shown.color) } as CSSProperties}
          />
        </div>

        <div className="interest-rate-output" aria-hidden>
          {info ? info.label : NO_OPINION.label}
        </div>
      </div>
    </div>
  );
}
