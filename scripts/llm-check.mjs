// Lists models at LLM_BASE_URL and tries one tiny chat completion. Never prints the key.
process.loadEnvFile(new URL("../.env", import.meta.url));
const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
if (!LLM_BASE_URL || !LLM_API_KEY) throw new Error("LLM_BASE_URL / LLM_API_KEY missing in .env");
const base = LLM_BASE_URL.replace(/\/$/, "");
const headers = { Authorization: `Bearer ${LLM_API_KEY}`, "Content-Type": "application/json" };

const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
if (!res.ok) throw new Error(`GET /models -> ${res.status}: ${(await res.text()).split(LLM_API_KEY).join("[REDACTED]").slice(0, 300)}`);
const ids = (await res.json()).data.map((m) => m.id).sort();
console.log("models:\n  " + ids.join("\n  "));

// Code-capable first, then the rest; LLM_MODEL (if set) goes first.
const ranked = [...ids.filter((i) => /code/i.test(i)), ...ids.filter((i) => !/code|image|imagine|vision|embed|tts|audio/i.test(i)).reverse()];
const candidates = [...new Set([LLM_MODEL, ...ranked].filter(Boolean))].slice(0, 4);

for (const model of candidates) {
  const t0 = Date.now();
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "Reply with the single word: pong" }] }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ ok: false, status: e.name }));
  if (r.ok) {
    const j = await r.json();
    console.log(`OK   ${model} (${Date.now() - t0} ms): ${JSON.stringify(j.choices?.[0]?.message?.content)}`);
    process.exit(0);
  }
  console.log(`FAIL ${model}: ${r.status}`);
}
console.log("no candidate model worked");
process.exit(1);
