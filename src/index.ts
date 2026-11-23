import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import "dotenv/config";
import { initDb, pool } from "./db";
import { pgError } from "./utils";
import terms from "./routes/terms";
import posts from "./routes/posts";
import media, { UPLOAD_DIR } from "./routes/media";
import listings from "./routes/listings";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || "*" }));
app.use(express.json({ limit: "5mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/stats", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM posts)::int AS posts,
             (SELECT count(*) FROM listings)::int AS listings,
             (SELECT count(*) FROM media)::int AS media,
             COALESCE((SELECT json_object_agg(taxonomy, c) FROM
               (SELECT taxonomy, count(*)::int c FROM terms GROUP BY taxonomy) x), '{}') AS terms`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});
app.use("/api/taxonomies", terms);
app.use("/api/posts", posts);
app.use("/api/media", media);
app.use("/api/listings", listings);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => pgError(err, res));

const port = Number(process.env.PORT) || 8002;
initDb()
  .then(() => app.listen(port, () => console.log(`API running on http://localhost:${port}`)))
  .catch((e) => { console.error("DB init failed:", e.message); process.exit(1); });
