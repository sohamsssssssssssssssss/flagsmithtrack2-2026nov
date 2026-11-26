import { useEffect, useMemo, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, Position, type Edge, type Node } from "@xyflow/react";
import type { FlagMap } from "../../../packages/mapper/src/index";
import { api, type Flag, type IncidentDetail } from "./model";
import "@xyflow/react/dist/style.css";
import "./map.css";

const columns = { flag: 0, file: 310, route: 650 };
const colors = { on: "#78ddb0", off: "#a7afbd", suspect: "#f4c078", guilty: "#ff795f" };
type FlagStatus = keyof typeof colors;

export function MapView({ flags, incident }: { flags: Flag[]; incident: IncidentDetail | null }) {
  const [map, setMap] = useState<FlagMap | null>(null);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => void api<FlagMap>("/api/map").then((result) => {
      if (active) { setMap(result); setError(""); }
    }).catch((error: Error) => {
      if (active) setError(error.message);
    });
    load();
    const timer = setInterval(load, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const live = useMemo(() => new Map(flags.map((flag) => [flag.flag_key, flag.state])), [flags]);
  const statuses = useMemo(() => {
    const values = new Map<string, FlagStatus>();
    const active = incident?.status === "open" ? incident : null;
    for (const key of Object.keys(map?.flags ?? {})) {
      const state = live.get(key);
      const flagOn = state?.enabled || state?.overrides.some((override) => override.enabled);
      const candidate = active?.ranking.find((item) => item.flag === key);
      values.set(key, active?.confidence === "confident" && active.top_flag === key ? "guilty"
        : candidate && (candidate.score > 0 || active?.top_flag === key) ? "suspect" : flagOn ? "on" : "off");
    }
    return values;
  }, [map, incident, live]);

  const { nodes, edges } = useMemo(() => {
    const index = { flag: 0, file: 0, route: 0 };
    const nodes: Node[] = (map?.nodes ?? []).map((node) => {
      const status = node.kind === "flag" ? statuses.get(node.label) : undefined;
      return { id: node.id, position: { x: columns[node.kind], y: index[node.kind]++ * 65 },
        sourcePosition: Position.Right, targetPosition: Position.Left,
        type: node.kind === "flag" ? "input" : node.kind === "route" ? "output" : "default",
        draggable: false, className: `map-node map-${node.kind} ${status ? `map-${status}` : ""}`,
        ariaLabel: status ? `${node.label}, ${status}` : node.label,
        data: { label: <span title={node.label}>{node.kind === "file"
          ? node.label.split("/").slice(-2).join("/") : node.label}</span> } };
    });
    const edges: Edge[] = (map?.edges ?? []).map((edge) => {
      const status = statuses.get(edge.source.replace(/^flag:/, ""));
      const stroke = status === "guilty" || status === "suspect" ? colors[status] : "#465362";
      return { ...edge, style: { stroke, strokeWidth: status === "guilty" ? 2.2 : 1.3 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke } };
    });
    return { nodes, edges };
  }, [map, statuses]);
  const focus = selected ?? incident?.top_flag ?? Object.keys(map?.flags ?? {})[0];
  const detail = focus ? map?.flags[focus] : undefined;
  const state = focus ? live.get(focus) : undefined;

  async function refresh() {
    setRefreshing(true); setError("");
    try { setMap(await api<FlagMap>("/api/map/refresh", {})); }
    catch (error) { setError(error instanceof Error ? error.message : "Map refresh failed"); }
    finally { setRefreshing(false); }
  }

  return <>
    <div className="map-toolbar">
      <div className="map-legend">{Object.entries(colors).map(([status, color]) =>
        <span key={status}><i style={{ background: color }} />{status}</span>)}</div>
      <button onClick={refresh} disabled={refreshing}>{refreshing ? "Scanning…" : "Refresh map"}</button>
    </div>
    {error && <p className="banner" role="status">{error}</p>}
    <div className="map-layout">
      <section className="panel graph" aria-label="Flag dependency map">
        <div className="panel-heading"><h2>Flag dependencies</h2>
          {map && <span className="count">{nodes.length} nodes · {edges.length} links</span>}</div>
        {map ? <div className="flow">
          <ReactFlow key={map.sha + nodes.map((node) => node.id).join("|")} nodes={nodes} edges={edges}
            colorMode="dark" fitView fitViewOptions={{ padding: .14, maxZoom: 1.25 }}
            minZoom={.2} nodesConnectable={false} proOptions={{ hideAttribution: true }}
            onNodeClick={(_, node) => { if (node.id.startsWith("flag:")) setSelected(node.id.slice(5)); }}>
            <Background color="#343d47" gap={22} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div> : <p className="empty-line">Waiting for the agent’s generated map.</p>}
      </section>
      <aside className="panel map-inspector">
        <div className="panel-heading"><h2>Flag details</h2></div>
        {map && focus && detail ? <div className="inspector-body">
          <select aria-label="Inspect flag" value={focus} onChange={(event) => setSelected(event.target.value)}>
            {Object.keys(map.flags).map((flag) => <option key={flag}>{flag}</option>)}
          </select>
          <p>Live default <strong>{state ? state.enabled ? "On" : "Off" : "Unavailable"}</strong></p>
          {state?.overrides.map((item) => <p key={item.segment_id}>Segment {item.segment_id}
            <strong>{item.enabled ? "On" : "Off"}</strong></p>)}
          <p className="eyebrow">Code references · {detail.hits.length}</p>
          {!detail.hits.length && <p className="muted">No references found.</p>}
          <ol>{detail.hits.map((hit) => <li key={`${hit.file}:${hit.line}:${hit.via ?? ""}`}>
            <code>{hit.file}:{hit.line}</code>
            <small>{hit.confidence} confidence{hit.function ? ` · ${hit.function}` : ""}</small>
            {hit.guard && <small>{hit.guard.kind} · lines {hit.guard.start_line}–{hit.guard.end_line}</small>}
            {hit.routes.length > 0 && <small>{hit.routes.join(", ")}</small>}
          </li>)}</ol>
        </div> : <p className="empty-line">Select a flag to inspect its references and live state.</p>}
      </aside>
    </div>
  </>;
}
