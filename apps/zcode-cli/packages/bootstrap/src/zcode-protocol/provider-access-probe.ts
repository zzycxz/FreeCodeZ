// provider 接入探测 / 模型发现的 HTTP 执行（spec: docs/spec/model-provider-intake-and-expansion.md §P1.5/§P2.7）。
// 发生在 provider 落盘之前（首启向导 Step2/3），是纯端点探测：不建 ZCodeApp、不碰 Registry、
// 不写任何配置。候选 URL 链/解码/过滤的纯逻辑在 @zcode/shared 的 provider-model-discovery
// （探测与发现共用同一候选语义）；本文件只负责按候选链发 HTTP 并把状态翻译成业务结果。
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import {
  buildModelListCandidates,
  decodeModelList,
  filterChatModelIds,
  isLoopbackHost,
  isModelEndpointMissStatus,
  resolveWinnerBaseUrl,
  type ModelListCandidate,
  type ProviderAccessErrorKind,
  type ProviderApiTypeValue,
} from "@zcode/shared";
import {
  zcodeProviderListRemoteModelsParamsSchema,
  zcodeProviderProbeAccessParamsSchema,
  type ZCodeProviderListRemoteModelsResult,
  type ZCodeProviderProbeAccessResult,
} from "@zcode/shared";
import { parseParams } from "./server-types.js";

/** 单候选探测硬上限（§P2.7-6）；总时限由 services 层 request timeout 兜底。 */
const CANDIDATE_TIMEOUT_MS = 10_000;

/**
 * 探测/发现的网络出口（D-P1.3：代理语义与会话请求一致）。由协议服务器 entrypoint
 * 从 config store 的 network.{httpProxy,noProxy,caCertFile} + 运行时 env 注入；
 * 缺省时直连（兼容无上下文的旧测试调用）。
 */
export interface ProviderAccessNetworkOptions {
  env?: Record<string, string | undefined>;
  httpProxy?: string;
  noProxy?: string;
  caCertFile?: string;
}

type AccessResult = ZCodeProviderProbeAccessResult | ZCodeProviderListRemoteModelsResult;

function failure(
  errorKind: ProviderAccessErrorKind,
  message: string,
): Extract<AccessResult, { ok: false }> {
  return { ok: false, errorKind, message };
}

function buildAuthHeaders(apiType: ProviderApiTypeValue, apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  if (!key) return {};
  // anthropic 兼容网关同时接受 x-api-key 与 Bearer；显式双发对两类端点都成立（对齐
  // model-execution 的 withAnthropicAuthorizationHeader 语义）。
  return apiType === "anthropic-messages"
    ? { "x-api-key": key, authorization: `Bearer ${key}` }
    : { authorization: `Bearer ${key}` };
}

interface CandidateFetch {
  status?: number;
  json?: unknown;
  errorKind?: ProviderAccessErrorKind;
  message?: string;
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(rawUrl));
  } catch {
    return false;
  }
}

async function fetchCandidate(
  candidate: ModelListCandidate,
  headers: Record<string, string>,
  network: ProviderAccessNetworkOptions | undefined,
  abortSignal?: AbortSignal,
): Promise<CandidateFetch> {
  // loopback 直连不经代理（§P2.4-3，本地 Ollama 等经代理会被劫持/拒绝）；
  // 与用户 noProxy 配置无关，本地地址永远不该走代理。
  const adapter = createNodeHttpClientAdapter({
    timeoutMs: CANDIDATE_TIMEOUT_MS,
    env: network?.env,
    proxyUrl: network?.httpProxy,
    noProxy: isLoopbackUrl(candidate.url) ? "*" : network?.noProxy,
    caCertFile: network?.caCertFile,
  });
  try {
    const response = await adapter.request(
      {
        url: candidate.url,
        method: "GET",
        headers: { accept: "application/json", ...headers },
        timeoutMs: CANDIDATE_TIMEOUT_MS,
      },
      abortSignal ? { signal: abortSignal } : {},
    );
    let json: unknown;
    const text = new TextDecoder().decode(response.body);
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  } catch (error) {
    // 网络层失败（DNS/拒绝连接/超时/取消）：立即失败不换候选（§P2.7-2）。
    return {
      errorKind: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function statusToErrorKind(status: number): ProviderAccessErrorKind {
  if (status === 401 || status === 403) return "invalid-key";
  if (status === 429) return "rate-limited";
  return "unknown";
}

/**
 * 按候选链探测：200 即有效；401/403/429 等明确结论立即失败；仅 404/405 换下一候选。
 * 全部候选 404/405（网络可达但无模型列表端点）→ ok + unverified 温和放行（§P1.R2）。
 */
export async function probeProviderAccess(
  rawParams: unknown,
  abortSignal?: AbortSignal,
  network?: ProviderAccessNetworkOptions,
): Promise<ZCodeProviderProbeAccessResult> {
  const params = parseParams(zcodeProviderProbeAccessParamsSchema, rawParams);
  const headers = buildAuthHeaders(params.apiType, params.apiKey);
  const candidates = buildModelListCandidates(params.apiType, params.baseUrl, params.modelsUrl);
  let sawEndpointMiss = false;
  for (const candidate of candidates) {
    const result = await fetchCandidate(candidate, headers, network, abortSignal);
    if (result.errorKind) return failure(result.errorKind, result.message ?? "request failed");
    const status = result.status ?? 0;
    if (status >= 200 && status < 300) return { ok: true };
    if (isModelEndpointMissStatus(status)) {
      sawEndpointMiss = true;
      continue;
    }
    return failure(statusToErrorKind(status), `unexpected status ${status}`);
  }
  return sawEndpointMiss ? { ok: true, unverified: true } : failure("unknown", "no probe candidates");
}

/**
 * 模型目录发现（§P2.7）：候选链顺序回退、双格式解码、非 chat 过滤。
 * endpoint-miss/解不出模型视为软失败换候选；其余结论性失败立即返回。
 */
export async function listProviderRemoteModels(
  rawParams: unknown,
  abortSignal?: AbortSignal,
  network?: ProviderAccessNetworkOptions,
): Promise<ZCodeProviderListRemoteModelsResult> {
  const params = parseParams(zcodeProviderListRemoteModelsParamsSchema, rawParams);
  const headers = buildAuthHeaders(params.apiType, params.apiKey);
  const candidates = buildModelListCandidates(params.apiType, params.baseUrl, params.modelsUrl);
  let sawEndpointMiss = false;
  for (const candidate of candidates) {
    const result = await fetchCandidate(candidate, headers, network, abortSignal);
    if (result.errorKind) return failure(result.errorKind, result.message ?? "request failed");
    const status = result.status ?? 0;
    if (isModelEndpointMissStatus(status)) {
      sawEndpointMiss = true;
      continue;
    }
    if (status < 200 || status >= 300) {
      return failure(statusToErrorKind(status), `unexpected status ${status}`);
    }
    const decoded = decodeModelList(result.json);
    if (decoded === null) {
      // 200 但两种形态都解析不出目录：端点不可用语义，继续回退。
      sawEndpointMiss = true;
      continue;
    }
    const models = filterChatModelIds(decoded);
    return {
      ok: true,
      models,
      resolvedBaseUrl: resolveWinnerBaseUrl(candidate, params.baseUrl, params.apiType),
    };
  }
  return sawEndpointMiss
    ? failure("endpoint-miss", "no model list endpoint reachable")
    : failure("unknown", "no discovery candidates");
}
