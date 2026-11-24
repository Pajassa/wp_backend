import { Pool } from "pg";
import "dotenv/config";

export const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT) || 5432,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export const TAXONOMIES = {
  "listing-category": "Listing Categories",
  "listing-type": "Listing Types",
  "listing-city": "Listing Cities",
  "listing-area": "Listing Areas",
  "listing-features": "Listing Features",
  "listing-status": "Listing Status",
} as const;
export type Taxonomy = keyof typeof TAXONOMIES;

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      url TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      alt_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS terms (
      id SERIAL PRIMARY KEY,
      taxonomy TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES terms(id) ON DELETE SET NULL,
      image_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (taxonomy, slug)
    );
    ALTER TABLE media ADD COLUMN IF NOT EXISTS caption TEXT NOT NULL DEFAULT '';
    ALTER TABLE media ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE terms ADD COLUMN IF NOT EXISTS custom_uri TEXT NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','publish')),
      featured BOOLEAN NOT NULL DEFAULT false,
      featured_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      price NUMERIC(12,2),
      price_label TEXT NOT NULL DEFAULT 'night',
      details JSONB NOT NULL DEFAULT '{}',
      seo JSONB NOT NULL DEFAULT '{}',
      appearance JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS listing_terms (
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
      PRIMARY KEY (listing_id, term_id)
    );
    CREATE INDEX IF NOT EXISTS listing_terms_term_idx ON listing_terms(term_id);
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','publish')),
      featured_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS seo JSONB NOT NULL DEFAULT '{}';
  `);
}
