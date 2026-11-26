import flagsmith from "@flagsmith/flagsmith";
import { INGEST, type ErrorEvent, type FlagSnapshot } from "@blast/shared";

const identity = sessionStorage.getItem("lumen-identity") ?? `shop-${crypto.randomUUID()}`;
sessionStorage.setItem("lumen-identity", identity);
const cohort = "storefront";
const uiFlags = ["promo_banner"];

export function startFlags(onChange: (flags: FlagSnapshot) => void) {
  const environmentID = import.meta.env.FLAGSMITH_ENV_KEY;
  if (!environmentID) return;
  void flagsmith.init({
    environmentID,
    identity,
    traits: { cohort },
    onChange: () => {
      onChange(Object.fromEntries(uiFlags.map((key) => [
        key, { enabled: flagsmith.hasFeature(key), value: flagsmith.getValue(key) ?? null },
      ])));
    },
  }).catch(() => {});
}

export function reportError(reason: unknown, componentStack = "") {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const flags: FlagSnapshot = Object.fromEntries(Object.entries(flagsmith.getAllFlags() ?? {})
    .map(([name, flag]) => [name, { enabled: flag.enabled, value: flag.value ?? null }]));
  const event: ErrorEvent = {
    ts: Date.now(), identity, route: location.pathname, message: error.message,
    stack: [error.stack, componentStack].filter(Boolean).join("\n"), flags,
    source: "browser", simulated: false,
  };
  void fetch(INGEST.error, {
    method: "POST",
    headers: { "content-type": "application/json", "x-identity": identity },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => {});
}

window.onerror = (message, _file, _line, _column, error) => reportError(error ?? message);
window.addEventListener("unhandledrejection", (event) => reportError(event.reason));

export async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-identity": identity, "x-cohort": cohort, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? "The shop is temporarily unavailable.");
  return json;
}
