/**
 * Database schema, as an ordered list of migrations.
 *
 * Each migration runs once, in order, and is recorded in `schema_migrations`.
 * To change the schema later, ADD a new migration to the end of this list —
 * never edit one that has already run on a real database.
 */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      -- Every BGG username you've added to the page.
      CREATE TABLE users (
        username_key    TEXT PRIMARY KEY,           -- lowercase, BGG usernames are case-insensitive
        username        TEXT NOT NULL,              -- as typed, for display
        visible         INTEGER NOT NULL DEFAULT 1, -- 0 = removed from the page (data kept)
        added_at        TEXT NOT NULL,
        last_synced_at  TEXT,                       -- NULL = never synced yet
        last_sync_error TEXT
      );

      -- One row per game, shared by every collection that owns it.
      CREATE TABLE games (
        id                INTEGER PRIMARY KEY,      -- BGG game id
        name              TEXT NOT NULL,
        year_published    INTEGER,
        thumbnail         TEXT,
        image             TEXT,
        min_players       INTEGER,
        max_players       INTEGER,
        playing_time      INTEGER,
        min_play_time     INTEGER,
        max_play_time     INTEGER,
        bgg_rating        REAL,
        weight            REAL,
        details_synced_at TEXT,                     -- last /thing fetch (weight + poll); NULL = never
        updated_at        TEXT NOT NULL
      );

      -- BGG community poll: votes per game and player count.
      CREATE TABLE game_player_counts (
        game_id               INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        players               INTEGER NOT NULL,
        best_votes            INTEGER NOT NULL,
        recommended_votes     INTEGER NOT NULL,
        not_recommended_votes INTEGER NOT NULL,
        PRIMARY KEY (game_id, players)
      );

      -- Who owns what. Rows are never deleted when a game leaves a collection;
      -- removed_at is set instead, so history is kept.
      CREATE TABLE collection_items (
        username_key TEXT NOT NULL REFERENCES users(username_key) ON DELETE CASCADE,
        game_id      INTEGER NOT NULL REFERENCES games(id),
        my_rating    REAL,
        num_plays    INTEGER NOT NULL DEFAULT 0,
        added_at     TEXT NOT NULL,                 -- first time we saw it in the collection
        removed_at   TEXT,                          -- NULL = still owned
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (username_key, game_id)
      );
      CREATE INDEX collection_items_owned ON collection_items(username_key) WHERE removed_at IS NULL;

      -- Your own information that isn't on BGG (not used by the UI yet).
      CREATE TABLE game_notes (
        game_id    INTEGER PRIMARY KEY REFERENCES games(id),
        notes      TEXT,
        tags       TEXT,                            -- JSON array of strings
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "hide games from results",
    sql: `
      -- Set when you hide a game from the results; NULL = shown.
      ALTER TABLE game_notes ADD COLUMN hidden_at TEXT;
    `,
  },
  {
    version: 3,
    name: "login accounts and sessions",
    sql: `
      -- People who can sign in to the app (not the same as BGG usernames in "users").
      CREATE TABLE accounts (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,                -- scrypt hash, never the password itself
        is_admin      INTEGER NOT NULL DEFAULT 0,   -- admins can hide games and manage accounts
        created_at    TEXT NOT NULL,
        last_login_at TEXT
      );

      -- One row per signed-in browser. Only a hash of the cookie token is stored.
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX sessions_account ON sessions(account_id);
    `,
  },
  {
    version: 4,
    name: "shared game lists",
    sql: `
      -- The game list everyone sees, made by an admin from a set of filters.
      -- The newest row is the current list; older rows are kept as history.
      CREATE TABLE game_lists (
        id         INTEGER PRIMARY KEY,
        filters    TEXT NOT NULL,                   -- JSON: the filter settings used
        game_ids   TEXT NOT NULL,                   -- JSON array of BGG ids, in display order
        created_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL                    -- changes when a hidden game is swapped out
      );
    `,
  },
  {
    version: 5,
    name: "votes on the current game list",
    sql: `
      -- One row per account per game they voted for, in a given list.
      -- Only the current list's votes matter; making a new list clears them.
      CREATE TABLE list_votes (
        list_id    INTEGER NOT NULL REFERENCES game_lists(id) ON DELETE CASCADE,
        game_id    INTEGER NOT NULL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        voted_at   TEXT NOT NULL,
        PRIMARY KEY (list_id, game_id, account_id)
      );
    `,
  },
  {
    version: 6,
    name: "interest per user per game",
    sql: `
      -- How keen each person is on each game. No row = "no opinion".
      -- level: 2 yes please!, 1 sounds good, 0 take it or leave it, -1 rather not, -2 no thanks
      CREATE TABLE game_interest (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        game_id    INTEGER NOT NULL REFERENCES games(id),
        level      INTEGER NOT NULL CHECK (level BETWEEN -2 AND 2),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, game_id)
      );
      CREATE INDEX game_interest_game ON game_interest(game_id);
    `,
  },
  {
    version: 7,
    name: "collections with games added by hand",
    sql: `
      -- 'bgg' = synced from a BGG account; 'manual' = no BGG account, games added by hand
      ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'bgg';
      -- 1 = added by hand (a BGG sync never removes it)
      ALTER TABLE collection_items ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 8,
    name: "decode HTML codes in game names",
    sql: `
      -- BGG sends some names double-encoded ("Tzolk&#039;in"); new syncs decode
      -- them (decodeName in bgg/client.ts). This fixes names already saved.
      UPDATE games SET name =
        replace(replace(replace(replace(name, '&#039;', ''''), '&quot;', '"'), '&#10;', ' '), '&amp;', '&')
      WHERE name LIKE '%&%;%';
    `,
  },
];
