import { useEffect, useState, type FormEvent } from "react";
import { createAccount, deleteAccount, listAccounts, resetPassword } from "../api";
import type { Account } from "../types";

const MIN_PASSWORD = 8; // the API enforces this too

/** Admin only (matthan): list, create, reset passwords, delete accounts. */
export function AccountsPanel({ me, onClose }: { me: Account; onClose: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const reload = () =>
    listAccounts()
      .then(setAccounts)
      .catch((e) => setMessage({ text: e.message, error: true }));
  useEffect(() => {
    reload();
  }, []);

  // Run an API call, then show a message and reload the list.
  async function run(action: () => Promise<unknown>, success: string) {
    setMessage(null);
    try {
      await action();
      setMessage({ text: success });
      await reload();
      return true;
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Something went wrong", error: true });
      return false;
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const name = username.trim();
    if (await run(() => createAccount(name, password), `Created "${name}".`)) {
      setUsername("");
      setPassword("");
    }
  }

  function handleReset(a: Account) {
    const pw = window.prompt(`New password for ${a.username} (at least ${MIN_PASSWORD} characters):`);
    if (pw === null) return;
    run(() => resetPassword(a.id, pw), `Password changed for ${a.username}. They've been signed out.`);
  }

  function handleDelete(a: Account) {
    if (!window.confirm(`Delete the account "${a.username}"? They won't be able to sign in.`)) return;
    run(() => deleteAccount(a.id), `Deleted "${a.username}".`);
  }

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

  return (
    <section id="manage-users" className="accounts-panel" aria-label="Manage users">
      <div className="accounts-header">
        <h2>Manage users</h2>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      {accounts === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="accounts-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Created</th>
              <th>Last sign-in</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.username}
                  {a.isAdmin && <span className="badge">admin</span>}
                </td>
                <td>{date(a.createdAt)}</td>
                <td>{date(a.lastLoginAt)}</td>
                <td className="actions">
                  <button type="button" className="text-button" onClick={() => handleReset(a)}>
                    Reset password
                  </button>
                  {!a.isAdmin && a.id !== me.id && (
                    <button type="button" className="text-button danger" onClick={() => handleDelete(a)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="accounts-create" onSubmit={handleCreate}>
        <h3>Create a user</h3>
        <div className="row">
          <input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
          />
          <input
            placeholder={`Password (${MIN_PASSWORD}+ characters)`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <button type="submit" disabled={!username.trim() || password.length < MIN_PASSWORD}>
            Create
          </button>
        </div>
      </form>

      {message && <p className={`status${message.error ? " error" : ""}`}>{message.text}</p>}
    </section>
  );
}
