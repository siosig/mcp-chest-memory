import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChestReadSmartInput } from "../../schemas/chest-read-smart.js";
import { handleReadSmart } from "../read-smart.js";
import type { SnapshotStore } from "../snapshot-store.js";

export async function handleChestReadSmart(
  args: ChestReadSmartInput,
  server: Server,
  store: SnapshotStore,
): Promise<string> {
  return handleReadSmart({ path: args.path, force: args.force ?? false }, server, store);
}
