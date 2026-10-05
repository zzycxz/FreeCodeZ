import { structuredPatch } from "diff";

export function structuredPatchOf(): string {
  const lines = Array.from({ length: 60 }, (_, index) => `line-${index}`);
  const modified = lines.map((line, index) => (index % 6 === 0 ? `${line}-MOD` : line));
  const patch = structuredPatch("f.txt", "f.txt", lines.join("\n"), modified.join("\n"), "", "", { context: 1 });
  return [
    `--- ${patch.oldFileName}`,
    `+++ ${patch.newFileName}`,
    ...patch.hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`),
  ].join("\n");
}
