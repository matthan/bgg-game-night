import type { FilterState, WeightClass } from "../types";
import { WEIGHT_CLASSES } from "../filterGames";

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
  const set = <K extends keyof FilterState>(key: K, v: FilterState[K]) =>
    onChange({ ...value, [key]: v });

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

      <label>
        Time available
        <select
          value={value.maxTime ?? ""}
          onChange={(e) => set("maxTime", e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Any</option>
          <option value="20">≤ 20 min</option>
          <option value="45">≤ 45 min</option>
          <option value="60">≤ 1 hour</option>
          <option value="90">≤ 1.5 hours</option>
          <option value="120">≤ 2 hours</option>
        </select>
      </label>

      <label>
        Weight
        <select
          value={value.weight ?? ""}
          onChange={(e) => set("weight", (e.target.value || null) as WeightClass | null)}
        >
          <option value="">Any</option>
          {WEIGHT_CLASSES.map((c, i) => {
            const from = WEIGHT_CLASSES[i - 1]?.below;
            const range =
              from === undefined ? `under ${c.below.toFixed(1)}`
              : c.below === Infinity ? `${from.toFixed(1)} and up`
              : `${from.toFixed(1)}–${c.below.toFixed(1)}`;
            return (
              <option key={c.id} value={c.id}>
                {c.label} ({range})
              </option>
            );
          })}
        </select>
      </label>
    </fieldset>
  );
}
