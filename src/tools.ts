import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import fg from "fast-glob";
import { z } from "zod";
import { querySource, validateSource } from "./ast.ts";
import type { PermissionGate } from "./permissions.ts";
import { resolveInsideRepo } from "./paths.ts";

export type Session = {
  repoRoot: string;
  touchedFiles: Set<string>;
  permissions: PermissionGate;
};

const MAX_READ = 200_000;

export const TOOL_SERVER = "coding";

export const MCP_TOOLS = {
  read_file: `mcp__${TOOL_SERVER}__read_file`,
  search_code: `mcp__${TOOL_SERVER}__search_code`,
  edit_file: `mcp__${TOOL_SERVER}__edit_file`,
  run_command: `mcp__${TOOL_SERVER}__run_command`,
  open_pr: `mcp__${TOOL_SERVER}__open_pr`,
} as const;

export const READ_ONLY_TOOLS = [MCP_TOOLS.read_file, MCP_TOOLS.search_code];
export const ALL_TOOLS = Object.values(MCP_TOOLS);

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function runShell(command: string, cwd: string, timeoutMs: number) {
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
  });
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function readFileImpl(
  repoRoot: string,
  args: { path: string; offset?: number; limit?: number }
): Promise<string> {
  const filePath = resolveInsideRepo(repoRoot, args.path);
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const start = Math.max(1, args.offset ?? 1);
  const count = args.limit ?? lines.length;
  const slice = lines.slice(start - 1, start - 1 + count);
  const numbered = slice.map((line, i) => `${String(start + i).padStart(6)}|${line}`).join("\n");
  const clipped = numbered.length > MAX_READ ? `${numbered.slice(0, MAX_READ)}\n… truncated` : numbered;
  return `${path.relative(repoRoot, filePath)} (${lines.length} lines)\n${clipped}`;
}

export async function searchCodeImpl(
  repoRoot: string,
  args: {
    action: "glob" | "grep" | "ast";
    pattern: string;
    path?: string;
    max_results?: number;
  }
): Promise<string> {
  const max = args.max_results ?? 50;
  const scope = args.path ? resolveInsideRepo(repoRoot, args.path) : repoRoot;

  if (args.action === "glob") {
    const matches = await fg(args.pattern, {
      cwd: repoRoot,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      onlyFiles: true,
      absolute: false,
    });
    return matches.slice(0, max).join("\n") || "(no files)";
  }

  if (args.action === "grep") {
    try {
      const result = await runProcess(
        "rg",
        [
          "--line-number",
          "--no-heading",
          "--color",
          "never",
          "--glob",
          "!node_modules/**",
          "--glob",
          "!.git/**",
          "-m",
          String(max),
          args.pattern,
          scope,
        ],
        repoRoot
      );
      const out = (result.stdout || result.stderr).trim();
      return out || "(no matches)";
    } catch {
      const files = await fg("**/*", {
        cwd: scope,
        ignore: ["**/node_modules/**", "**/.git/**"],
        onlyFiles: true,
        absolute: true,
      });
      const rx = new RegExp(args.pattern);
      const hits: string[] = [];
      for (const file of files) {
        const text = await fs.readFile(file, "utf8").catch(() => "");
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
          if (hits.length < max && rx.test(line)) {
            hits.push(`${path.relative(repoRoot, file)}:${i + 1}:${line}`);
          }
        });
        if (hits.length >= max) break;
      }
      return hits.join("\n") || "(no matches)";
    }
  }

  const files = await fg(args.path ?? "**/*.{ts,tsx,js,jsx,py,json}", {
    cwd: repoRoot,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
    absolute: true,
  });
  const chunks: string[] = [];
  for (const file of files.slice(0, 40)) {
    const source = await fs.readFile(file, "utf8");
    try {
      const found = await querySource(file, source, args.pattern);
      if (found !== "(no matches)") {
        chunks.push(`${path.relative(repoRoot, file)}\n${found}`);
      }
    } catch (err) {
      chunks.push(`${path.relative(repoRoot, file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (chunks.length >= max) break;
  }
  return chunks.join("\n\n") || "(no matches)";
}

export async function editFileImpl(
  session: Session,
  args: { path: string; new_text: string; old_text?: string; verify_command?: string }
): Promise<string> {
  const allowed = await session.permissions.confirm("edit_file", {
    path: args.path,
    old_text: args.old_text,
    new_text: args.new_text,
  });
  if (!allowed) return "Permission denied by user.";

  const filePath = resolveInsideRepo(session.repoRoot, args.path);
  let next = args.new_text;
  if (args.old_text !== undefined) {
    const current = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!current.includes(args.old_text)) {
      return `old_text not found in ${args.path}`;
    }
    next = current.replace(args.old_text, args.new_text);
  }

  const astErrors = await validateSource(filePath, next);
  if (astErrors && astErrors.length > 0) {
    return [
      "AST validation failed; file was not written.",
      ...astErrors.map(
        (err) => `ERROR ${err.type} at ${err.startLine}:${err.startColumn}: ${err.text}`
      ),
    ].join("\n");
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next, "utf8");
  session.touchedFiles.add(path.relative(session.repoRoot, filePath));

  let verify = "";
  if (args.verify_command) {
    const cmdAllowed = await session.permissions.confirm("run_command", {
      command: args.verify_command,
    });
    if (!cmdAllowed) {
      verify = "\nverify_command skipped: permission denied";
    } else {
      const result = await runShell(args.verify_command, session.repoRoot, 120_000);
      verify = `\nverify_command exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    }
  }

  const astNote = astErrors === null ? " (no grammar for this extension; skipped AST check)" : "";
  return `Wrote ${args.path}${astNote}.${verify}`;
}

export async function runCommandImpl(
  session: Session,
  args: { command: string; timeout_ms?: number }
): Promise<string> {
  const allowed = await session.permissions.confirm("run_command", { command: args.command });
  if (!allowed) return "Permission denied by user.";
  const result = await runShell(args.command, session.repoRoot, args.timeout_ms ?? 60_000);
  return `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

export function createToolServer(session: Session) {
  const read_file = tool(
    "read_file",
    "Read a UTF-8 file inside the target repository. Optional 1-based offset/limit for line windows.",
    {
      path: z.string().describe("Path relative to the repo root"),
      offset: z.number().int().positive().optional().describe("1-based start line"),
      limit: z.number().int().positive().optional().describe("Max lines to return"),
    },
    async (args) => {
      try {
        return textResult(await readFileImpl(session.repoRoot, args));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } }
  );

  const search_code = tool(
    "search_code",
    "Explore the repo. action=glob lists files, grep searches with ripgrep (regex), ast runs a tree-sitter query.",
    {
      action: z.enum(["glob", "grep", "ast"]).describe("Exploration mode"),
      pattern: z.string().describe("Glob, regex, or tree-sitter query depending on action"),
      path: z.string().optional().describe("Optional subdirectory, file, or glob relative to the repo"),
      max_results: z.number().int().positive().max(200).optional(),
    },
    async (args) => {
      try {
        return textResult(await searchCodeImpl(session.repoRoot, args));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } }
  );

  const edit_file = tool(
    "edit_file",
    "Write or patch a file. If old_text is set, replace that substring; otherwise overwrite with new_text. Re-parses with tree-sitter and refuses writes that introduce ERROR nodes. Optional verify_command runs tests afterwards.",
    {
      path: z.string(),
      new_text: z.string().describe("Replacement text, or full file contents when old_text is omitted"),
      old_text: z.string().optional().describe("Exact substring to replace"),
      verify_command: z.string().optional().describe("Shell command to run after a successful write, e.g. npm test"),
    },
    async (args) => {
      try {
        const result = await editFileImpl(session, args);
        const failed = result.startsWith("AST validation failed") || result.startsWith("Permission denied") || result.includes("not found");
        return textResult(result, failed);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }
  );

  const run_command = tool(
    "run_command",
    "Run a shell command in the target repository. Use for tests, linters, and git inspection. Destructive commands require permission.",
    {
      command: z.string(),
      timeout_ms: z.number().int().positive().max(300_000).optional(),
    },
    async (args) => {
      try {
        const result = await runCommandImpl(session, args);
        return textResult(result, result.startsWith("Permission denied"));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }
  );

  const open_pr = tool(
    "open_pr",
    "Stage only files this agent touched, commit, push a feature branch, and open a GitHub pull request with gh.",
    {
      title: z.string(),
      body: z.string(),
      commit_message: z.string(),
      branch: z.string().optional(),
    },
    async (args) => {
      try {
        const allowed = await session.permissions.confirm("open_pr", args);
        if (!allowed) return textResult("Permission denied by user.", true);
        const { openPullRequest } = await import("./git.ts");
        return textResult(await openPullRequest(session, args));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }
  );

  return createSdkMcpServer({
    name: TOOL_SERVER,
    version: "0.1.0",
    tools: [read_file, search_code, edit_file, run_command, open_pr],
  });
}

export { runProcess };
