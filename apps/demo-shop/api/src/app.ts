import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { CheckoutReplay, type FlagSnapshot } from "@blast/shared";
import { fuzzyMatch, products } from "./catalog.js";
import { applyDiscount } from "./checkout/applyDiscount.js";
import { createTelemetry } from "./telemetry.js";

type Evaluate = (identity: string, cohort: string | undefined) => Promise<FlagSnapshot>;

declare global {
  namespace Express {
    interface Request {
      flags: FlagSnapshot;
      identity: string;
    }
  }
}

export function buildApp(evaluate: Evaluate, telemetry = createTelemetry()): Express {
  const app = express();
  app.use(async (req, res, next) => {
    req.identity = req.get("x-identity") || "anonymous";
    req.flags = {};
    res.on("finish", () => {
      telemetry.record(Date.now(), req.route?.path ?? "(unmatched)", req.flags, res.statusCode >= 500);
    });
    req.flags = await evaluate(req.identity, req.get("x-cohort"));
    next();
  });

  app.use(express.json());
  app.get("/api/health", (_req, res) => { res.json({ ok: true, demo: true }); });
  app.get("/api/products", (_req, res) => { res.json(products); });
  app.get("/api/search", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    res.json(products.filter(({ name }) => {
      const normalized = name.toLowerCase();
      return req.flags.smart_search?.enabled ? fuzzyMatch(query, normalized) : normalized.includes(query);
    }));
  });
  app.get("/api/recs", (req, res) => {
    res.json(req.flags.recs_v2?.enabled ? [products[3], products[2]] : products.slice(0, 2));
  });
  app.get("/api/config", (req, res) => {
    const banner = req.flags.promo_banner;
    const shipping = req.flags.free_shipping_threshold;
    const threshold = Number(shipping?.value);
    res.json({
      banner: banner?.enabled ? String(banner.value || "Make room for a little glow.") : null,
      free_shipping_threshold: shipping?.enabled && shipping.value != null && Number.isFinite(threshold)
        ? threshold : null,
    });
  });

  const priceCart: RequestHandler = (req, res) => {
    const { items, discountCode } = req.body ?? {};
    if (!Array.isArray(items) || (discountCode !== undefined && typeof discountCode !== "string")) {
      return res.status(400).json({ error: "Provide items and an optional discount code." });
    }

    let subtotal = 0;
    for (const item of items) {
      const product = products.find(({ id }) => id === item?.id);
      if (!product || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        return res.status(400).json({ error: "Each item needs a valid product ID and quantity from 1 to 99." });
      }
      subtotal += product.price * item.quantity;
    }
    if (req.route.path === "/api/cart") return res.json({ items, subtotal });
    if (!items.length) return res.status(400).json({ error: "Your cart is empty." });

    const total = req.flags.new_checkout?.enabled
      ? applyDiscount(subtotal, discountCode)
      : discountCode?.trim().toUpperCase() === "LUMEN10" ? Math.round(subtotal * 0.9) : subtotal;
    return res.json({ total });
  };
  app.post("/api/cart", priceCart);
  app.post("/api/checkout", priceCart);

  const handleError: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.status >= 400 && error.status < 500) {
      res.status(error.status).json({ error: "Invalid request body." });
      return;
    }
    const simulated = req.get("x-simulated") === "1";
    const route = req.route?.path ?? req.path;
    const recorded = simulated && route === "/api/checkout"
      ? CheckoutReplay.safeParse({ method: req.method, body: req.body }) : undefined;
    telemetry.error({
      ts: Date.now(),
      identity: req.identity,
      route,
      message: error.message,
      stack: error.stack ?? "",
      flags: req.flags,
      source: "server",
      simulated,
      replay: recorded?.data,
    });
    res.status(500).json({ error: "Something went wrong. Please try again." });
  };
  app.use(handleError);
  return app;
}
