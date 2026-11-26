import { PORTS } from "@blast/shared";
import { buildServer } from "./server.js";

const app = buildServer();
await app.listen({ port: PORTS.agent, host: "127.0.0.1" });
console.log(`agent listening on http://localhost:${PORTS.agent}`);
