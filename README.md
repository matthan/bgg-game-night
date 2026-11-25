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

The server runs ready-made images; it doesn't build anything.

1. **Push to `main`** (or merge a pull request). GitHub Actions
   (`.github/workflows/publish.yml`) type-checks, runs the API tests, builds
   the web app, and publishes two images to GitHub's container registry:
   `ghcr.io/matthan/bgg-game-night-api` and `…-web` (tags `latest` and
   `sha-<commit>`). Branches and pull requests are only checked, never deployed.
2. **Watchtower** (in `docker-compose.prod.yml`) checks for new `latest` images
   every 5 minutes, pulls them, restarts `api` / `web`, and removes the old
   images. It only touches containers with the
   `com.centurylinklabs.watchtower.enable` label, so other ZimaOS apps are left
   alone. Database migrations run when the API starts, so a new schema is
   applied on the first start of the new image.

See what it's doing with `docker compose -f docker-compose.prod.yml logs -f watchtower`.

### First-time setup on the server

1. Put `docker-compose.prod.yml` and a `.env` (your `BGG_TOKEN`, `TZ`, see
   `.env.example`) in a folder on the server. Use the **same folder** the app
   was deployed from before, so Compose replaces the old containers instead of
   starting a second copy (or run `docker compose -f docker-compose.prod.yml
   down` in the old folder first). The rest of the code isn't needed there.
   If that `.env` was copied from an older `.env.example`, delete its
   `SECURE_COOKIES=false` line (see below).
2. If the images are **private**, give the server read access (skip this if
   you made the two packages public under GitHub → your profile → Packages →
   Package settings → Change visibility):

   ```bash
   # a GitHub token (classic) with only the read:packages scope
   mkdir -p /DATA/AppData/bgg-game-night/registry-login
   docker --config /DATA/AppData/bgg-game-night/registry-login login ghcr.io -u matthan
   ```

   Watchtower reads this login from that folder. For the first start below,
   put `DOCKER_CONFIG=/DATA/AppData/bgg-game-night/registry-login` in front of
   the command so it can pull too.

3. Start it:

   ```bash
   docker compose -f docker-compose.prod.yml up -d --remove-orphans
   ```

4. Open `http://<server-ip>:8080`, or the domain set up in Nginx Proxy Manager.
   The `web` container joins the external `proxy` network as `bgpicker`.

The database is stored in `/DATA/AppData/bgg-game-night/data` on the server.
Set `DATA_DIR` or `WEB_PORT` in `.env` to change those. Back up by copying
that folder.

**Sign-in cookies:** in production `SECURE_COOKIES` defaults to `true` (the
login cookie is only sent over HTTPS), because the site is reached through the
Cloudflare tunnel. Signing in over plain `http://<server-ip>:8080` then won't
work; set `SECURE_COOKIES=false` in the server's `.env` if you need that.

**Changes to `docker-compose.prod.yml` itself** (new settings, ports) are not
picked up by Watchtower: copy the file to the server and run step 3 again.

**Rolling back:** point `image:` at an older tag (e.g. `:sha-abc1234`, listed
on the package's page) and run step 3; Watchtower leaves a pinned tag alone
until you switch back to `:latest`.

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
**Create game list**: 7 random games that match are saved as the current list
(`game_lists` table), together with the filters used. Everyone sees that list
until the admin creates a new one. The filters, the Create button and the
collections section are only shown to the admin; everyone else just sees the
game list. Older lists
are kept as history.

When the admin **hides** a game, it leaves the results everywhere and its spot
in the list is filled with another random game that fits the list's filters
(Undo puts it back). **Replace** does the same swap but doesn't hide the game,
so it can still come up in future lists.

**Favouring well-liked games:** picking is random, but the filters' "Favour
well-liked games" switch (Off / Gentle / Strong, saved with the list) gives
games a better or worse chance from everyone's average interest:
`chance = 2 ^ (strength × (average − 2.5))`, with average 0 (rather not) to
5 (yes, please!) and strength 0 / 1 / 2. On Gentle, a game averaging "Yes,
please!" is about 5.7× as likely as an unrated one and one averaging "Rather
not" about 0.18×; Strong doubles that. Replacements (Hide / Replace) use the
same setting. The maths is in `interestWeight()` in `web/src/filterGames.ts`.

**Browsing the list:** click (or tap) a card to open it: it turns to face you
and the others blur. Click it again, click (or tap) anywhere outside it, or
press Escape to go back to the fan; clicking another card opens that one
instead. The ‹ › buttons at either end of the list (or the ← → keys) step to
the previous / next game. They stay in the same place whatever is open; with
nothing open, › opens the first game and ‹ the last, and at either end of the
list the arrow that can't go further is greyed out.
On screens narrower than 1024px (phones, tablets) the fan runs down the page:
each card shows the top of its box art, the selected card opens to full
height, and cards you voted for slide to the right. Cards are at most 400px
wide and the list is centered. The arrows sit above (previous) and below
(next) the list instead of beside it.

The open card's name links to BoardGameGeek (clicking it doesn't vote); on a closed card the name isn't a link, so clicking it just opens the card. Who made the list
and when is kept in the page's `<meta name="game-list">` tag.

**Voting:** everyone signed in can vote for any games in the current list
(one vote per game) with the round 👍 button on each card (hovering it shows
"Vote"); click it again to take the vote back. Clicking a card just selects it. Cards you voted
for sit a little higher than the rest. Each card's 👍 button shows the vote
count (hover it to see who). Votes belong to the list: creating a new list erases them, and a hidden
game's votes go with it. Pages re-check the list every 15 seconds.

## Interest levels

Everyone signed in can say how keen they are on each game, shown as a die
from six pips down to one: Yes, please! · Sounds great · Sure thing ·
Slightly · Not particularly · Rather not — or no opinion. Ratings are set on
the **Rate games** page (below); each card in the game list shows everyone's
dice. The labels, dice and colors live in `web/src/interest.ts`.
Unlike votes, interest is kept permanently per person per game
(`game_interest` table), so it carries over to future lists.

## Rate games page

**Rate games** (top right; not for guest) opens a page listing every game in
the loaded collections, except hidden ones, A–Z as a card grid. Each card has
a row of dice: tap one to set your interest, tap it again to clear it. Filters:
name search, **Unrated only** (games you rate stay visible until you change a
filter) and one collection. Cards load in batches as you scroll. The page lives
at `#rate`, so the browser's back button works. Your ratings come from
`GET /api/interest/mine` and are saved with `PUT /api/interest/:gameId`.

## Adding games by hand

Not everyone has a BGG account. **Add games** (top right) lets each member add
games to their own collection — named after their sign-in — and the admin add
to anyone's. Search BoardGameGeek and click **+ Add**, or paste a list (one
name per line) under **Add a list of games**. Each name is matched exactly; if
several games share a name, the most-rated one is used, and names not found
stay in the box to fix. Game info (players, time, weight, poll) still comes
from BGG; only "who owns it" is manual.

A collection with only hand-added games is never synced from BGG (its chip has
no ↻). Games added by hand to a BGG collection survive its syncs. Only
hand-added games can be removed in the panel. In mock mode, search uses the
sample games plus a few extras in `api/mock/catalog.xml`.

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
| `GET /api/catalog/search?q=` | Search BGG board games by name |
| `POST /api/collection/:username/games { ids }` or `{ names }` | Add games by hand (your own collection; admin: anyone's) |
| `DELETE /api/collection/:username/games/:id` | Remove a hand-added game |
| `GET /api/lists/current` | The current shared game list (games in order, with owners) |
| `POST /api/lists` · `PUT /api/lists/current/games` | Create a list / change its games (admin only) |
| `PUT`/`DELETE /api/lists/current/games/:id/vote` | Vote / unvote for a game in the current list |
| `PUT /api/interest/:gameId { level }` · `DELETE /api/interest/:gameId` | Set / clear your interest in a game (level 5 = yes, please! down to 0 = rather not) |
| `GET /api/interest` | Average interest and number of ratings per game (used to favour well-liked games) |
| `GET /api/interest/mine` | Your own interest level for every game you've rated (the Rate games page) |
| `PUT /api/games/:id/hidden` | Hide a game from the results (kept in the database; admin only) |
| `DELETE /api/games/:id/hidden` | Show a hidden game again |
| `GET /api/games/hidden` | List hidden games |
| `GET /api/health` | Mode (mock/bgg) and database path (no sign-in needed) |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | Sign in / out / who am I |
| `GET`/`POST /api/accounts`, `PUT /api/accounts/:id/password`, `DELETE /api/accounts/:id` | Manage users (admin only) |

## Database tables

| Table | Holds |
|---|---|
| `users` | Saved collections, visibility, last sync time/error, `source` (`bgg` or `manual`) |
| `games` | One row per game (shared by all collections): info, rating, weight |
| `game_player_counts` | BGG community poll votes per game and player count |
| `collection_items` | Who owns what: rating, plays, added/removed dates, `manual` (added by hand) |
| `game_lists` | Shared game lists: filters used, game ids in order, who made it (newest = current) |
| `list_votes` | Votes on the current list (cleared when a new list is made) |
| `game_interest` | Each person's interest level per game (kept permanently; no row = no opinion) |
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
  src/catalog.ts            adding games by hand (search, add by id or name)
  src/routes/               one file per /api/... area
  src/bgg/client.ts         BGG collection fetch (202 retries, XML → JSON)
  src/bgg/details.ts        BGG /thing details: weight + player-count poll
  src/bgg/catalog.ts        BGG /search and full /thing info for single games
  src/bgg/mock.ts           sample data for mock mode (mock/*.xml)
  test/*.test.ts            tests
web/
  src/App.tsx               page layout and state
  src/hooks/useCollections.ts  loading, background refresh, manual refresh
  src/api.ts                calls our API
  src/filterGames.ts        filters, interest-weighted picking, merging collections
  src/components/           LoginPage, AccountsPanel, AddGamesPanel, CollectionsBar, Filters, GameCarousel, UsernameForm
  nginx.conf                production web server (ZimaOS)
docker-compose.yml          local development
docker-compose.prod.yml     ZimaOS / production (published images + Watchtower)
.github/workflows/publish.yml  checks every push; publishes images from main
```

## Ideas for next steps

- Edit your own notes/tags per game (`game_notes` table + a `PATCH` endpoint)
- React Router + a game detail page; replace `useCollections` with TanStack Query
- "Recently added" view using `collection_items.added_at`
