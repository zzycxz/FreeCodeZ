const GH_RATE_LIMIT_HINT_COOLDOWN_MS = 60_000;
const GH_COMMAND_RE =
  /(?:^|[;&|]|\b(?:then|do)\b)\s*gh\s+(?!auth\b|help\b|version\b|alias\b|completion\b|config\b)/;
const GH_RATE_LIMIT_RE =
  /API rate limit (?:already )?exceeded|exceeded a secondary rate limit|\bRATE_LIMITED\b/i;
// A4 修正：旧文案指引模型"use ScheduleWakeup"，但该工具在本仓只有排序白名单占位名、
// 无任何 handler/contract——模型收到无法执行的指令。改为指引真实存在的手段：
// 后台 sleep + TaskOutput 阻塞等待（Bash run_in_background 生命周期），或直接改用非 gh 途径。
const GH_RATE_LIMIT_HINT =
  "<system-reminder>GitHub API rate limit exceeded (5,000/hr shared across all tools and agents). Run `gh api rate_limit --jq .resources` to check the reset time. To wait for reset, run `sleep <seconds-until-reset>` with run_in_background and poll it with TaskOutput instead of retrying in a loop, or switch to a non-gh approach.</system-reminder>";
let nextGhRateLimitHintAt = 0;

export function getGhRateLimitHint(command: string, output: string): string | undefined {
  if (!GH_COMMAND_RE.test(command) || !GH_RATE_LIMIT_RE.test(output)) return undefined;
  const now = Date.now();
  if (now < nextGhRateLimitHintAt) return undefined;
  nextGhRateLimitHintAt = now + GH_RATE_LIMIT_HINT_COOLDOWN_MS;
  return GH_RATE_LIMIT_HINT;
}
