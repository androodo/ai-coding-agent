export function streamMessage(message: unknown): void {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  const msg = message as { type: string; [key: string]: unknown };

  if (msg.type === "stream_event") {
    const event = msg.event as {
      type?: string;
      delta?: { type?: string; text?: string };
      content_block?: { type?: string; name?: string };
    };
    if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
      process.stdout.write(`\n\n→ ${shortName(event.content_block.name ?? "tool")}`);
    }
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
      process.stdout.write(event.delta.text ?? "");
    }
    return;
  }

  if (msg.type === "result") {
    const subtype = String(msg.subtype ?? "");
    const result = typeof msg.result === "string" ? msg.result : "";
    console.log(`\n\n── ${subtype || "done"} ──`);
    if (result) console.log(result);
  }
}

function shortName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}
