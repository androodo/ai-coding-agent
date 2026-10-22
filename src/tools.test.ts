import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PermissionGate } from "./permissions.ts";
import { resolveInsideRepo } from "./paths.ts";
import { toolSchemas } from "./schemas.ts";
import { editFileImpl, readFileImpl, searchCodeImpl, type Session } from "./tools.ts";

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-repo-"));
  await fs.writeFile(path.join(dir, "hello.ts"), "export const n = 1;\n");
  await fs.writeFile(path.join(dir, "notes.md"), "hello\n");
  return dir;
}

function session(repoRoot: string): Session {
  return {
    repoRoot,
    touchedFiles: new Set(),
    permissions: new PermissionGate(true),
  };
}

test("schemas require the core fields", () => {
  assert.deepEqual(toolSchemas.read_file.required, ["path"]);
  assert.deepEqual(toolSchemas.search_code.required, ["action", "pattern"]);
  assert.deepEqual(toolSchemas.edit_file.required, ["path", "new_text"]);
  assert.deepEqual(toolSchemas.run_command.required, ["command"]);
  assert.deepEqual(toolSchemas.open_pr.required, ["title", "body", "commit_message"]);
});

test("paths cannot escape the repo", () => {
  const root = process.cwd();
  assert.throws(() => resolveInsideRepo(root, "../secret"));
});

test("read, glob, and grep work without the model", async () => {
  const repo = await tempRepo();
  const text = await readFileImpl(repo, { path: "hello.ts" });
  assert.match(text, /export const n = 1/);
  const files = await searchCodeImpl(repo, { action: "glob", pattern: "*.ts" });
  assert.match(files, /hello\.ts/);
  const hits = await searchCodeImpl(repo, { action: "grep", pattern: "export const n" });
  assert.match(hits, /hello\.ts:1/);
});

test("edit_file writes a valid patch and tracks the file", async () => {
  const repo = await tempRepo();
  const s = session(repo);
  const result = await editFileImpl(s, {
    path: "hello.ts",
    old_text: "export const n = 1;",
    new_text: "export const n = 2;",
  });
  assert.match(result, /Wrote hello\.ts/);
  const next = await fs.readFile(path.join(repo, "hello.ts"), "utf8");
  assert.equal(next, "export const n = 2;\n");
  assert.deepEqual([...s.touchedFiles], ["hello.ts"]);
});

test("edit_file refuses a broken TypeScript patch", async () => {
  const repo = await tempRepo();
  const s = session(repo);
  const result = await editFileImpl(s, {
    path: "hello.ts",
    new_text: "export const n = {\n",
  });
  assert.match(result, /AST validation failed/);
  const current = await fs.readFile(path.join(repo, "hello.ts"), "utf8");
  assert.equal(current, "export const n = 1;\n");
});

test("permission patterns distinguish commands", () => {
  const gate = new PermissionGate(false);
  assert.equal(gate.patternKey("run_command", { command: "npm test" }), "run_command:npm");
  assert.equal(gate.patternKey("edit_file", { path: "src/a.ts" }), "edit_file:src/a.ts");
});
