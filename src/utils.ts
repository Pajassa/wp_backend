import { Request, Response, NextFunction } from "express";

export function slugify(s: string): string {
  return s.toLowerCase().trim().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function pgError(err: any, res: Response) {
  if (err?.code === "23505") return res.status(409).json({ error: "Slug already exists" });
  if (err?.code === "23503") return res.status(400).json({ error: "Referenced item does not exist" });
  console.error(err);
  return res.status(500).json({ error: "Server error" });
}
