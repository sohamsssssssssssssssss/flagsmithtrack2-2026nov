import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFlagMap } from "./index.js";

const root = resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2] ?? ".");
const { features } = JSON.parse(await readFile(join(root, "config/flags.json"), "utf8")) as {
  features: Record<string, number>;
};
const map = await writeFlagMap(root, Object.keys(features));
const hits = Object.values(map.flags).reduce((total, flag) => total + flag.hits.length, 0);
console.log(`Mapped ${Object.keys(map.flags).length} flags, ${hits} hits, ${map.nodes.length} nodes, ${map.edges.length} edges.`);
