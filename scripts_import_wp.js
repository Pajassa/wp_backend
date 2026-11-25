// Import a converted WordPress export (export.json) into the dashboard DB + S3.
// Usage: node scripts_import_wp.js <export.json> <uploadsDir> files|db
require("dotenv/config");
const fs = require("fs"), path = require("path");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const [, , EXPORT, UPDIR, MODE] = process.argv;
const E = JSON.parse(fs.readFileSync(EXPORT, "utf8"));
const env = (k) => (process.env[k] || "").trim();
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm" };

async function files() {
  const s3 = new S3Client({ region: env("AWS_REGION") });
  const done = new Set(fs.existsSync(EXPORT + ".uploaded") ? fs.readFileSync(EXPORT + ".uploaded", "utf8").split("\n") : []);
  const todo = E.uploads.filter((f) => !done.has(f));
  const log = fs.createWriteStream(EXPORT + ".uploaded", { flags: "a" });
  let n = 0, fail = 0;
  console.log(`uploading ${todo.length} files (${done.size - 1 > 0 ? done.size - 1 : 0} already done)`);
  const worker = async () => {
    while (todo.length) {
      const rel = todo.shift();
      try {
        await s3.send(new PutObjectCommand({ Bucket: env("AWS_S3_BUCKET"), Key: "uploads/wp-media/wp/" + rel,
          Body: fs.readFileSync(path.join(UPDIR, rel)), ContentType: TYPES[path.extname(rel).slice(1).toLowerCase()] || "application/octet-stream",
          CacheControl: "public, max-age=31536000, immutable" }));
        log.write(rel + "\n");
      } catch (e) { fail++; console.error("FAIL", rel, e.message); }
      if (++n % 250 === 0) console.log(n, "done");
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  console.log("uploaded", n - fail, "failed", fail);
}

async function db() {
  const pool = new Pool({ host: env("DATABASE_HOST"), port: +env("DATABASE_PORT") || 5432, database: env("DATABASE_NAME"), user: env("DATABASE_USER"), password: env("DATABASE_PASSWORD"), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`
      ALTER TABLE media ADD COLUMN IF NOT EXISTS wp_id INTEGER UNIQUE;
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS wp_id INTEGER UNIQUE;
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS seo JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE listings ADD COLUMN IF NOT EXISTS wp_id INTEGER UNIQUE;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS wp_id INTEGER UNIQUE;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS seo JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE media ADD COLUMN IF NOT EXISTS caption TEXT NOT NULL DEFAULT '';
      ALTER TABLE media ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';`);
    await c.query("BEGIN");
    const mediaId = {};
    for (const m of E.media) {
      const r = await c.query(`INSERT INTO media (wp_id,filename,original_name,url,mime_type,size,title,alt_text,caption,description,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (wp_id) DO UPDATE SET filename=$2,original_name=$3,url=$4,mime_type=$5,size=$6,title=$7,alt_text=$8,caption=$9,description=$10 RETURNING id`,
        [m.wp_id, m.filename, m.original_name, m.url, m.mime_type, m.size, m.title, m.alt_text, m.caption, m.description, m.created_at + "Z"]);
      mediaId[m.wp_id] = r.rows[0].id;
    }
    console.log("media", Object.keys(mediaId).length);
    const termId = {};
    for (const t of E.terms) {
      const r = await c.query(`INSERT INTO terms (wp_id,taxonomy,name,slug,description,image_id,custom_uri,seo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (taxonomy,slug) DO UPDATE SET wp_id=$1,name=$3,description=$5,image_id=COALESCE($6,terms.image_id),custom_uri=$7,seo=$8 RETURNING id`,
        [t.wp_id, t.taxonomy, t.name, t.slug, t.description, mediaId[t.image_wp] ?? null, t.custom_uri, t.seo]);
      termId[t.wp_id] = r.rows[0].id;
    }
    for (const t of E.terms) await c.query(`UPDATE terms SET parent_id=$1 WHERE id=$2`, [termId[t.parent_wp] ?? null, termId[t.wp_id]]);
    console.log("terms", Object.keys(termId).length);
    let nl = 0;
    for (const l of E.listings) {
      const { gallery_wp, ...d } = l.details;
      d.gallery = gallery_wp.map((g) => mediaId[g]).filter(Boolean);
      const r = await c.query(`INSERT INTO listings (wp_id,title,slug,content,excerpt,status,featured,featured_media_id,price,price_label,details,seo,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (slug) DO UPDATE SET wp_id=$1,title=$2,content=$4,excerpt=$5,status=$6,featured=$7,featured_media_id=$8,price=$9,price_label=$10,details=$11,seo=$12,created_at=$13,updated_at=$14 RETURNING id`,
        [l.wp_id, l.title, l.slug, l.content, l.excerpt, l.status, l.featured, mediaId[l.image_wp] ?? null, l.price, l.price_label, d, l.seo, l.created_at + "Z", l.updated_at + "Z"]);
      const id = r.rows[0].id;
      await c.query(`DELETE FROM listing_terms WHERE listing_id=$1`, [id]);
      const tids = l.term_wp.map((t) => termId[t]).filter(Boolean);
      if (tids.length) await c.query(`INSERT INTO listing_terms (listing_id,term_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`, [id, tids]);
      nl++;
    }
    console.log("listings", nl);
    let np = 0;
    for (const p of E.posts) {
      await c.query(`INSERT INTO posts (wp_id,title,slug,content,excerpt,status,featured_media_id,seo,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (slug) DO UPDATE SET wp_id=$1,title=$2,content=$4,excerpt=$5,status=$6,featured_media_id=$7,seo=$8,created_at=$9,updated_at=$10`,
        [p.wp_id, p.title, p.slug, p.content, p.excerpt, p.status, mediaId[p.image_wp] ?? null, p.seo, p.created_at + "Z", p.updated_at + "Z"]);
      np++;
    }
    console.log("posts", np);
    // Listings without a city/area term in WP: link them using their old URL (in/<city>/<area>/<slug>)
    const fix = await c.query(`INSERT INTO listing_terms (listing_id, term_id)
      SELECT l.id, t.id FROM listings l
      JOIN LATERAL (SELECT string_to_array(l.details->>'custom_uri','/') p) u ON true
      JOIN terms t ON t.taxonomy IN ('listing-city','listing-area')
        AND lower(t.custom_uri) IN (lower(array_to_string(u.p[1:2],'/')), lower(array_to_string(u.p[1:3],'/')))
      WHERE array_length(u.p,1) >= 3 AND NOT EXISTS (SELECT 1 FROM listing_terms lt JOIN terms x ON x.id=lt.term_id
        WHERE lt.listing_id=l.id AND x.taxonomy IN ('listing-city','listing-area'))
      ON CONFLICT DO NOTHING`);
    console.log("city links from URL", fix.rowCount);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); await pool.end(); }
}

(MODE === "files" ? files() : db()).catch((e) => { console.error(e); process.exit(1); });
