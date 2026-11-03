import { useState, type FormEvent } from "react";
import { userKey } from "../hooks/useCollections";

interface Props {
  existing?: string[]; // usernames already added, to prevent duplicates
  onSubmit: (username: string) => void;
  onCancel?: () => void;
}

/**
 * A "controlled" input: React state is the single source of truth for its value.
 * The parent only hears about it when the form is submitted.
 */
export function UsernameForm({ existing = [], onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("");

  const trimmed = value.trim();
  const isDuplicate = existing.some((u) => userKey(u) === userKey(trimmed));

  function handleSubmit(e: FormEvent) {
    e.preventDefault(); // stop the browser's full-page form submit
    if (trimmed && !isDuplicate) onSubmit(trimmed);
  }

  return (
    <form className="username-form" onSubmit={handleSubmit}>
      <label htmlFor="username">BGG username</label>
      <div className="row">
        <input
          id="username"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel?.()}
          placeholder="e.g. a friend's BGG username"
          autoComplete="off"
          autoFocus
        />
        <button type="submit" disabled={!trimmed || isDuplicate}>
          Add
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {isDuplicate && <p className="hint">That collection is already added.</p>}
    </form>
  );
}
