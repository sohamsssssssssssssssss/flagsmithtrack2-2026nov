import type { Cohort } from "./identities.js";
import type { RateLimiter } from "./limiter.js";
import type { TrafficStats } from "./stats.js";

export type SimulatedUser = { identity: string; cohort: Cohort };

export type ShopSessionOptions = {
  baseUrl: string;
  limiter: RateLimiter;
  stats: TrafficStats;
  discountRate: number;
  random?: () => number;
  timeoutMs?: number;
  /** Lets Ctrl+C stop a session between steps instead of after all five. */
  isStopped?: () => boolean;
};

type CartItem = { id: string; quantity: number };

const SEARCH_CHANCE = 0.6;
const RECS_CHANCE = 0.55;
const CONFIG_CHANCE = 0.2;
// LUMEN10 is the Lumen Shop promo code; other codes exercise the lookup too.
const DISCOUNT_CODES = ["LUMEN10", "LUMEN10", "GLOW15"] as const;
const SEARCHES = ["lamp", "mug", "planter", "throw", "glow", "dune", "grove"] as const;
const FALLBACK_PRODUCT_IDS = ["glow", "dune", "grove", "drift"] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Products may come back as an array or wrapped (e.g. { products: [...] }). */
function extractProductIds(json: unknown): string[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { products?: unknown }).products)
      ? ((json as { products: unknown[] }).products as unknown[])
      : [];

  const ids: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.productId ?? record.slug;
    if (typeof id === "string" && id.length > 0) ids.push(id);
    else if (typeof id === "number") ids.push(String(id));
  }
  return ids;
}

function buildItems(products: unknown, random: () => number): CartItem[] {
  const ids = extractProductIds(products);
  const pool = ids.length > 0 ? ids : [...FALLBACK_PRODUCT_IDS];
  const wanted = 1 + Math.floor(random() * 2);
  const items = new Map<string, number>();

  for (let i = 0; i < wanted; i += 1) {
    const id = pool[Math.floor(random() * pool.length)] as string;
    const quantity = 1 + Math.floor(random() * 2);
    items.set(id, Math.min(2, (items.get(id) ?? 0) + quantity));
  }

  return [...items].map(([id, quantity]) => ({ id, quantity }));
}

/**
 * One realistic shopping session:
 * [config] -> products -> [search] -> [recs] -> cart -> checkout[+discount].
 * Shop/network failures are counted, never thrown.
 */
export class ShopSession {
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly stats: TrafficStats;
  private readonly discountRate: number;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly isStopped: (() => boolean) | undefined;

  constructor(options: ShopSessionOptions) {
    this.baseUrl = options.baseUrl;
    this.limiter = options.limiter;
    this.stats = options.stats;
    this.discountRate = options.discountRate;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.isStopped = options.isStopped;
  }

  async run(user: SimulatedUser): Promise<void> {
    if (this.stopped()) return;

    if (this.random() < CONFIG_CHANCE) {
      await this.request(user, "GET", "/api/config");
      await this.think();
      if (this.stopped()) return;
    }

    const products = await this.request(user, "GET", "/api/products");
    await this.think();
    if (this.stopped()) return;

    if (this.random() < SEARCH_CHANCE) {
      const query = SEARCHES[Math.floor(this.random() * SEARCHES.length)] as string;
      await this.request(user, "GET", `/api/search?q=${encodeURIComponent(query)}`);
      await this.think();
      if (this.stopped()) return;
    }

    if (this.random() < RECS_CHANCE) {
      await this.request(user, "GET", "/api/recs");
      await this.think();
      if (this.stopped()) return;
    }

    const items = buildItems(products, this.random);
    await this.request(user, "POST", "/api/cart", { items });
    await this.think();
    if (this.stopped()) return;

    if (this.random() < this.discountRate) {
      const discountCode = DISCOUNT_CODES[Math.floor(this.random() * DISCOUNT_CODES.length)] as string;
      await this.request(user, "POST", "/api/checkout", { items, discountCode });
    } else {
      await this.request(user, "POST", "/api/checkout", { items });
    }
  }

  private stopped(): boolean {
    return this.isStopped?.() === true;
  }

  private async think(): Promise<void> {
    await delay(100 + this.random() * 350);
  }

  private async request(
    user: SimulatedUser,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (this.stopped()) return null;
    await this.limiter.acquire();
    if (this.stopped()) return null;

    const headers: Record<string, string> = {
      "x-identity": user.identity,
      "x-cohort": user.cohort,
      "x-simulated": "1",
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), init);
    } catch {
      this.stats.recordFailure();
      return null;
    }

    this.stats.recordStatus(response.status);
    if (!response.ok) {
      try {
        await response.arrayBuffer();
      } catch {
        // ignore: the status is already counted
      }
      return null;
    }

    try {
      const text = await response.text();
      return text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      return null;
    }
  }
}
