import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";

const require = createRequire(import.meta.url);

let ready = false;
const languages = new Map<string, Language>();

const EXT_TO_WASM: Record<string, string> = {
  js: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  mjs: "tree-sitter-javascript.wasm",
  cjs: "tree-sitter-javascript.wasm",
  ts: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  py: "tree-sitter-python.wasm",
  json: "tree-sitter-json.wasm",
  rs: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  rb: "tree-sitter-ruby.wasm",
  c: "tree-sitter-c.wasm",
  h: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  cc: "tree-sitter-cpp.wasm",
  hpp: "tree-sitter-cpp.wasm",
};

export type AstError = {
  type: string;
  startLine: number;
  startColumn: number;
  text: string;
};

async function initParser(): Promise<void> {
  if (ready) return;
  const wasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
  await Parser.init({
    locateFile: (file: string) => (file === "tree-sitter.wasm" ? wasm : file),
  });
  ready = true;
}

function wasmDir(): string {
  return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

export function grammarForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_TO_WASM[ext];
}

async function loadLanguage(wasmFile: string): Promise<Language> {
  const cached = languages.get(wasmFile);
  if (cached) return cached;
  await initParser();
  const lang = await Language.load(path.join(wasmDir(), wasmFile));
  languages.set(wasmFile, lang);
  return lang;
}

function collectErrors(node: { type: string; isError: boolean; startPosition: { row: number; column: number }; text: string; children: unknown[] }, out: AstError[]): void {
  if (node.isError || node.type === "ERROR") {
    out.push({
      type: node.type,
      startLine: node.startPosition.row + 1,
      startColumn: node.startPosition.column + 1,
      text: node.text.slice(0, 120),
    });
  }
  for (const child of node.children as typeof node[]) {
    collectErrors(child, out);
  }
}

export async function validateSource(filePath: string, source: string): Promise<AstError[] | null> {
  const wasmFile = grammarForPath(filePath);
  if (!wasmFile) return null;
  const language = await loadLanguage(wasmFile);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) return [{ type: "ERROR", startLine: 1, startColumn: 1, text: "parser returned no tree" }];
  const errors: AstError[] = [];
  collectErrors(tree.rootNode as never, errors);
  return errors;
}

export async function querySource(
  filePath: string,
  source: string,
  querySourceText: string
): Promise<string> {
  const wasmFile = grammarForPath(filePath);
  if (!wasmFile) {
    throw new Error(`No tree-sitter grammar for ${path.extname(filePath) || filePath}`);
  }
  const language = await loadLanguage(wasmFile);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) throw new Error("Failed to parse file");
  const query = language.query(querySourceText);
  const matches = query.matches(tree.rootNode);
  const lines: string[] = [];
  for (const match of matches) {
    for (const cap of match.captures) {
      const { row, column } = cap.node.startPosition;
      lines.push(
        `${path.basename(filePath)}:${row + 1}:${column + 1} @${cap.name} ${cap.node.type} ${JSON.stringify(cap.node.text.slice(0, 80))}`
      );
    }
  }
  return lines.join("\n") || "(no matches)";
}
