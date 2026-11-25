// Read-only public API for the PAJASA website (pajasawebsite).
// Returns the same response shapes the website's src/lib/api.ts expects
// (BackendProperty / BackendCity / BackendBlog), built from the dashboard tables.
// Only published content is exposed.
import { Router } from "express";
import { pool } from "../db";
import { wrap } from "../utils";

const CITY_TAX = ["listing-city", "listing-area"];
const num = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const yes = (v: unknown) => v === "yes";
const page = (q: any, max = 1000) => {
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), max);
  const p = Math.max(Number(q.page) || 1, 1);
  return { limit, page: p, offset: (p - 1) * limit };
};
const paged = (items: unknown[], total: number, p: { page: number; limit: number }) =>
  ({ items, total, page: p.page, limit: p.limit, total_pages: Math.max(1, Math.ceil(total / p.limit)) });

// ---------------- properties ----------------

const PROPERTY_SELECT = `
  SELECT l.*, fm.url AS featured_url, fm.alt_text AS featured_alt,
    (SELECT json_agg(json_build_object('url', m.url, 'alt', m.alt_text) ORDER BY g.ord)
       FROM jsonb_array_elements_text(COALESCE(l.details->'gallery', '[]')) WITH ORDINALITY g(id, ord)
       JOIN media m ON m.id = g.id::int) AS gallery,
    (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'taxonomy', t.taxonomy, 'parent_id', t.parent_id))
       FROM listing_terms lt JOIN terms t ON t.id = lt.term_id WHERE lt.listing_id = l.id) AS terms
  FROM listings l LEFT JOIN media fm ON fm.id = l.featured_media_id`;

type TermRef = { id: number; name: string; taxonomy: string; parent_id: number | null };

function toProperty(r: any) {
  const d = r.details || {};
  const terms: TermRef[] = r.terms || [];
  const first = (tax: string) => terms.find((t) => t.taxonomy === tax);
  const area = first("listing-area"), city = first("listing-city");
  const gallery: { url: string; alt: string }[] = r.gallery || [];
  const imageAlts: Record<string, string> = {};
  if (r.featured_url && r.featured_alt) imageAlts[r.featured_url] = r.featured_alt;
  gallery.forEach((g) => { if (g.alt) imageAlts[g.url] = g.alt; });
  const { keyphrase, ...seo } = r.seo || {};
  return {
    id: r.id, title: r.title, slug: r.slug, description: r.content, excerpt: r.excerpt, status: r.status,
    category: first("listing-category")?.name ?? null, rent_type: first("listing-type")?.name ?? null,
    city_id: (area || city)?.id ?? null, neighborhood: area?.name ?? null, city_name: city?.name ?? null,
    address: d.address ?? null, state: d.state ?? null, zip_code: d.zip ?? null, country: d.country ?? null,
    price: num(r.price) ?? 0, price_before_label: null, price_after_label: r.price_label ? `/${r.price_label}` : null,
    price_per_week: num(d.weekly_price), price_per_month: num(d.monthly_price),
    cleaning_fee: num(d.cleaning_fee), security_deposit: num(d.security_deposit),
    bedrooms: num(d.bedrooms) ?? 0, bathrooms: num(d.bathrooms) ?? 0, rooms: num(d.beds) ?? 0,
    size_sqft: num(d.size), guest_no: num(d.guests) ?? 0, min_days_booking: num(d.min_days) ?? 0,
    featured_image: r.featured_url ?? null, gallery_images: gallery.map((g) => g.url), image_alts: imageAlts,
    is_featured: r.featured, instant_booking: false,
    smoking_allowed: yes(d.smoking), pets_allowed: yes(d.pets), party_allowed: yes(d.parties), children_allowed: yes(d.children),
    amenities: Array.isArray(d.amenities) ? d.amenities : terms.filter((t) => t.taxonomy === "listing-features").map((t) => t.name),
    cancellation_policy: d.cancellation ?? null, other_rules: d.house_rules ?? null,
    faqs: Array.isArray(d.faqs) ? d.faqs : [],
    wp_id: r.wp_id, source_uri: d.custom_uri || null,
    latitude: num(d.latitude), longitude: num(d.longitude),
    seo: Object.keys(seo).length ? seo : null,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

const ORDER: Record<string, string> = {
  source_order: "l.created_at DESC", created_at: "l.created_at", price: "l.price", title: "l.title",
};

const properties = Router();

properties.get("/", wrap(async (req, res) => {
  const q = req.query as Record<string, string>;
  const p = page(q);
  const where = ["l.status = 'publish'"];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  if (q.search) add("(l.title ILIKE ? OR l.details->>'address' ILIKE ?)", `%${q.search}%`);
  if (q.city_id) {
    const sub = q.include_children === "true"
      ? "lt.term_id = ? OR lt.term_id IN (SELECT id FROM terms WHERE parent_id = ?)"
      : "lt.term_id = ?";
    add(`EXISTS (SELECT 1 FROM listing_terms lt WHERE lt.listing_id = l.id AND (${sub}))`, Number(q.city_id) || 0);
  }
  if (q.category) add(`EXISTS (SELECT 1 FROM listing_terms lt JOIN terms t ON t.id = lt.term_id
    WHERE lt.listing_id = l.id AND t.taxonomy IN ('listing-category','listing-type') AND (t.slug = ? OR t.name ILIKE ?))`, q.category);
  if (q.uri_prefix) add("l.details->>'custom_uri' LIKE ?", `${q.uri_prefix.replace(/[%_]/g, "")}/%`);
  if (q.is_featured === "true") where.push("l.featured");

  let order = ORDER[q.sort_by] || "l.featured DESC, l.created_at DESC";
  if (ORDER[q.sort_by] && q.sort_by !== "source_order") order += q.order === "desc" ? " DESC" : " ASC";
  const w = `WHERE ${where.join(" AND ")}`;
  const [items, total] = await Promise.all([
    pool.query(`${PROPERTY_SELECT} ${w} ORDER BY ${order} NULLS LAST, l.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, params),
    pool.query(`SELECT count(*)::int AS n FROM listings l ${w}`, params),
  ]);
  res.json(paged(items.rows.map(toProperty), total.rows[0].n, p));
}));

const oneProperty = async (cond: string, v: unknown) => {
  const { rows } = await pool.query(`${PROPERTY_SELECT} WHERE l.status = 'publish' AND ${cond} LIMIT 1`, [v]);
  return rows[0] ? toProperty(rows[0]) : null;
};

properties.get("/uri", wrap(async (req, res) => {
  const path = String(req.query.path || "").replace(/^\/+|\/+$/g, "").toLowerCase();
  const p = path && await oneProperty("lower(l.details->>'custom_uri') = $1", path);
  p ? res.json(p) : res.status(404).json({ error: "Not found" });
}));
properties.get("/slug/:slug", wrap(async (req, res) => {
  const p = await oneProperty("l.slug = $1", req.params.slug);
  p ? res.json(p) : res.status(404).json({ error: "Not found" });
}));
properties.get("/:id", wrap(async (req, res) => {
  const p = await oneProperty("l.id = $1", Number(req.params.id) || 0);
  p ? res.json(p) : res.status(404).json({ error: "Not found" });
}));

// ---------------- cities (cities + areas) ----------------

const CITY_SELECT = `
  SELECT t.*, m.url AS image_url, pt.name AS parent_name,
    (SELECT count(DISTINCT lt.listing_id)::int FROM listing_terms lt JOIN listings l ON l.id = lt.listing_id
      WHERE l.status = 'publish' AND (lt.term_id = t.id OR lt.term_id IN (SELECT id FROM terms c WHERE c.parent_id = t.id))) AS count
  FROM terms t LEFT JOIN media m ON m.id = t.image_id LEFT JOIN terms pt ON pt.id = t.parent_id`;

function toCity(r: any) {
  const { keyphrase, tagline, ...seo } = r.seo || {};
  return {
    id: r.id, name: r.name, slug: r.slug, parent_id: r.parent_id, description: r.description, page_id: null,
    featured_image: r.image_url ?? null, category_tagline: tagline || null, custom_uri: r.custom_uri || r.slug,
    count: r.count, is_active: true, wp_term_id: r.wp_id, seo: Object.keys(seo).length ? seo : null, parent_name: r.parent_name,
  };
}

const cities = Router();

cities.get("/", wrap(async (req, res) => {
  const q = req.query as Record<string, string>;
  const p = page(q, 2000);
  const params: unknown[] = [CITY_TAX];
  let where = "t.taxonomy = ANY($1)";
  if (q.search) { params.push(`%${q.search}%`); where += ` AND t.name ILIKE $2`; }
  // Busiest cities first so small limits return the useful ones
  const [items, total] = await Promise.all([
    pool.query(`SELECT * FROM (${CITY_SELECT} WHERE ${where}) x ORDER BY (x.taxonomy = 'listing-city') DESC, x.count DESC, x.name LIMIT ${p.limit} OFFSET ${p.offset}`, params),
    pool.query(`SELECT count(*)::int AS n FROM terms t WHERE ${where}`, params),
  ]);
  res.json(paged(items.rows.map(toCity), total.rows[0].n, p));
}));

cities.get("/uri", wrap(async (req, res) => {
  const path = String(req.query.path || "").replace(/^\/+|\/+$/g, "").toLowerCase();
  const { rows } = path ? await pool.query(`${CITY_SELECT} WHERE t.taxonomy = ANY($1) AND lower(t.custom_uri) = $2 LIMIT 1`, [CITY_TAX, path]) : { rows: [] };
  rows[0] ? res.json(toCity(rows[0])) : res.status(404).json({ error: "Not found" });
}));

// ---------------- blogs ----------------

const BLOG_SELECT = `SELECT p.*, m.url AS image_url FROM posts p LEFT JOIN media m ON m.id = p.featured_media_id`;
const blogSlug = (r: any) => {
  const uri: string = r.seo?.custom_uri || "";
  return uri.startsWith("blog/") && !uri.slice(5).includes("/") ? uri.slice(5) : r.slug;
};

function toBlog(r: any, full = true) {
  const s = r.seo || {};
  return {
    id: r.id, title: r.title, slug: blogSlug(r), excerpt: r.excerpt || null, content: full ? r.content : undefined,
    featured_image: r.image_url ?? null, category: (s.categories || "").split(",")[0].trim() || null, author: "PAJASA",
    reading_time: s.reading_time ? `${s.reading_time} min read` : null,
    tags: s.tags ? String(s.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [],
    is_featured: false, seo: { title: s.title, description: s.description, source_url: s.source_url, canonical: s.canonical },
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

const blogs = Router();

blogs.get("/", wrap(async (req, res) => {
  const q = req.query as Record<string, string>;
  const p = page(q, 500);
  const params: unknown[] = [];
  let where = "p.status = 'publish'";
  if (q.search) { params.push(`%${q.search}%`); where += ` AND p.title ILIKE $${params.length}`; }
  if (q.category) { params.push(`%${q.category}%`); where += ` AND p.seo->>'categories' ILIKE $${params.length}`; }
  const [items, total] = await Promise.all([
    pool.query(`${BLOG_SELECT} WHERE ${where} ORDER BY p.created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, params),
    pool.query(`SELECT count(*)::int AS n FROM posts p WHERE ${where}`, params),
  ]);
  res.json(paged(items.rows.map((r) => toBlog(r, false)), total.rows[0].n, p));
}));

blogs.get("/slug/:slug", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `${BLOG_SELECT} WHERE p.status = 'publish' AND (p.seo->>'custom_uri' = $1 OR p.slug = $2) ORDER BY (p.seo->>'custom_uri' = $1) DESC LIMIT 1`,
    [`blog/${req.params.slug}`, req.params.slug]);
  rows[0] ? res.json(toBlog(rows[0])) : res.status(404).json({ error: "Not found" });
}));
blogs.get("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(`${BLOG_SELECT} WHERE p.status = 'publish' AND p.id = $1`, [Number(req.params.id) || 0]);
  rows[0] ? res.json(toBlog(rows[0])) : res.status(404).json({ error: "Not found" });
}));

export default { properties, cities, blogs };
