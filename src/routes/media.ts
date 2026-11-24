import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { pool } from "../db";
import { wrap } from "../utils";
import { s3Enabled, s3Key, publicUrl, putObject, deleteObject, s3Status } from "../s3";

export const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = /^(image\/(jpeg|png|gif|webp|svg\+xml|avif)|video\/(mp4|webm)|application\/pdf)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
});

const r = Router();

const newName = (original: string) =>
  `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(original).toLowerCase()}`;

// Shows where uploads go (S3 or local disk) - handy for checking the server config
r.get("/status", (_req, res) => res.json(s3Status()));

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
    const name = newName(f.originalname);
    let stored: string, url: string;
    if (s3Enabled) {
      // S3 objects are stored with their full key (contains "/"), local files with a bare filename
      stored = s3Key(name);
      await putObject(stored, f.buffer, f.mimetype);
      url = publicUrl(stored);
    } else {
      await fs.promises.writeFile(path.join(UPLOAD_DIR, name), f.buffer);
      stored = name;
      url = `${base}/uploads/${name}`;
    }
    const { rows } = await pool.query(
      `INSERT INTO media (filename,original_name,url,mime_type,size,title) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [stored, f.originalname, url, f.mimetype, f.size, path.parse(f.originalname).name]
    );
    out.push(rows[0]);
  }
  res.status(201).json(out);
}));

r.put("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE media SET title=$1, alt_text=$2, caption=$3, description=$4 WHERE id=$5 RETURNING *`,
    [String(req.body.title || ""), String(req.body.alt_text || ""), String(req.body.caption || ""), String(req.body.description || ""), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

r.delete("/:id", wrap(async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM media WHERE id=$1 RETURNING filename`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const stored: string = rows[0].filename;
  if (stored.includes("/")) {
    if (s3Enabled) await deleteObject(stored).catch((e) => console.error("S3 delete failed:", stored, e.message));
  } else {
    fs.promises.unlink(path.join(UPLOAD_DIR, stored)).catch(() => {});
  }
  res.status(204).end();
}));

export default r;
