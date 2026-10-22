import { query } from "@anthropic-ai/claude-agent-sdk";
import { maybeFinalizePr } from "./git.ts";
import { PermissionGate } from "./permissions.ts";
import { streamMessage } from "./stream.ts";
import {
  MCP_TOOLS,
  READ_ONLY_TOOLS,
  TOOL_SERVER,
  createToolServer,
  type Session,
} from "./tools.ts";

export type AgentOptions = {
  repoRoot: string;
  task: string;
  yes: boolean;
  noPr: boolean;
  maxTurns: number;
  model?: string;
};

const SYSTEM = `You are a coding agent working in a real git repository.

Loop: plan → explore → edit → verify → revise until the task is done or you must abort.
Use only these tools:
- read_file: open a file
- search_code: glob files, ripgrep, or tree-sitter AST queries
- edit_file: patch or write a file (the harness rejects syntactically broken patches)
- run_command: tests, linters, git status — not for editing files
- open_pr: stage touched files, commit, push, and open a GitHub PR

Rules:
- Stay inside the target repo. Prefer the smallest correct patch.
- After edits, run tests (edit_file.verify_command or run_command) and fix failures.
- If a tool returns an error, diagnose it and retry instead of repeating the same call.
- When the work is complete, call open_pr with a precise commit message and PR body.
- If you cannot complete the task, say why and stop.`;

function isRiskTool(name: string): boolean {
  return (
    name === MCP_TOOLS.edit_file ||
    name === MCP_TOOLS.run_command ||
    name === MCP_TOOLS.open_pr
  );
}

function riskName(name: string): "edit_file" | "run_command" | "open_pr" {
  if (name.endsWith("edit_file")) return "edit_file";
  if (name.endsWith("run_command")) return "run_command";
  return "open_pr";
}

export async function runAgent(opts: AgentOptions): Promise<number> {
  const session: Session = {
    repoRoot: opts.repoRoot,
    touchedFiles: new Set(),
    permissions: new PermissionGate(opts.yes),
  };
  const server = createToolServer(session);

  const q = query({
    prompt: opts.task,
    options: {
      cwd: opts.repoRoot,
      settingSources: [],
      tools: [],
      systemPrompt: SYSTEM,
      maxTurns: opts.maxTurns,
      model: opts.model,
      includePartialMessages: true,
      mcpServers: { [TOOL_SERVER]: server },
      allowedTools: READ_ONLY_TOOLS,
      permissionMode: "default",
      canUseTool: async (toolName, input) => {
        if (!isRiskTool(toolName)) {
          return { behavior: "allow", updatedInput: input };
        }
        const risk = riskName(toolName);
        const ok = await session.permissions.confirm(risk, input);
        if (!ok) {
          return { behavior: "deny", message: "User denied this tool call." };
        }
        session.permissions.markAllowed(risk, input);
        return { behavior: "allow", updatedInput: input };
      },
    },
  });

  let failed = false;
  try {
    for await (const message of q) {
      streamMessage(message);
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "result" &&
        "subtype" in message &&
        message.subtype !== "success"
      ) {
        failed = true;
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }

  const openedPr = [...session.touchedFiles].length > 0 && !opts.noPr;
  // If the model already opened a PR, git will report a clean tree.
  if (openedPr && session.touchedFiles.size > 0) {
    try {
      const extra = await maybeFinalizePr(session, opts.task);
      if (extra) console.log(`\n${extra}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
    }
  }

  return failed ? 2 : 0;
}
