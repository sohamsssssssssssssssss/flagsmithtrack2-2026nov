import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import type { NodePath, TraverseOptions } from "@babel/traverse";
import type * as t from "@babel/types";

const traverse = createRequire(import.meta.url)("@babel/traverse").default as
  (ast: t.Node, visitors: TraverseOptions) => void;
const extensions = [".ts", ".tsx", ".js", ".jsx"];
const ignored = new Set(["node_modules", "dist", "vendor", "coverage", "fixtures"]);
const sdkMethods = new Set(["hasFeature", "isFeatureEnabled", "getValue", "getFeatureValue", "getExperimentFlag"]);
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "all", "use", "options", "head"]);
type Guard = { kind: "if" | "ternary" | "&&"; start_line: number; end_line: number };

export type FlagHit = {
  flag: string; file: string; line: number; function: string | null;
  guard: Guard | null; routes: string[]; confidence: "high" | "low"; via?: string;
};
export type FlagMap = {
  sha: string; generated_at: string;
  flags: Record<string, { hits: FlagHit[]; files: string[]; routes: string[] }>;
  nodes: { id: string; kind: "flag" | "file" | "route"; label: string }[];
  edges: { id: string; source: string; target: string }[];
};

type Call = NodePath<t.CallExpression | t.OptionalCallExpression>;
type Member = NodePath<t.MemberExpression | t.OptionalMemberExpression>;
type Unit = { absolute: string; calls: Call[]; members: Member[]; exports: Map<string, NodePath> };
const sorted = (items: Iterable<string>) => [...new Set(items)].sort();

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    if (entry.name.startsWith(".") || ignored.has(entry.name)) return [];
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.isFile() && extensions.includes(extname(entry.name)) &&
      !/\.(test|spec|d)\.[jt]sx?$/.test(entry.name) ? [fullPath] : [];
  }));
  return paths.flat().sort();
}

const nameOf = (node: t.Node | null | undefined): string | undefined =>
  node?.type === "Identifier" ? node.name : node?.type === "StringLiteral" ? node.value : undefined;
function property(node: t.MemberExpression | t.OptionalMemberExpression) {
  return node.computed && node.property.type !== "StringLiteral" ? undefined : nameOf(node.property);
}
function member(node: t.Node | null | undefined): node is t.MemberExpression | t.OptionalMemberExpression {
  return node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression";
}
function resolveFunction(path: NodePath | undefined): NodePath | undefined {
  if (path?.isFunction()) return path;
  if (path?.isVariableDeclarator()) {
    const value = path.get("init");
    if (value.isFunction()) return value;
  }
  if (path?.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name)?.path;
    if (binding && binding !== path) return resolveFunction(binding);
  }
  return undefined;
}
function functionName(path: NodePath | null | undefined) {
  if (!path) return null;
  const node = path.node;
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    if (node.id) return node.id.name;
  }
  if (node.type === "ObjectMethod" || node.type === "ClassMethod") return nameOf(node.key) ?? null;
  return path.parentPath?.isVariableDeclarator() ? nameOf(path.parentPath.node.id) ?? null : null;
}

function guarded(path: NodePath) {
  for (let child = path, ancestor = path.parentPath; ancestor; child = ancestor, ancestor = ancestor.parentPath) {
    if (ancestor.isFunction()) break;
    if ((ancestor.isIfStatement() || ancestor.isConditionalExpression()) && child.key === "test") {
      return { kind: ancestor.isIfStatement() ? "if" as const : "ternary" as const,
        region: [ancestor.node.consequent, ancestor.node.alternate].filter((branch): branch is t.Node & NonNullable<typeof branch> => !!branch) };
    }
    if (ancestor.isLogicalExpression({ operator: "&&" }) && child.key === "left") {
      return { kind: "&&" as const, region: [ancestor.node.right] };
    }
  }
  return null;
}

// A shared Express handler can return early for one literal req.route.path.
function excludedRoutes(fn: NodePath | null, position: number) {
  const body = fn?.isFunction() && fn.node.body.type === "BlockStatement" ? fn.node.body.body : [];
  return body.flatMap((statement) => {
    if (statement.start! >= position || statement.type !== "IfStatement") return [];
    const { test, consequent } = statement;
    if (consequent.type !== "ReturnStatement" || test.type !== "BinaryExpression" || test.operator !== "===") return [];
    const [route, value] = test.left.type === "StringLiteral" ? [test.right, test.left] : [test.left, test.right];
    return value.type === "StringLiteral" && member(route) && property(route) === "path"
      && member(route.object) && property(route.object) === "route" ? [value.value] : [];
  });
}

function loadUnit(absolute: string, source: string): Unit {
  const ast = parse(source, { sourceType: "unambiguous", errorRecovery: true,
    plugins: [...(absolute.endsWith(".ts") ? [] : ["jsx" as const]),
      ...(absolute.endsWith(".ts") || absolute.endsWith(".tsx") ? ["typescript" as const] : [])] });
  const unit: Unit = { absolute, calls: [], members: [], exports: new Map() };
  traverse(ast, {
    CallExpression: (path) => { unit.calls.push(path); },
    OptionalCallExpression: (path) => { unit.calls.push(path); },
    MemberExpression: (path) => { unit.members.push(path); },
    OptionalMemberExpression: (path) => { unit.members.push(path); },
    ExportNamedDeclaration(path) {
      const decl = path.get("declaration");
      if (decl.isFunctionDeclaration() && decl.node.id) unit.exports.set(decl.node.id.name, decl);
      if (decl.isVariableDeclaration()) for (const item of decl.get("declarations")) {
        const name = nameOf(item.node.id), fn = resolveFunction(item);
        if (name && fn) unit.exports.set(name, fn);
      }
      for (const specifier of path.node.specifiers) if (specifier.type === "ExportSpecifier") {
        const fn = resolveFunction(path.scope.getBinding(specifier.local.name)?.path);
        if (fn) unit.exports.set(nameOf(specifier.exported)!, fn);
      }
    },
    ExportDefaultDeclaration(path) {
      const fn = resolveFunction(path.get("declaration"));
      if (fn) unit.exports.set("default", fn);
    },
  });
  return unit;
}

function routesByFunction(unit: Unit) {
  const routes = new Map<t.Node, Set<string>>();
  function associate(fn: NodePath, route: string) {
    const known = routes.get(fn.node) ?? new Set<string>();
    if (known.has(route)) return;
    known.add(route);
    routes.set(fn.node, known);
    for (const call of unit.calls) if (call.getFunctionParent()?.node === fn.node) {
      const called = resolveFunction(call.get("callee"));
      if (called) associate(called, route);
    }
  }
  for (const call of unit.calls) {
    const { callee, arguments: args } = call.node;
    if (!member(callee) || !httpMethods.has(property(callee) ?? "")) continue;
    const receiver = member(callee.object) ? property(callee.object) : nameOf(callee.object);
    if (!receiver || !/^(app|router)$|Router$/.test(receiver)) continue;
    const route = args[0]?.type === "StringLiteral" ? args[0].value : undefined;
    if (!route?.startsWith("/")) continue;
    for (const handler of call.get("arguments").slice(1)) {
      const fn = resolveFunction(handler);
      if (fn) associate(fn, route);
    }
  }
  return routes;
}

function callFlags(call: Call, keys: Set<string>) {
  const callee = call.node.callee;
  const method = member(callee) ? property(callee) : nameOf(callee);
  const hits = new Map<string, FlagHit["confidence"]>();
  for (const [index, arg] of call.node.arguments.entries()) {
    if (arg.type === "StringLiteral" && keys.has(arg.value)) {
      hits.set(arg.value, index === 0 && sdkMethods.has(method ?? "") ? "high" : hits.get(arg.value) ?? "low");
    } else if (method === "useFlags" && index === 0 && arg.type === "ArrayExpression") {
      for (const value of arg.elements) if (value?.type === "StringLiteral" && keys.has(value.value)) hits.set(value.value, "high");
    }
  }
  return hits;
}

function importedCall(call: Call, unit: Unit, units: Map<string, Unit>) {
  const callee = call.node.callee;
  if (callee.type !== "Identifier") return undefined;
  const binding = call.scope.getBinding(callee.name)?.path;
  if (!binding?.isImportSpecifier() && !binding?.isImportDefaultSpecifier()) return undefined;
  const declaration = binding.parentPath;
  if (!declaration?.isImportDeclaration() || !declaration.node.source.value.startsWith(".")) return undefined;
  const imported = resolve(dirname(unit.absolute), declaration.node.source.value);
  const stem = imported.replace(/\.[jt]sx?$/, "");
  const target = [imported, ...extensions.map((ext) => stem + ext), ...extensions.map((ext) => join(imported, "index" + ext))]
    .map((file) => units.get(file)).find((candidate) => candidate !== undefined);
  const name = binding.isImportSpecifier() ? nameOf(binding.node.imported) : "default";
  const fn = name ? target?.exports.get(name) : undefined;
  return target && fn ? { target, fn } : undefined;
}

export async function mapFlags(repoPath: string, flagKeys: string[]): Promise<FlagMap> {
  const root = resolve(repoPath);
  const keys = new Set(sorted(flagKeys));
  const units = new Map<string, Unit>();
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    try { units.set(file, loadUnit(file, source)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn(`Skipped unsupported syntax in ${relative(root, file)}`);
    }
  }
  const flags: FlagMap["flags"] = Object.fromEntries([...keys].map((flag) => [flag, { hits: [], files: [], routes: [] }]));
  function add(hit: FlagHit) {
    const hits = flags[hit.flag]!.hits;
    const index = hits.findIndex((other) => other.file === hit.file && other.line === hit.line && other.via === hit.via);
    if (index === -1) hits.push(hit);
    else if (hit.confidence === "high") hits[index] = hit;
  }
  for (const unit of units.values()) {
    const routes = routesByFunction(unit);
    const file = relative(root, unit.absolute);
    function record(path: NodePath, flag: string, confidence: FlagHit["confidence"]) {
      const fn = path.getFunctionParent();
      const labels = new Set<string>();
      for (let current: NodePath | null = fn; current; current = current.getFunctionParent()) {
        for (const route of routes.get(current.node) ?? []) labels.add(route);
      }
      for (const route of excludedRoutes(fn, path.node.start!)) labels.delete(route);
      const branches = guarded(path);
      const regions = branches?.region.map((node) => node.loc).filter((loc) => loc !== null && loc !== undefined) ?? [];
      const guard = branches && regions.length ? { kind: branches.kind,
        start_line: Math.min(...regions.map((loc) => loc.start.line)),
        end_line: Math.max(...regions.map((loc) => loc.end.line)) } : null;
      const hit = { flag, file, line: path.node.loc!.start.line, function: functionName(fn),
        guard, routes: sorted(labels), confidence };
      add(hit);
      for (const call of branches ? unit.calls : []) {
        if (!branches?.region.some((node) => call.node.start! >= node.start! && call.node.end! <= node.end!)) continue;
        const target = importedCall(call, unit, units);
        if (target) add({ ...hit, file: relative(root, target.target.absolute), line: target.fn.node.loc!.start.line,
          function: functionName(target.fn), guard: null, confidence: "low", via: `${file}:${hit.line}` });
      }
    }
    for (const call of unit.calls) for (const [flag, confidence] of callFlags(call, keys)) record(call, flag, confidence);
    for (const access of unit.members) {
      const { object } = access.node;
      const flag = property(access.node);
      if (flag && keys.has(flag) && (nameOf(object) === "flags" || (member(object) && property(object) === "flags"))) {
        record(access, flag, "high");
      }
    }
  }
  const nodes = new Map<string, FlagMap["nodes"][number]>();
  const edges = new Map<string, FlagMap["edges"][number]>();
  function node(kind: FlagMap["nodes"][number]["kind"], label: string) {
    const id = `${kind}:${label}`;
    nodes.set(id, { id, kind, label });
    return id;
  }
  function edge(source: string, target: string) {
    const id = `${source}->${target}`;
    edges.set(id, { id, source, target });
  }
  for (const [key, data] of Object.entries(flags)) {
    data.hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    data.files = sorted(data.hits.map((hit) => hit.file));
    data.routes = sorted(data.hits.flatMap((hit) => hit.routes));
    const flag = node("flag", key);
    for (const hit of data.hits) {
      const file = node("file", hit.file);
      edge(flag, file);
      for (const route of hit.routes) edge(file, node("route", route));
    }
  }
  let sha = "unknown";
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { /* Non-git source directories can still be mapped. */ }
  return { sha, generated_at: new Date().toISOString(), flags, nodes: [...nodes.values()], edges: [...edges.values()] };
}

export async function writeFlagMap(root: string, flagKeys: string[], directory = join(root, ".blast")) {
  const result = await mapFlags(root, flagKeys);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `flagmap.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(result, null, 2) + "\n");
  await rename(temp, join(directory, "flagmap.json"));
  return result;
}
