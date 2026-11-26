// Stub: static scan flag -> code regions (tech spec 3.1). Implemented in B7.
export interface FlagMap {
  flags: string[];
  nodes: unknown[];
  edges: unknown[];
}

export async function mapFlags(_repoPath: string, flagKeys: string[]): Promise<FlagMap> {
  return { flags: flagKeys, nodes: [], edges: [] };
}
