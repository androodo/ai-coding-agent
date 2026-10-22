import { runProcess, type Session } from "./tools.ts";

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "agent-change"
  );
}

export async function openPullRequest(
  session: Session,
  args: { title: string; body: string; commit_message: string; branch?: string }
): Promise<string> {
  if (session.touchedFiles.size === 0) {
    return "No files were edited in this session; nothing to commit.";
  }

  const files = [...session.touchedFiles];
  await runProcess("git", ["add", "--", ...files], session.repoRoot);
  const status = await runProcess("git", ["status", "--porcelain"], session.repoRoot);
  if (!status.stdout.trim()) {
    return "Working tree clean after staging; nothing to commit.";
  }

  const branch = args.branch || `agent/${slug(args.title)}`;
  await runProcess("git", ["checkout", "-B", branch], session.repoRoot);
  await runProcess("git", ["commit", "-m", args.commit_message], session.repoRoot);
  await runProcess("git", ["push", "-u", "origin", branch], session.repoRoot);
  const pr = await runProcess(
    "gh",
    ["pr", "create", "--title", args.title, "--body", args.body],
    session.repoRoot
  );
  return `Committed ${files.join(", ")} on ${branch}\n${pr.stdout || pr.stderr}`;
}

export async function maybeFinalizePr(
  session: Session,
  task: string
): Promise<string | undefined> {
  if (session.touchedFiles.size === 0) return undefined;
  const status = await runProcess("git", ["status", "--porcelain"], session.repoRoot);
  if (!status.stdout.trim()) return undefined;
  const allowed = await session.permissions.confirm("open_pr", {
    title: task,
    body: task,
    commit_message: task,
  });
  if (!allowed) return "Skipped opening a pull request.";
  return openPullRequest(session, {
    title: task.slice(0, 72),
    body: `## Summary\n\n${task}\n\nFiles:\n${[...session.touchedFiles].map((f) => `- ${f}`).join("\n")}`,
    commit_message: task.slice(0, 72),
  });
}
