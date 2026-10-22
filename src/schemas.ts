export const toolSchemas = {
  read_file: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Path relative to the repo root" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
  },
  search_code: {
    type: "object",
    additionalProperties: false,
    required: ["action", "pattern"],
    properties: {
      action: { type: "string", enum: ["glob", "grep", "ast"] },
      pattern: { type: "string" },
      path: { type: "string" },
      max_results: { type: "integer", minimum: 1, maximum: 200 },
    },
  },
  edit_file: {
    type: "object",
    additionalProperties: false,
    required: ["path", "new_text"],
    properties: {
      path: { type: "string" },
      new_text: { type: "string" },
      old_text: { type: "string" },
      verify_command: { type: "string" },
    },
  },
  run_command: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1, maximum: 300000 },
    },
  },
  open_pr: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body", "commit_message"],
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      commit_message: { type: "string" },
      branch: { type: "string" },
    },
  },
} as const;
