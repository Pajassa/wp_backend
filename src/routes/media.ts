import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { pool } from "../db";
import { wrap } from "../utils";

export const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = /^(image\/(jpeg|png|gif|webp|svg\+xml|avif)|video\/(mp4|webm)|application\/pdf)$/;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
});

const r = Router();

r.get("/", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM media WHERE original_name ILIKE $1 OR title ILIKE $1 ORDER BY created_at DESC`,
    [`%${(req.query.q as string) || ""}%`]
  );
  res.json(rows);
}));

r.post("/", upload.array("files", 20), wrap(async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) return res.status(400).json({ error: "No valid files uploaded (images, mp4/webm, pdf; max 20MB)" });
  const base = process.env.PUBLIC_URL || "";
  const out = [];
  for (const f of files) {
    const { rows } = await pool.query(
      `INSERT INTO media (filename,original_name,url,mime_type,size,title) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [f.filename, f.originalname, `${base}/uploads/${f.filename}`, f.mimetype, f.size, path.parse(f.originalname).name]
    );
    out.push(rows[0]);
  }
  res.status(201).json(out);
}));

r.put("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE media SET title=$1, alt_text=$2 WHERE id=$3 RETURNING *`,
    [String(req.body.title || ""), String(req.body.alt_text || ""), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

r.delete("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM media WHERE id=$1 RETURNING filename`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  fs.promises.unlink(path.join(UPLOAD_DIR, rows[0].filename)).catch(() => {});
  res.status(204).end();
}));

export default r;
