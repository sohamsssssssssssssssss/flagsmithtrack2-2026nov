import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { type FlagSnapshot } from "@blast/shared";
import { api, reportError, startFlags } from "./browser";
import "./shop.css";

type Product = { id: string; name: string; price: number; icon: string };
type Config = { banner: string | null; free_shipping_threshold: number | null };
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, { componentStack }: ErrorInfo) {
    reportError(error, componentStack ?? "");
  }
  render() {
    return this.state.failed
      ? <main><h1>The shop ran into a problem</h1><button onClick={() => location.reload()}>Reload shop</button></main>
      : this.props.children;
  }
}

function Shop() {
  const [products, setProducts] = useState<Product[]>([]);
  const [recs, setRecs] = useState<Product[]>([]);
  const [config, setConfig] = useState<Config>();
  const [flags, setFlags] = useState<FlagSnapshot>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Product[]>();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [discount, setDiscount] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const items = Object.entries(cart).filter(([, quantity]) => quantity > 0)
    .map(([id, quantity]) => ({ id, quantity }));
  const subtotal = products.reduce((sum, product) => sum + product.price * (cart[product.id] ?? 0), 0);

  useEffect(() => {
    startFlags(setFlags);
    void Promise.all([
      api<Product[]>("products").then(setProducts),
      api<Product[]>("recs").then(setRecs),
      api<Config>("config").then(setConfig),
    ]).catch((error: Error) => setNotice(error.message));
  }, []);

  function changeCart(id: string, delta: number) {
    const next = { ...cart, [id]: Math.max(0, Math.min(99, (cart[id] ?? 0) + delta)) };
    setCart(next);
    setNotice("");
    void api("cart", {
      items: Object.entries(next).filter(([, count]) => count > 0).map(([itemId, quantity]) => ({ id: itemId, quantity })),
    }).catch((error: Error) => setNotice(error.message));
  }

  const banner = flags.promo_banner
    ? flags.promo_banner.enabled && String(flags.promo_banner.value || "Make room for a little glow.")
    : config?.banner;

  return (
    <main>
      <header><h1>Lumen Shop</h1><span className="badge">DEMO</span></header>
      {banner && <p className="banner">{banner}</p>}
      <div className="layout">
        <section aria-label="Catalog">
          <form className="search" onSubmit={(event) => {
            event.preventDefault();
            void api<Product[]>(`search?q=${encodeURIComponent(query)}`)
              .then(setResults).catch((error: Error) => setNotice(error.message));
          }}>
            <input aria-label="Search products" placeholder="Search products" value={query}
              onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setResults(undefined); }} />
            <button>Search</button>
          </form>
          <div className="grid">
            {(results ?? products).map((product) => (
              <article key={product.id}>
                <div className="product-art" aria-hidden="true">{product.icon}</div>
                <h2>{product.name}</h2>
                <div className="product-footer"><span>{money(product.price)}</span>
                  <button disabled={busy} aria-label={`Add ${product.name}`} onClick={() => changeCart(product.id, 1)}>Add</button>
                </div>
              </article>
            ))}
            {results?.length === 0 && <p>No products match your search.</p>}
          </div>
          <h2>Recommended</h2>
          <div className="recs">
            {recs.map((product) => <button key={product.id} disabled={busy} onClick={() => changeCart(product.id, 1)}>
              <span aria-hidden="true">{product.icon}</span> Add {product.name}
            </button>)}
          </div>
        </section>
        <aside>
          <h2>Your cart</h2>
          {items.length === 0 && <p>Your cart is empty.</p>}
          {items.map(({ id, quantity }) => {
            const name = products.find((product) => product.id === id)?.name ?? id;
            return <div className="line-item" key={id}>
              <span>{name} × {quantity}</span>
              <button disabled={busy} aria-label={`Remove one ${name}`} onClick={() => changeCart(id, -1)}>−</button>
            </div>;
          })}
          <p><strong>Subtotal {money(subtotal)}</strong></p>
          {config?.free_shipping_threshold != null && <p>Free shipping on orders of {money(config.free_shipping_threshold * 100)} or more.</p>}
          <form onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setNotice("");
            try {
              const receipt = await api<{ total: number }>("checkout", {
                items, ...(discount.trim() ? { discountCode: discount.trim() } : {}),
              });
              setNotice(`Order placed for ${money(receipt.total)}.`);
              setCart({});
              setDiscount("");
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}>
            <label htmlFor="discount">Discount code</label>
            <input id="discount" value={discount} onChange={(event) => setDiscount(event.target.value)} />
            <button disabled={!items.length || busy}>{busy ? "Checking out…" : "Checkout"}</button>
          </form>
          <p role="status">{notice}</p>
        </aside>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!, {
  onCaughtError: () => {}, // ErrorBoundary reports caught errors with the component stack.
}).render(<ErrorBoundary><Shop /></ErrorBoundary>);
