import { Router } from "express";
import { pool } from "../db";
import { slugify, wrap } from "../utils";

const r = Router();
const SELECT = `SELECT p.*, m.url AS featured_image_url FROM posts p LEFT JOIN media m ON m.id = p.featured_media_id`;

r.get("/", wrap(async (req, res) => {
  const params: unknown[] = [`%${(req.query.q as string) || ""}%`];
  let where = `p.title ILIKE $1`;
  if (req.query.status === "draft" || req.query.status === "publish") {
    params.push(req.query.status);
    where += ` AND p.status = $2`;
  }
  const { rows } = await pool.query(`${SELECT} WHERE ${where} ORDER BY p.updated_at DESC`, params);
  res.json(rows);
}));

r.get("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(`${SELECT} WHERE p.id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

function body(req: any) {
  const title = String(req.body.title || "").trim();
  return {
    title,
    slug: slugify(req.body.slug || title),
    content: String(req.body.content || ""),
    excerpt: String(req.body.excerpt || ""),
    status: req.body.status === "publish" ? "publish" : "draft",
    featured_media_id: req.body.featured_media_id ? Number(req.body.featured_media_id) : null,
    seo: req.body.seo && typeof req.body.seo === "object" ? req.body.seo : {},
  };
}

r.post("/", wrap(async (req, res) => {
  const b = body(req);
  if (!b.title) return res.status(400).json({ error: "Title is required" });
  const { rows } = await pool.query(
    `INSERT INTO posts (title,slug,content,excerpt,status,featured_media_id,seo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.title, b.slug, b.content, b.excerpt, b.status, b.featured_media_id, b.seo]
  );
  res.status(201).json(rows[0]);
}));

r.put("/:id", wrap(async (req, res) => {
  const b = body(req);
  if (!b.title) return res.status(400).json({ error: "Title is required" });
  const { rows } = await pool.query(
    `UPDATE posts SET title=$1,slug=$2,content=$3,excerpt=$4,status=$5,featured_media_id=$6,seo=$7,updated_at=now()
     WHERE id=$8 RETURNING *`,
    [b.title, b.slug, b.content, b.excerpt, b.status, b.featured_media_id, b.seo, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

r.delete("/:id", wrap(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM posts WHERE id=$1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
}));

export default r;
