import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

function userMessage(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}

export function registerChestPrompts(mcpServer: McpServer): void {
  mcpServer.registerPrompt(
    "summarize-session",
    {
      title: "Summarize the session into 6-layer structured memories",
      description:
        "Turn a chat session transcript into structured memories. Produces up to 6 memories (one per layer) capturing goal/context/emotion/implementation/realize/learning. Use at session end.",
      argsSchema: {
        transcript: z.string().describe("The session transcript text. Free-form."),
        entity_hint: z
          .string()
          .optional()
          .describe("Optional canonical entity name to attach the memories to."),
      },
    },
    async (args) => {
      const transcript = args.transcript ?? "";
      const entityHint = args.entity_hint ? `\n\nFocus entity: ${args.entity_hint}` : "";
      return {
        description: "Summarize the session into 6-layer structured memories.",
        messages: [
          userMessage(`You are an agent-memory writer. Read the session transcript below and propose memories to save. Output a JSON array; each item has {entity_name, entity_kind, layer, content, importance}.

Layers (use exactly one per memory):
- goal: WHY this work exists, target outcome
- context: WHY THIS NOW, situation, timing
- emotion: USER tone, feelings expressed
- implementation: HOW it was done, what worked, what failed
- realize: PAIN lesson, "never X" / "always Y" — these are protected from forgetting
- learning: GROWTH, decisions made, insights

Rules:
- Max 6 entries (one per layer). Skip layers with nothing worth saving.
- Importance 0-1. Set 0.9+ to pin (use sparingly).
- Realizes must be 1 sentence and start with a verb.
- Quote nothing verbatim; summarize.

Transcript:
${transcript}${entityHint}`),
        ],
      };
    },
  );

  mcpServer.registerPrompt(
    "extract-realizes",
    {
      title: "Extract realize-layer pain lessons",
      description:
        'Scan a body of text (post-mortem, error log, decision doc) and propose realize-layer memories — concise pain lessons starting with verbs ("Never", "Always", "Watch out"). Returns JSON list of realizes.',
      argsSchema: {
        text: z.string().describe("Source text (post-mortem, debug session, retro). Free-form."),
        entity_hint: z.string().optional().describe("Optional canonical entity name for the realizes."),
      },
    },
    async (args) => {
      const text = args.text ?? "";
      const entityHint = args.entity_hint ? `\n\nFocus entity: ${args.entity_hint}` : "";
      return {
        description: "Extract realize-layer pain lessons.",
        messages: [
          userMessage(`You are a realize extractor. Read the source text below and output a JSON list of realizes. Each realize:
- Starts with a verb ("Never", "Always", "Watch out", "Reject", "Confirm")
- Is one sentence
- Is concrete (a specific failure mode, not abstract advice)
- Captures something the reader does NOT want to relearn the hard way

Output format: [{"content": "Never X when Y, because Z", "importance": 0.7-1.0}]

Source text:
${text}${entityHint}`),
        ],
      };
    },
  );

  mcpServer.registerPrompt(
    "weekly-consolidation",
    {
      title: "Weekly consolidation summary",
      description:
        "Sleep-mode summary of the past week's memories for an entity. Produces a single learning-layer entry that captures the trajectory.",
      argsSchema: {
        entity_name: z.string().describe("The entity to consolidate."),
        week_offset: z
          .string()
          .optional()
          .describe("Weeks-ago offset (0 = this week, 1 = last week). Default 0."),
      },
    },
    async (args) => {
      const entityName = args.entity_name ?? "<entity>";
      const weekOffset = args.week_offset ?? "0";
      return {
        description: `Consolidate the last week of memories for ${entityName}.`,
        messages: [
          userMessage(`Consolidate the past week's memories for entity "${entityName}" (week_offset=${weekOffset}).

Step 1: Call chest_recall(query="${entityName}", entity_name="${entityName}", max_tokens=4000) to retrieve recent memories.
Step 2: Read the returned memories and produce ONE learning-layer summary that captures:
  - What we set out to do (goal trajectory)
  - What actually happened (implementation summary)
  - What we learned (1-3 insights)
  - Any realizes we should never forget (preserve these — do NOT consolidate them away)

Step 3: Output a JSON object {entity_name, layer:"learning", content, importance:0.7}.

Do not write to memory directly — just return the JSON. The user will choose whether to save.`),
        ],
      };
    },
  );

  mcpServer.registerPrompt(
    "recall-and-write",
    {
      title: "Memory-before-action discipline",
      description:
        "Before writing code, draft a doc, or making a decision: recall relevant memories first, then produce the answer with explicit citations to the recalled memory_ids.",
      argsSchema: {
        task: z.string().describe("What you are about to do (code task, decision, doc draft). One sentence."),
        entity_hint: z.string().optional().describe("Optional entity to focus recall on."),
      },
    },
    async (args) => {
      const task = args.task ?? "<task>";
      const entityHint = args.entity_hint ?? "";
      const recallCmd = entityHint
        ? `chest_recall(query="${task}", entity_name="${entityHint}", max_tokens=2000)`
        : `chest_recall(query="${task}", max_tokens=2000)`;
      return {
        description: "Memory-before-action discipline.",
        messages: [
          userMessage(`Before doing this task, recall first.

Task: ${task}

Step 1: Call ${recallCmd}.
Step 2: Skim the returned memories. Identify any realizes that apply.
Step 3: Produce your output with INLINE citations to relevant memory_ids: e.g. "Use better-sqlite3 v12+ [memory:1234] because v11 breaks on Node 24 [memory:5678]."
Step 4: If you found NO relevant memories, say so explicitly: "No prior memories on this — proceeding from first principles."

Goal: never solve a problem twice without checking.`),
        ],
      };
    },
  );

  mcpServer.registerPrompt(
    "entity-handoff",
    {
      title: "Produce a handoff document for an entity",
      description:
        "Produce a handoff document for an entity: name, kind, key memories per layer, current open questions, and next steps.",
      argsSchema: {
        entity_name: z.string().describe("The entity to hand off."),
        audience: z
          .string()
          .optional()
          .describe('Who receives the handoff (default "new claude session").'),
      },
    },
    async (args) => {
      const entityName = args.entity_name ?? "<entity>";
      const audience = args.audience ?? "new claude session";
      return {
        description: `Produce a handoff document for ${entityName}.`,
        messages: [
          userMessage(`Produce a handoff document for entity "${entityName}", aimed at: ${audience}.

Step 1: Call chest_recall(query="${entityName}", entity_name="${entityName}", max_tokens=6000).
Step 2: Skim memories grouped by layer.
Step 3: Output a markdown doc with these sections:
  - **Identity**: name, kind, canonical key (if any)
  - **Goal** (from goal-layer memories): what this entity is for
  - **State** (from latest implementation memories): where things stand right now
  - **Realizes** (from realize-layer memories): what NEVER to do, with memory_id citations
  - **Open questions**: things the prior session left unresolved
  - **Suggested next steps**: 3 concrete actions for the audience

Keep it under 1 page. Cite memory_ids inline like [memory:1234].`),
        ],
      };
    },
  );
}
