// 选项解析（ai resolveOptionByValue）：1-based 序号或 id/label 小写匹配。

export interface ResolvableOption {
  id: string;
  label: string;
}

export function resolveSelectionOption<T extends ResolvableOption>(
  options: ReadonlyArray<T>,
  value: string,
): T | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
    return options[Number.parseInt(trimmed, 10) - 1] ?? null;
  }
  const lowered = trimmed.toLowerCase();
  return (
    options.find(
      (option) => option.id.toLowerCase() === lowered || option.label.toLowerCase() === lowered,
    ) ?? null
  );
}
