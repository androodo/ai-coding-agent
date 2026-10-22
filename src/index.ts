#!/usr/bin/env npx tsx
import { resolveRepoRoot } from "./paths.ts";
import { runAgent } from "./agent.ts";

function usage(): never {
  console.log(`Usage: ai-coding-agent --repo <path> [options] <task>

Options:
  --repo <path>       Git repository to work in (required)
  --yes               Allow every write, shell command, and PR without prompting
  --no-pr             Do not open a pull request after the run
  --max-turns <n>     Abort after this many agent turns (default 30)
  --model <id>        Claude model id (optional)

Requires ANTHROPIC_API_KEY. Preference: use a TTY so permission prompts work.
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let repo: string | undefined;
  let yes = false;
  let noPr = false;
  let maxTurns = 30;
  let model: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i];
    else if (arg === "--yes") yes = true;
    else if (arg === "--no-pr") noPr = true;
    else if (arg === "--max-turns") maxTurns = Number(argv[++i]);
    else if (arg === "--model") model = argv[++i];
    else if (arg === "-h" || arg === "--help") usage();
    else rest.push(arg);
  }

  const task = rest.join(" ").trim();
  if (!repo || !task || !Number.isFinite(maxTurns) || maxTurns < 1) usage();
  return { repo, yes, noPr, maxTurns, model, task };
}

const args = parseArgs(process.argv.slice(2));
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY before running the agent.");
  process.exit(1);
}

const code = await runAgent({
  repoRoot: resolveRepoRoot(args.repo),
  task: args.task,
  yes: args.yes,
  noPr: args.noPr,
  maxTurns: args.maxTurns,
  model: args.model,
});
process.exit(code);
