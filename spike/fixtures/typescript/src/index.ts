import express from "express";
import { openStore } from "./session/store.js";
import { router } from "./http/router.js";

// index wires the express app and the session store.
export const app = express();

const store = openStore("data/sessions.db");

app.use("/api", router(store));

const port = Number(process.env.PORT ?? 8080);
export function main(): void {
  app.listen(port, () => console.log(`listening :${port}`));
}
