import express from "express";
import { PORTS } from "@blast/shared";

const app = express();
app.use(express.json());
app.get("/api/health", (_req, res) => { res.json({ ok: true, demo: true }); });
app.listen(PORTS.shopApi, () => console.log(`demo-shop api (DEMO) on http://localhost:${PORTS.shopApi}`));
