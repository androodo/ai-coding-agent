import fs from "node:fs";
import path from "node:path";

export function resolveRepoRoot(input: string): string {
  const root = path.resolve(input);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Repo path is not a directory: ${root}`);
  }
  return root;
}

export function resolveInsideRepo(repoRoot: string, target: string): string {
  const resolved = path.resolve(repoRoot, target);
  const rel = path.relative(repoRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the target repo: ${target}`);
  }
  return resolved;
}
