import { Router } from "express";
import { PoolClient } from "pg";
import { pool } from "../db";
import { slugify, wrap } from "../utils";

const r = Router();
const STATUSES = ["draft", "pending", "publish"];

const LIST_SELECT = `SELECT l.id, l.title, l.slug, l.status, l.featured, l.price, l.price_label, l.created_at, l.updated_at,
  m.url AS image_url,
  COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'taxonomy', t.taxonomy) ORDER BY t.name)
            FROM listing_terms lt JOIN terms t ON t.id = lt.term_id WHERE lt.listing_id = l.id), '[]') AS terms
  FROM listings l LEFT JOIN media m ON m.id = l.featured_media_id`;

const ORDER: Record<string, string> = {
  title: "l.title", price: "l.price", status: "l.status", featured: "l.featured", id: "l.id", date: "l.created_at",
};

r.get("/", wrap(async (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };

  if (req.query.q) add("l.title ILIKE ?", `%${req.query.q}%`);
  if (STATUSES.includes(req.query.status as string)) add("l.status = ?", req.query.status);
  if (req.query.featured === "1") where.push("l.featured");
  if (req.query.id) add("l.id = ?", Number(req.query.id) || 0);
  for (const key of ["city", "area", "type", "category", "feature"]) {
    const v = Number(req.query[key]);
    if (v) add("EXISTS (SELECT 1 FROM listing_terms x WHERE x.listing_id = l.id AND x.term_id = ?)", v);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderby = ORDER[req.query.orderby as string] || "l.created_at";
  const order = req.query.order === "asc" ? "ASC" : "DESC";
  const perPage = Math.min(Math.max(Number(req.query.per_page) || 20, 1), 200);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const [items, total, counts] = await Promise.all([
    pool.query(`${LIST_SELECT} ${w} ORDER BY ${orderby} ${order} NULLS LAST, l.id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params),
    pool.query(`SELECT count(*)::int AS n FROM listings l ${w}`, params),
    pool.query(`SELECT status, count(*)::int AS n FROM listings GROUP BY status`),
  ]);
  const n = total.rows[0].n;
  const byStatus: Record<string, number> = { all: 0, draft: 0, pending: 0, publish: 0 };
  for (const c of counts.rows) { byStatus[c.status] = c.n; byStatus.all += c.n; }
  res.json({ items: items.rows, total: n, page, per_page: perPage, pages: Math.max(1, Math.ceil(n / perPage)), counts: byStatus });
}));

r.get("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, m.url AS featured_image_url,
       COALESCE((SELECT array_agg(term_id) FROM listing_terms WHERE listing_id = l.id), '{}') AS term_ids
     FROM listings l LEFT JOIN media m ON m.id = l.featured_media_id WHERE l.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const gallery: number[] = Array.isArray(rows[0].details?.gallery) ? rows[0].details.gallery : [];
  const g = gallery.length ? await pool.query(`SELECT id, url, alt_text FROM media WHERE id = ANY($1::int[])`, [gallery]) : { rows: [] };
  const map = new Map(g.rows.map((x: any) => [x.id, x]));
  res.json({ ...rows[0], gallery_media: gallery.map((id) => map.get(id)).filter(Boolean) });
}));

async function uniqueSlug(c: PoolClient, base: string, exceptId?: number) {
  let slug = base, i = 2;
  while ((await c.query(`SELECT 1 FROM listings WHERE slug = $1 AND id <> $2`, [slug, exceptId || 0])).rowCount) slug = `${base}-${i++}`;
  return slug;
}

function parse(body: any) {
  const price = body.price === "" || body.price == null ? null : Number(body.price);
  return {
    title: String(body.title || "").trim(),
    slugBase: slugify(body.slug || body.title || `listing-${Date.now()}`),
    content: String(body.content || ""),
    excerpt: String(body.excerpt || ""),
    status: STATUSES.includes(body.status) ? body.status : "draft",
    featured: !!body.featured,
    featured_media_id: body.featured_media_id ? Number(body.featured_media_id) : null,
    price: price != null && Number.isFinite(price) ? price : null,
    price_label: String(body.price_label || "night"),
    details: body.details && typeof body.details === "object" ? body.details : {},
    seo: body.seo && typeof body.seo === "object" ? body.seo : {},
    appearance: body.appearance && typeof body.appearance === "object" ? body.appearance : {},
    term_ids: (Array.isArray(body.term_ids) ? body.term_ids : []).map(Number).filter(Number.isInteger),
  };
}

async function save(id: number | null, body: any) {
  const b = parse(body);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const slug = await uniqueSlug(c, b.slugBase, id || undefined);
    const vals = [b.title, slug, b.content, b.excerpt, b.status, b.featured, b.featured_media_id, b.price, b.price_label, b.details, b.seo, b.appearance];
    const { rows } = id
      ? await c.query(`UPDATE listings SET title=$1,slug=$2,content=$3,excerpt=$4,status=$5,featured=$6,featured_media_id=$7,price=$8,
          price_label=$9,details=$10,seo=$11,appearance=$12,updated_at=now() WHERE id=$13 RETURNING id`, [...vals, id])
      : await c.query(`INSERT INTO listings (title,slug,content,excerpt,status,featured,featured_media_id,price,price_label,details,seo,appearance)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, vals);
    if (!rows[0]) { await c.query("ROLLBACK"); return null; }
    const lid = rows[0].id;
    await c.query(`DELETE FROM listing_terms WHERE listing_id = $1`, [lid]);
    if (b.term_ids.length)
      await c.query(`INSERT INTO listing_terms (listing_id, term_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`, [lid, b.term_ids]);
    await c.query("COMMIT");
    return lid as number;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

r.post("/", wrap(async (req, res) => {
  const id = await save(null, req.body);
  res.status(201).json({ id });
}));

r.put("/:id", wrap(async (req, res) => {
  const id = await save(Number(req.params.id), req.body);
  if (!id) return res.status(404).json({ error: "Not found" });
  res.json({ id });
}));

r.delete("/:id", wrap(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM listings WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
}));

r.post("/bulk", wrap(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ error: "No listings selected" });
  const a = req.body.action;
  let q: string;
  if (a === "delete") q = `DELETE FROM listings WHERE id = ANY($1::int[])`;
  else if (STATUSES.includes(a)) q = `UPDATE listings SET status = '${a}', updated_at = now() WHERE id = ANY($1::int[])`;
  else if (a === "feature" || a === "unfeature") q = `UPDATE listings SET featured = ${a === "feature"}, updated_at = now() WHERE id = ANY($1::int[])`;
  else return res.status(400).json({ error: "Unknown action" });
  const { rowCount } = await pool.query(q, [ids]);
  res.json({ affected: rowCount });
}));

r.post("/:id/clone", wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM listings WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const t = await pool.query(`SELECT term_id FROM listing_terms WHERE listing_id = $1`, [req.params.id]);
  const id = await save(null, { ...rows[0], title: `${rows[0].title} (Copy)`, slug: "", status: "draft", term_ids: t.rows.map((x) => x.term_id) });
  res.status(201).json({ id });
}));

export default r;
