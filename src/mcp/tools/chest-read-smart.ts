import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChestReadSmartInput } from "../../schemas/chest-read-smart.js";
import { handleReadSmart } from "../read-smart.js";

export async function handleChestReadSmart(
  args: ChestReadSmartInput,
  server: Server,
): Promise<string> {
  return handleReadSmart({ path: args.path, force: args.force ?? false }, server);
}
