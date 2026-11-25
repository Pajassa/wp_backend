import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";

// Single admin login for the dashboard. Credentials come from env:
//   ADMIN_USER, ADMIN_PASSWORD, AUTH_SECRET (random string used to sign tokens)
const env = (k: string) => (process.env[k] || "").trim();
const TTL = 7 * 24 * 3600 * 1000; // 7 days
const secret = () => env("AUTH_SECRET") || crypto.createHash("sha256").update("pajasa:" + env("ADMIN_PASSWORD") + env("DATABASE_PASSWORD")).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (data: string) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");
const same = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest(), y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

export function makeToken(user: string) {
  const payload = b64(JSON.stringify({ u: user, exp: Date.now() + TTL }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !same(sig, sign(payload))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return exp > Date.now() ? u : null;
  } catch { return null; }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization || "";
  const user = h.startsWith("Bearer ") ? verifyToken(h.slice(7)) : null;
  if (!user) return res.status(401).json({ error: "Please log in" });
  next();
}

// Basic brute-force protection: 10 failed attempts per IP per 15 minutes
const fails = new Map<string, { n: number; until: number }>();

export const authRoutes = Router();
authRoutes.post("/login", (req, res) => {
  const ip = req.ip || "?";
  const f = fails.get(ip);
  if (f && f.until > Date.now() && f.n >= 10) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const user = String(req.body?.username || ""), pass = String(req.body?.password || "");
  if (!env("ADMIN_USER") || !env("ADMIN_PASSWORD")) return res.status(500).json({ error: "Login is not configured on the server (ADMIN_USER / ADMIN_PASSWORD)." });
  if (!(same(user, env("ADMIN_USER")) && same(pass, env("ADMIN_PASSWORD")))) {
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 15 * 60 * 1000 };
    cur.n++; fails.set(ip, cur);
    return res.status(401).json({ error: "Wrong username or password" });
  }
  fails.delete(ip);
  res.json({ token: makeToken(user), user });
});
authRoutes.get("/me", requireAuth, (_req, res) => res.json({ ok: true }));
