# AI Coding Agent

A small terminal coding agent: it takes a plain-English task, explores a git repo, edits files through a Claude tool loop, and can open a pull request.

The five tools are **yours**, not Claude Code's built-ins. The SDK only runs the plan-act-observe loop. Permission prompts, AST checks, and `gh pr create` live in this repo.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

Ripgrep (`rg`) and GitHub CLI (`gh`) are optional but used when present. Without `rg`, grep falls back to a Node walk. Without `gh`, `open_pr` fails with the process error.

## Run

```bash
npx tsx src/index.ts --repo /path/to/your/repo "Add a README section about the API"
```

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | Target git repository |
| `--yes` | Skip permission prompts (allow everything) |
| `--no-pr` | Do not auto-open a PR after the run |
| `--max-turns <n>` | Stop after N model turns (default 30) |
| `--model <id>` | Override the Claude model |

Permission prompts (writes, shell, PRs):

- `o` allow once
- `a` allow this pattern for the rest of the session (`edit_file` by path, `run_command` by binary)
- `t` allow this tool for the rest of the session
- `n` deny

## What happens on a run

1. `query()` starts with **no built-in tools** (`tools: []`).
2. Claude can only call `read_file`, `search_code`, `edit_file`, `run_command`, `open_pr` on the in-process MCP server `coding`.
3. Reads are auto-approved. Writes and shell go through `canUseTool` and then the same gate inside the tool (the second check is skipped if you already allowed it).
4. `edit_file` re-parses the new source with tree-sitter. If the root tree contains `ERROR` nodes, the write is rejected and the errors are returned to the model.
5. Optional `verify_command` (or a later `run_command`) feeds test output back into the next turn.
6. `open_pr` stages **only** files this session wrote, commits, pushes a feature branch, and runs `gh pr create`. If the model forgets to call it, the CLI offers the same flow at the end.

## Coding tools

| Tool | What it does |
| --- | --- |
| `read_file` | Reads a UTF-8 file inside the target repository. You can request a specific line window with a 1-based `offset` and a `limit`. |
| `search_code` | Explores the repository in one of three modes: `glob` lists matching files, `grep` searches file contents with a regular expression, and `ast` runs a tree-sitter query. |
| `edit_file` | Writes or patches a repository file. Provide `old_text` to replace that exact substring, or omit it to write the full contents from `new_text`. Tree-sitter validation rejects edits that introduce syntax errors when a grammar is available. An optional `verify_command` runs after a successful write. |
| `run_command` | Runs a shell command from the target repository, for example to run tests, a linter, or inspect Git state. The command requires permission and has a configurable timeout. |
| `open_pr` | Stages only files the agent edited, commits them, pushes a feature branch, and creates a GitHub pull request using `gh`. This tool requires permission and GitHub CLI availability. |

## Tests

```bash
npm test
```

These exercise the tools without calling the API: path sandboxing, glob/grep, a valid patch, and a rejected broken AST.

## Layout

- `src/index.ts` — CLI
- `src/agent.ts` — SDK `query()` loop and streaming
- `src/tools.ts` — tool implementations
- `src/schemas.ts` — JSON Schema for the five tools
- `src/permissions.ts` — allow-once / allow-always
- `src/ast.ts` — tree-sitter parse + query
- `src/git.ts` — commit / push / PR
