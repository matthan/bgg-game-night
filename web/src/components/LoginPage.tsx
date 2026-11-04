import { useState, type FormEvent } from "react";
import { login } from "../api";
import type { Account } from "../types";

/** Shown instead of the app until someone signs in. */
export function LoginPage({ onLogin }: { onLogin: (account: Account) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <header className="site-header">
        <p className="eyebrow">Boardroom Game Night</p>
        <h1>Board Game Picker</h1>
        <p className="muted">Sign in to pick tonight's game.</p>
      </header>

      <form className="login-form" onSubmit={handleSubmit}>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <p className="status error">⚠️ {error}</p>}
      </form>
    </main>
  );
}
