import type { FilterState, InterestBoost } from "../types";

const BOOSTS: { id: InterestBoost; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Pure random: interest doesn't matter" },
  { id: "gentle", label: "Gentle", hint: "Games people are keen on come up more often" },
  { id: "strong", label: "Strong", hint: "Twice the effect: favourites much more likely, disliked games rare" },
];

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
  disabled?: boolean; // read-only view (non-admins see the saved list's filters)
}

/**
 * "Lifting state up": Filters doesn't own its state. The parent (App) does,
 * and passes it down along with a callback. That way App can use the same
 * filter values to compute the visible list.
 */
export function Filters({ value, onChange, disabled = false }: Props) {
  // Helper: copy the current filters and change one field.
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]) => onChange({ ...value, [key]: v });

  return (
    <fieldset id="filters" className="filters" disabled={disabled}>
      <legend>Find a game…</legend>

      <label>
        Player Count
        <select
          value={value.players ?? ""}
          onChange={(e) =>
            e.target.value
              ? set("players", Number(e.target.value))
              : // no player count: the community-rating boxes no longer apply, so untick them
                onChange({ ...value, players: null, bestWith: false, recommendedWith: false })
          }
        >
          <option value="">Any</option>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      {/* Uses BGG's community poll; only meaningful once a player count is chosen. */}
      <div className="filter-group" role="group" aria-label="Community rating">
        <label className="check">
          <input
            type="checkbox"
            checked={value.bestWith}
            disabled={value.players === null}
            onChange={(e) => set("bestWith", e.target.checked)}
          />
          Best with{value.players !== null ? ` ${value.players}` : ""}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.recommendedWith}
            disabled={value.players === null}
            onChange={(e) => set("recommendedWith", e.target.checked)}
          />
          Recommended for{value.players !== null ? ` ${value.players}` : ""}
        </label>
        {!disabled && value.players === null && <span className="hint">Choose a player count first</span>}
      </div>

      {/* Favour games people are keen on (their average "Rate your interest"). */}
      <div className="filter-group interest-boost" role="radiogroup" aria-label="Favour well-liked games">
        <span className="filter-label">Favour well-liked games</span>
        <div className="segmented">
          {BOOSTS.map((b) => (
            <label key={b.id} className={value.interestBoost === b.id ? "on" : ""} title={b.hint}>
              <input
                type="radio"
                name="interest-boost"
                value={b.id}
                checked={value.interestBoost === b.id}
                onChange={() => set("interestBoost", b.id)}
              />
              {b.label}
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
