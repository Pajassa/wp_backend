import { Router } from "express";
import { pool, TAXONOMIES, Taxonomy } from "../db";
import { slugify, wrap } from "../utils";

const r = Router();

r.get("/", (_req, res) => {
  res.json(Object.entries(TAXONOMIES).map(([slug, label]) => ({ slug, label })));
});

r.param("taxonomy", (req, res, next, tax) => {
  if (!(tax in TAXONOMIES)) return res.status(404).json({ error: "Unknown taxonomy" });
  next();
});

const SELECT = `SELECT t.*, p.name AS parent_name, m.url AS image_url,
  (SELECT count(*)::int FROM listing_terms lt WHERE lt.term_id = t.id) AS count
  FROM terms t LEFT JOIN terms p ON p.id = t.parent_id LEFT JOIN media m ON m.id = t.image_id`;

r.get("/:taxonomy", wrap(async (req, res) => {
  const q = `%${(req.query.q as string) || ""}%`;
  const SORT: Record<string, string> = { name: "t.name", slug: "t.slug", description: "t.description", id: "t.id", count: "count" };
  const orderby = SORT[req.query.orderby as string] || "t.name";
  const order = req.query.order === "desc" ? "DESC" : "ASC";
  const sql = `${SELECT} WHERE t.taxonomy = $1 AND t.name ILIKE $2 ORDER BY ${orderby} ${order}, t.id`;
  // Without ?page the full list is returned (used for parent dropdowns)
  if (!req.query.page) {
    const { rows } = await pool.query(sql, [req.params.taxonomy, q]);
    return res.json(rows);
  }
  const perPage = Math.min(Math.max(Number(req.query.per_page) || 20, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const [{ rows }, total] = await Promise.all([
    pool.query(`${sql} LIMIT $3 OFFSET $4`, [req.params.taxonomy, q, perPage, (page - 1) * perPage]),
    pool.query(`SELECT count(*)::int AS n FROM terms t WHERE t.taxonomy = $1 AND t.name ILIKE $2`, [req.params.taxonomy, q]),
  ]);
  const n = total.rows[0].n;
  res.json({ items: rows, total: n, page, per_page: perPage, pages: Math.max(1, Math.ceil(n / perPage)) });
}));

function body(req: any, tax: Taxonomy) {
  const name = String(req.body.name || "").trim();
  return {
    name,
    slug: slugify(req.body.slug || name),
    description: String(req.body.description || ""),
    parent_id: req.body.parent_id ? Number(req.body.parent_id) : null,
    image_id: req.body.image_id ? Number(req.body.image_id) : null,
    custom_uri: String(req.body.custom_uri || "").trim().replace(/^\/+|\/+$/g, ""),
    tax,
  };
}

r.post("/:taxonomy", wrap(async (req, res) => {
  const b = body(req, req.params.taxonomy as Taxonomy);
  if (!b.name) return res.status(400).json({ error: "Name is required" });
  const { rows } = await pool.query(
    `INSERT INTO terms (taxonomy,name,slug,description,parent_id,image_id,custom_uri) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.tax, b.name, b.slug, b.description, b.parent_id, b.image_id, b.custom_uri]
  );
  res.status(201).json(rows[0]);
}));

r.post("/:taxonomy/bulk-delete", wrap(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ error: "No items selected" });
  const { rowCount } = await pool.query(`DELETE FROM terms WHERE taxonomy=$1 AND id = ANY($2::int[])`, [req.params.taxonomy, ids]);
  res.json({ deleted: rowCount });
}));

r.put("/:taxonomy/:id", wrap(async (req, res) => {
  const b = body(req, req.params.taxonomy as Taxonomy);
  if (!b.name) return res.status(400).json({ error: "Name is required" });
  if (b.parent_id === Number(req.params.id)) return res.status(400).json({ error: "Item cannot be its own parent" });
  const { rows } = await pool.query(
    `UPDATE terms SET name=$1,slug=$2,description=$3,parent_id=$4,image_id=$5,custom_uri=$6
     WHERE id=$7 AND taxonomy=$8 RETURNING *`,
    [b.name, b.slug, b.description, b.parent_id, b.image_id, b.custom_uri, req.params.id, b.tax]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

r.delete("/:taxonomy/:id", wrap(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM terms WHERE id=$1 AND taxonomy=$2`, [req.params.id, req.params.taxonomy]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
}));

export default r;
