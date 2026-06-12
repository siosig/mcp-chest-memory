// Remote snapshot persistence: forwards the read_smart diff cache to the REST
// backend through the same ToolExecutor port the rest of the system uses.
//
// The file itself is read client-side (in the MCP server, under the client's
// roots); only these snapshot rows cross the network. Persistence rides the
// existing /api/tools/_snapshot_* plumbing — no second transport, no new auth.

import type { ToolExecutor } from "../core/executor.js";
import type { FactRow, SnapshotRow, SnapshotStore, SnapshotUpsert } from "./snapshot-store.js";

interface SnapshotGetResult {
  ok?: boolean;
  snapshot?: SnapshotRow | null;
  facts?: FactRow[];
}

export class RemoteSnapshotStore implements SnapshotStore {
  constructor(private readonly executor: ToolExecutor) {}

  async get(path: string): Promise<{ snapshot: SnapshotRow | null; facts: FactRow[] }> {
    const raw = await this.executor.execute("_snapshot_get", { path });
    const out = JSON.parse(raw) as SnapshotGetResult;
    return { snapshot: out.snapshot ?? null, facts: out.facts ?? [] };
  }

  async put(input: SnapshotUpsert): Promise<void> {
    await this.executor.execute("_snapshot_put", input);
  }

  async touch(path: string, mtime?: number): Promise<void> {
    await this.executor.execute("_snapshot_touch", mtime === undefined ? { path } : { path, mtime });
  }
}
