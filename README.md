# 🎲 Boardroom Game Night Picker

A React + TypeScript app on top of an Express REST API with a SQLite database.
The API keeps your BoardGameGeek (BGG) collections in the database and syncs
them with BGG, so the page loads instantly and works with several collections.

```
Browser (React)  ──/api/*──▶  Express API  ──▶  SQLite (data/bgg.sqlite)
                                   │
                                   └──sync──▶  boardgamegeek.com (XML + token)
```

## Run it locally (Docker)

```bash
cd ~/Projects/bgg-game-night
cp .env.example .env         # add BGG_TOKEN for real data; blank = mock data
docker compose up --build
```

- App: http://localhost:5173
- API health check: http://localhost:3001/api/health

Edits in `web/src` or `api/src` reload automatically. After adding an npm
package, run `docker compose up --build --renew-anon-volumes`.

The database file is created at `api/data/bgg.sqlite` (or `bgg-mock.sqlite`
in mock mode, so sample games never mix with yours). Delete it to start fresh.

## Deploy to ZimaOS

1. Copy the project folder to the server (or `git clone` it there).
2. Create `.env` with your `BGG_TOKEN` (and `TZ`, see `.env.example`).
3. Run:

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

4. Open `http://<server-ip>:8080`.

The database is stored in `/DATA/AppData/bgg-game-night/data` on the server.
Set `DATA_DIR` or `WEB_PORT` in `.env` to change those. Back up by copying
that folder. To update, pull the new code and run the same command again;
the data is kept.

## Signing in

Everything (except `/api/health`) requires signing in. Accounts live in the
`accounts` table; passwords are stored as scrypt hashes, and the browser keeps
an HttpOnly session cookie (30 days). Five wrong passwords in 15 minutes for the
same username lock it out for a while.

- **Admins** (matthan) can also hide games and use **Manage users** (create
  users, reset passwords, delete users). Everyone else can view, filter, and
  add/refresh collections.
- **First-run accounts:** put a file at `api/data/initial-accounts.json`
  (`[{"username": "...", "password": "...", "isAdmin": true}]`). On start the
  API creates those accounts and **deletes the file**, so plain-text passwords
  don't stay on disk. Existing usernames are skipped.
- On ZimaOS the accounts come along with the database file. If you serve the
  site over HTTPS, set `SECURE_COOKIES=true`.

## The game list

Nothing is picked automatically. The admin (matthan) sets the filters and clicks
**Create game list**: 8 random games that match are saved as the current list
(`game_lists` table), together with the filters used. Everyone sees that list
and those filters (read-only) until the admin creates a new one. Older lists
are kept as history.

When the admin **hides** a game, it leaves the results everywhere and its spot
in the list is filled with another random game that fits the list's filters
(Undo puts it back).

## How syncing works

| When | What happens |
|---|---|
| A username is added for the first time | The API fetches the collection from BGG, saves it, then fetches details (weight + player-count poll) for every game |
| The page asks for a collection | Answered from the database immediately; if it's older than `REFRESH_MINUTES` (60), it's refreshed from BGG in the background |
| A collection is re-synced | New games are added, missing ones are marked removed (history kept), ratings/plays updated. Details are fetched **only** for new games or ones older than `DETAILS_MAX_AGE_DAYS` (30) |
| Every night at `NIGHTLY_SYNC_HOUR` (4am) | Every saved collection is re-synced |
| ↻ on a collection chip | Re-sync that collection now |
| × on a collection chip | Hide it from the page (data kept; adding it again brings it back) |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/collection/:username` | The collection from the database (first time: syncs from BGG) |
| `POST /api/collection/:username/sync` | Re-sync from BGG now |
| `GET /api/users` | Saved collections (the page shows these on load) |
| `DELETE /api/users/:username` | Hide a collection from the page |
| `GET /api/lists/current` | The current shared game list (games in order, with owners) |
| `POST /api/lists` · `PUT /api/lists/current/games` | Create a list / change its games (admin only) |
| `PUT /api/games/:id/hidden` | Hide a game from the results (kept in the database; admin only) |
| `DELETE /api/games/:id/hidden` | Show a hidden game again |
| `GET /api/games/hidden` | List hidden games |
| `GET /api/health` | Mode (mock/bgg) and database path (no sign-in needed) |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | Sign in / out / who am I |
| `GET`/`POST /api/accounts`, `PUT /api/accounts/:id/password`, `DELETE /api/accounts/:id` | Manage users (admin only) |

## Database tables

| Table | Holds |
|---|---|
| `users` | Saved usernames, visibility, last sync time/error |
| `games` | One row per game (shared by all collections): info, rating, weight |
| `game_player_counts` | BGG community poll votes per game and player count |
| `collection_items` | Who owns what: rating, plays, added/removed dates |
| `game_lists` | Shared game lists: filters used, game ids in order, who made it (newest = current) |
| `accounts` / `sessions` | Sign-in accounts (hashed passwords) and signed-in browsers |
| `game_notes` | Your own per-game data: `hidden_at` (Hide button), plus notes/tags (not used by the UI yet) |

The schema is in `api/src/db/schema.ts` as numbered migrations; add a new one
to change it. All SQL lives in `api/src/db/repo.ts`.

"Best with" / "Recommended for" are worked out from the stored poll votes in
`classifyPlayerVotes()` (`api/src/bgg/details.ts`): Best = "Best" got the most
votes; Recommended = Best + Recommended votes beat Not Recommended.

## Tests

```bash
cd api && npm test      # sync rules, against an in-memory database
```

Inside Docker: `docker compose exec api npm test`.

## Project map

```
api/
  src/index.ts              server setup, settings, nightly sync, which routes need sign-in
  src/auth.ts               passwords, sessions, cookies, sign-in checks
  src/sync.ts               keeps the database in step with BGG
  src/db/                   database: open + migrate, schema, all SQL (repo.ts)
  src/routes/               /api/collection and /api/users
  src/bgg/client.ts         BGG collection fetch (202 retries, XML → JSON)
  src/bgg/details.ts        BGG /thing details: weight + player-count poll
  src/bgg/mock.ts           sample data for mock mode (mock/*.xml)
  test/sync.test.ts         tests
web/
  src/App.tsx               page layout and state
  src/hooks/useCollections.ts  loading, background refresh, manual refresh
  src/api.ts                calls our API
  src/filterGames.ts        filters, weight groups, merging collections
  src/components/           LoginPage, AccountsPanel, CollectionsBar, Filters, GameCarousel, UsernameForm
  nginx.conf                production web server (ZimaOS)
docker-compose.yml          local development
docker-compose.prod.yml     ZimaOS / production
```

## Ideas for next steps

- Edit your own notes/tags per game (`game_notes` table + a `PATCH` endpoint)
- React Router + a game detail page; replace `useCollections` with TanStack Query
- "Recently added" view using `collection_items.added_at`
