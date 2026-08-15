import { Router } from "express";
import type { Store } from "../session/store.js";

// router exposes the session endpoints backed by a store.
export function router(store: Store): Router {
  const r = Router();
  r.get("/session", (req, res) => {
    const v = store.get(String(req.query.key ?? ""));
    if (v === null) return res.status(404).end();
    res.send(v);
  });
  r.post("/session", (req, res) => {
    store.set(String(req.body.key ?? ""), String(req.body.value ?? ""));
    res.status(204).end();
  });
  return r;
}
