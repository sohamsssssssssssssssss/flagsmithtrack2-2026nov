import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { AGENT_URL, INGEST, PORTS, SHOP_API_URL } from "@blast/shared";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const { FLAGSMITH_ENV_KEY } = loadEnv(mode, root, "FLAGSMITH_ENV_KEY");
  return {
    plugins: [react()],
    define: { "import.meta.env.FLAGSMITH_ENV_KEY": JSON.stringify(FLAGSMITH_ENV_KEY ?? "") },
    server: {
      port: PORTS.shopWeb,
      strictPort: true,
      proxy: { "/api": SHOP_API_URL, [INGEST.error]: AGENT_URL },
    },
  };
});
