// 模型列表发现的纯逻辑（spec: docs/spec/model-provider-intake-and-expansion.md §P2.7）。
// 候选 URL 链、双格式解码、非 chat 过滤集中在这里：探测（provider/probeAccess）与
// 发现（provider/listRemoteModels）共用同一套候选语义，避免两条链各自演化出不同探测面。
// 本模块不做 IO；HTTP 执行在 CLI agent 的 provider-access-probe handler（D-P1.3）。

export const PROVIDER_API_TYPES = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
] as const;

export type ProviderApiTypeValue = (typeof PROVIDER_API_TYPES)[number];

export interface ModelListCandidate {
  readonly url: string;
  /** ollama-tags = Ollama 原生 /api/tags；models-json = OpenAI 兼容 /models 形态。 */
  readonly kind: "models-json" | "ollama-tags";
}

/** 发现/探测过程中的错误分类（§P1.R2 四分类 + endpoint-miss 软失败）。 */
export type ProviderAccessErrorKind =
  | "invalid-key"
  | "rate-limited"
  | "network"
  | "endpoint-miss"
  | "unknown";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** loopback 判定单源（§P2.4-3）：发现链与探测链共用。 */
export function isLoopbackHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * 从 base 推导「根」：去掉尾部 /vN（chat 路径段）与 anthropic 兼容后缀。
 * anthropic 兼容网关（/anthropic、/apps/anthropic）的模型列表通常挂在
 * 同域 OpenAI 口径邻居端点上（§P2.7），所以根要剥到域级再拼 /v1/models。
 */
function resolveRootBase(baseUrl: string): string {
  let root = stripTrailingSlash(baseUrl);
  root = root.replace(/\/v\d+$/iu, "");
  root = root.replace(/\/apps\/anthropic$/iu, "");
  root = root.replace(/\/anthropic$/iu, "");
  return root;
}

/**
 * 候选 URL 链（§P2.7，顺序回退）：
 * 1. modelsUrl 显式指定 → 独占单候选（models_url 配置语义）；
 * 2. loopback 端点先试 Ollama 原生 GET /api/tags；
 * 3. openai-*：{base}/models → {去 /vN 的根}/v1/models；
 * 4. anthropic-messages：{去 anthropic 后缀的根}/v1/models → {base}/models。
 */
export function buildModelListCandidates(
  apiType: ProviderApiTypeValue,
  baseUrl: string,
  modelsUrl?: string,
): ModelListCandidate[] {
  const explicit = modelsUrl?.trim();
  if (explicit) {
    return [{ url: explicit, kind: "models-json" }];
  }
  const base = stripTrailingSlash(baseUrl);
  const candidates: ModelListCandidate[] = [];
  const push = (url: string, kind: ModelListCandidate["kind"]) => {
    if (candidates.some((candidate) => candidate.url === url)) return;
    candidates.push({ url, kind });
  };
  const parsed = tryParseUrl(base);
  if (parsed && isLoopbackHost(parsed)) {
    push(`${stripTrailingSlash(`${parsed.origin}${parsed.pathname}`.replace(/\/v\d+$/iu, ""))}/api/tags`, "ollama-tags");
    // 兜底：Ollama 兼容端点也提供 /v1/models；llama.cpp / LM Studio 只有该形态。
    push(`${base}/models`, "models-json");
  }
  const root = resolveRootBase(base);
  if (apiType === "anthropic-messages") {
    push(`${root}/v1/models`, "models-json");
    push(`${base}/models`, "models-json");
  } else {
    push(`${base}/models`, "models-json");
    push(`${root}/v1/models`, "models-json");
  }
  return candidates;
}

interface OpenAiModelsPayload {
  readonly data?: readonly { readonly id?: unknown }[];
  readonly models?: readonly { readonly name?: unknown; readonly model?: unknown }[];
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 双格式解码（§P2.7）：OpenAI `{"data":[{"id"}]}` 优先，Ollama
 * `{"models":[{"name"}]}` 兜底（/api tags 与 /v1/models 两种响应都认）。
 * 两种形态都解析不出 id 时返回 null（视为端点不可用，回退下一候选）。
 */
export function decodeModelList(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as OpenAiModelsPayload;
  const fromData = Array.isArray(body.data)
    ? body.data
        .map((item) => asNonEmptyString(item?.id))
        .filter((id): id is string => id !== null)
    : [];
  if (fromData.length > 0) return fromData;
  const fromModels = Array.isArray(body.models)
    ? body.models
        .map((item) => asNonEmptyString(item?.name) ?? asNonEmptyString(item?.model))
        .filter((id): id is string => id !== null)
    : [];
  if (fromModels.length > 0) return fromModels;
  // 结构合法但空目录也按有效响应处理：空 data/models 表示端点存在而无模型。
  return Array.isArray(body.data) || Array.isArray(body.models) ? [] : null;
}

// 非 chat 模型黑名单启发式（§P2.7，对标 IsLikelyChatModel 语义）。
const NON_CHAT_MODEL_PATTERN =
  /(?:embed|rerank|tts|stt|whisper|dall|imagine|video|moderation|classifier|guard|playground)/iu;

export function isLikelyChatModelId(modelId: string): boolean {
  return !NON_CHAT_MODEL_PATTERN.test(modelId);
}

export function filterChatModelIds(modelIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of modelIds) {
    if (seen.has(id) || !isLikelyChatModelId(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 赢家 URL → chat 应使用的 base_url（§P2.7-5 的回写判定输入）。
 * - anthropic-messages 不回写：适配器边界的 normalizeAnthropicBaseURL 已归一 /v1，
 *   按 OpenAI 邻居端点赢家回写反而会造出 /v1/v1 风险位。
 * - ollama-tags 赢家 ⇒ Ollama：chat 走 OpenAI 兼容 /v1，而 chat 客户端不自动补
 *   /v1（§P2.7-5 同坑的 loopback 形态）；用户 base 已带 /vN 时保持不变。
 * - models-json 赢家：剥掉 /models 尾段（多出的 /v1 即回写修正）。
 */
export function resolveWinnerBaseUrl(
  winner: ModelListCandidate,
  userBase: string,
  apiType: ProviderApiTypeValue,
): string {
  if (apiType === "anthropic-messages") {
    return stripTrailingSlash(userBase);
  }
  if (winner.kind === "ollama-tags") {
    const base = stripTrailingSlash(userBase);
    return /\/v\d+$/iu.test(base) ? base : `${resolveRootBase(base)}/v1`;
  }
  return stripTrailingSlash(winner.url.replace(/\/models$/iu, ""));
}

/** 候选失败是否允许回退下一候选：仅「端点不存在」（404/405）继续。 */
export function isModelEndpointMissStatus(status: number): boolean {
  return status === 404 || status === 405;
}
