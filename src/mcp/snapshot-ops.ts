// Internal snapshot-cache tools (DB-only; never exposed as MCP tools).
//
// These back RemoteSnapshotStore: the MCP server reads the file locally and
// forwards only the snapshot rows to the backend, which executes these against
// its SQLite store via the same LocalExecutor that runs every other tool. They
// touch no filesystem, so they are safe to serve on the REST backend (unlike
// chest_read_smart itself, which stays fail-closed there).

import { z } from "zod";

import { LocalSnapshotStore } from "./snapshot-store.js";

export const SnapshotGetInputSchema = z.object({ path: z.string().min(1) }).strict();
export const SnapshotPutInputSchema = z
  .object({
    path: z.string().min(1),
    content_hash: z.string().min(1),
    mtime: z.number().int(),
    size_bytes: z.number().int(),
    chunks: z.string(),
  })
  .strict();
export const SnapshotTouchInputSchema = z
  .object({ path: z.string().min(1), mtime: z.number().int().optional() })
  .strict();

export type SnapshotGetInput = z.infer<typeof SnapshotGetInputSchema>;
export type SnapshotPutInput = z.infer<typeof SnapshotPutInputSchema>;
export type SnapshotTouchInput = z.infer<typeof SnapshotTouchInputSchema>;

const store = new LocalSnapshotStore();

export async function handleSnapshotGet(args: SnapshotGetInput): Promise<string> {
  const { snapshot, facts } = await store.get(args.path);
  return JSON.stringify({ ok: true, snapshot, facts });
}

export async function handleSnapshotPut(args: SnapshotPutInput): Promise<string> {
  await store.put(args);
  return JSON.stringify({ ok: true });
}

export async function handleSnapshotTouch(args: SnapshotTouchInput): Promise<string> {
  await store.touch(args.path, args.mtime);
  return JSON.stringify({ ok: true });
}
