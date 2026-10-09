import type { PermissionUpdate } from "@zcode/contracts";

const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

export function buildDefaultPermissionUpdates(
  toolName: string,
  input: unknown,
): PermissionUpdate[] {
  const ruleContent = ruleContentFromInput(input);
  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

function ruleContentFromInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) return input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}
