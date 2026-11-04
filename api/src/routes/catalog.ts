import { Router } from "express";
import { BggError } from "../bgg/client.js";
import type { Catalog } from "../catalog.js";

/** GET /api/catalog/search?q=spirit -> { total, hits: [{ id, name, yearPublished, inDatabase }] } */
export function catalogRouter({ catalog }: { catalog: Catalog }) {
  const router = Router();

  router.get("/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.status(400).json({ error: "Type at least 2 letters to search." });
    try {
      res.json(await catalog.searchGames(q.slice(0, 100)));
    } catch (err) {
      const status = err instanceof BggError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Search failed" });
    }
  });

  return router;
}
