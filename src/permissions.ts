import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type RiskTool = "edit_file" | "run_command" | "open_pr";

export class PermissionGate {
  private readonly always = new Set<string>();
  private readonly justAllowed = new Set<string>();

  constructor(private readonly autoAllow: boolean) {}

  patternKey(tool: RiskTool, input: Record<string, unknown>): string {
    if (tool === "edit_file") {
      return `edit_file:${String(input.path ?? "*")}`;
    }
    if (tool === "run_command") {
      const command = String(input.command ?? "");
      const prefix = command.trim().split(/\s+/, 1)[0] ?? command;
      return `run_command:${prefix}`;
    }
    return "open_pr";
  }

  markAllowed(tool: RiskTool, details: Record<string, unknown>): void {
    this.justAllowed.add(this.patternKey(tool, details));
  }

  async confirm(tool: RiskTool, details: Record<string, unknown>): Promise<boolean> {
    const key = this.patternKey(tool, details);
    if (this.justAllowed.delete(key)) return true;
    if (this.autoAllow || this.always.has(key) || this.always.has(tool)) {
      return true;
    }

    if (!input.isTTY) {
      throw new Error(
        `Refusing ${tool} without a TTY. Re-run with --yes or approve interactively.`
      );
    }

    console.log(`\n[permission] ${tool}`);
    for (const [name, value] of Object.entries(details)) {
      const rendered = typeof value === "string" ? clip(value, 400) : JSON.stringify(value);
      console.log(`  ${name}: ${rendered}`);
    }
    console.log("Allow? [o]nce / [a]lways this pattern / [t]ool always / [n]o");

    const rl = readline.createInterface({ input, output });
    try {
      const answer = (await rl.question("> ")).trim().toLowerCase();
      if (answer === "a") {
        this.always.add(key);
        return true;
      }
      if (answer === "t") {
        this.always.add(tool);
        return true;
      }
      if (answer === "o" || answer === "y" || answer === "yes") {
        return true;
      }
      return false;
    } finally {
      rl.close();
    }
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n  … (${text.length - max} more chars)`;
}
