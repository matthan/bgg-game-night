import express from "express";
import { dirname, join } from "node:path";
import { importInitialAccounts, requireAdmin, requireLogin } from "./auth.js";
import { openDatabase } from "./db/index.js";
import { accountsRouter } from "./routes/accounts.js";
import { authRouter } from "./routes/auth.js";
import { collectionRouter } from "./routes/collection.js";
import { gamesRouter } from "./routes/games.js";
import { listsRouter } from "./routes/lists.js";
import { usersRouter } from "./routes/users.js";
import { createSyncService, scheduleNightlySync } from "./sync.js";

const PORT = Number(process.env.PORT ?? 3001);
const BGG_TOKEN = process.env.BGG_TOKEN?.trim() ?? "";
// Mock mode is on if you ask for it, or automatically when there's no token yet.
const USE_MOCK = process.env.USE_MOCK === "true" || !BGG_TOKEN;
// Mock and real data live in separate files so sample games never mix with yours.
const DB_PATH = process.env.DB_PATH ?? (USE_MOCK ? "data/bgg-mock.sqlite" : "data/bgg.sqlite");
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES ?? 60);
const DETAILS_MAX_AGE_DAYS = Number(process.env.DETAILS_MAX_AGE_DAYS ?? 30);
const NIGHTLY_SYNC_HOUR = Number(process.env.NIGHTLY_SYNC_HOUR ?? 4); // -1 turns it off
// Set to true when the site is served over HTTPS, so the login cookie is only sent securely.
const SECURE_COOKIES = process.env.SECURE_COOKIES === "true";

const db = openDatabase(DB_PATH);
// First run: create login accounts from data/initial-accounts.json (then that file is deleted).
await importInitialAccounts(db, join(dirname(DB_PATH), "initial-accounts.json"));
const sync = createSyncService({ db, token: BGG_TOKEN, useMock: USE_MOCK, detailsMaxAgeDays: DETAILS_MAX_AGE_DAYS });

const app = express();
app.set("trust proxy", 1); // requests arrive through Vite (dev) or nginx (prod)
app.use(express.json());

// --- public: no sign-in needed ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: USE_MOCK ? "mock" : "bgg", database: DB_PATH });
});
app.use("/api/auth", authRouter({ db, secureCookies: SECURE_COOKIES }));

// --- everything below needs a signed-in account ---
app.use("/api", requireLogin(db));
app.use("/api/collection", collectionRouter({ db, sync, useMock: USE_MOCK, refreshMinutes: REFRESH_MINUTES }));
app.use("/api/users", usersRouter({ db }));
app.use("/api/lists", listsRouter({ db })); // reading is open; changing it is admin-only (inside)

// --- admin only (matthan): hiding games, managing accounts ---
app.use("/api/games", requireAdmin, gamesRouter({ db }));
app.use("/api/accounts", requireAdmin, accountsRouter({ db }));

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT} (${USE_MOCK ? "MOCK data" : "live BGG"}, db: ${DB_PATH})`);
});

if (NIGHTLY_SYNC_HOUR >= 0) scheduleNightlySync(sync, NIGHTLY_SYNC_HOUR);
