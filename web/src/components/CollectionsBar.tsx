import { useState } from "react";
import { UsernameForm } from "./UsernameForm";
import { userKey, type CollectionEntry } from "../hooks/useCollections";

interface Props {
  usernames: string[];
  entries: Record<string, CollectionEntry>;
  onAdd: (username: string) => void;
  onRemove: (username: string) => void;
  onRefresh: (username: string) => void;
}

/** "2026-11-03T19:21:18Z" -> "5 min ago" */
function timeAgo(iso: string | null | undefined) {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Shows each loaded collection as a removable "chip", plus an
 * "Add collection" button that reveals the username form.
 */
export function CollectionsBar({ usernames, entries, onAdd, onRemove, onRefresh }: Props) {
  // UI-only state lives in the component that uses it.
  const [formOpen, setFormOpen] = useState(false);

  function handleAdd(name: string) {
    onAdd(name);
    setFormOpen(false);
  }

  return (
    <section id="collections-bar" className="collections-bar" aria-label="Collections">
      <ul className="chips">
        {usernames.map((name) => {
          const entry = entries[userKey(name)];
          const busy = entry?.status === "loading" || entry?.refreshing || entry?.data?.syncing;
          const manual = entry?.data?.kind === "manual";
          const title =
            entry?.error ??
            (manual ? "Games added by hand" : entry?.data ? `Last synced with BGG ${timeAgo(entry.data.lastSyncedAt)}` : undefined);
          return (
            <li key={userKey(name)} className={`chip ${entry?.status ?? "loading"}`} title={title}>
              <span>
                {name}
                {entry?.status === "loading" && " …"}
                {entry?.status === "success" && ` (${entry.data!.games.length})`}
                {entry?.status === "error" && " ⚠️"}
              </span>
              {entry?.status !== "loading" && !manual && (
                <button
                  type="button"
                  className={`chip-refresh${busy ? " spinning" : ""}`}
                  onClick={() => onRefresh(name)}
                  disabled={!!busy}
                  aria-label={`Refresh ${name}'s collection from BoardGameGeek`}
                  title="Refresh from BoardGameGeek"
                >
                  ↻
                </button>
              )}
              <button
                type="button"
                className="chip-remove"
                onClick={() => onRemove(name)}
                aria-label={`Remove ${name}'s collection`}
              >
                ×
              </button>
            </li>
          );
        })}

        {!formOpen && (
          <li>
            <button type="button" className="add-button" onClick={() => setFormOpen(true)}>
              + Add collection
            </button>
          </li>
        )}
      </ul>

      {formOpen && (
        <UsernameForm
          existing={usernames}
          onSubmit={handleAdd}
          onCancel={() => setFormOpen(false)}
        />
      )}
    </section>
  );
}
