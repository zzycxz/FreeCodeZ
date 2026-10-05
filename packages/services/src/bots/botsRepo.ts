// Bot 持久化仓库（附录B §5.4/§5.5）：bot-config.v3.json / bot-state.v3.json。
// 写文件统一 JSON.stringify(x,null,2)+"\n" + 原子写（atomicWriteText 内含跨进程文件锁）；
// 读-改-写链路加进程内跨操作锁（R14，官方 last-writer-wins 的改良）；
// v1/v2 → v3 迁移链：migrateSelection + importLegacyBotConfig / importLegacyBotState。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  botsConfigV3Schema,
  botsStateV3Schema,
  modelSelectionSchema,
  normalizeBotConfig,
  type BotConfig,
  type BotContext,
  type BotsConfigV3,
  type BotsStateV3,
  type ModelSelection,
} from "@zcode/shared/bots";
import { atomicWriteText } from "../fs/atomicFileUtils.js";

export const BOT_CONFIG_FILE = "bot-config.v3.json";
export const BOT_STATE_FILE = "bot-state.v3.json";
const LEGACY_CONFIG_FILE = "bot-config.json";
const LEGACY_STATE_V2_FILE = "bot-state.v2.json";
const LEGACY_STATE_V1_FILE = "bot-state.json";

interface LegacyDraftLike {
  provider?: unknown;
  model?: unknown;
  thoughtLevel?: unknown;
  mode?: unknown;
  modelSelection?: unknown;
}

/** 旧 `builtin:*` providerId → 现 providerId 映射；未知 → undefined（选择被丢弃）。 */
const BUILTIN_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "builtin:glm": "glm",
  "builtin:zcode": "glm",
  "builtin:openai": "openai",
  "builtin:anthropic": "anthropic",
  "builtin:claude": "anthropic",
  "builtin:google": "google",
  "builtin:gemini": "google",
  "builtin:deepseek": "deepseek",
  "builtin:qwen": "qwen",
  "builtin:moonshot": "moonshot",
};

/** 旧模型串的已知特例（provider/name 解析前先查表）。 */
const LEGACY_MODEL_OVERRIDES: Readonly<Record<string, { providerId: string; modelName: string }>> =
  {};

const LEGACY_PROVIDER_WHITELIST: ReadonlySet<string> = new Set([
  "glm",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "qwen",
  "moonshot",
  "mistral",
  "groq",
  "azure",
  "ollama",
  "openrouter",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLegacyProviderId(providerId: string): string | undefined {
  if (providerId.startsWith("builtin:")) {
    return BUILTIN_PROVIDER_ALIASES[providerId];
  }
  return LEGACY_PROVIDER_WHITELIST.has(providerId) ? providerId : undefined;
}

function resolveLegacyModelName(providerId: string, modelName: string): string {
  // 历史 `provider:model` 前缀剥离：providerId 已在外部解析时，modelId 只保留纯模型名。
  const prefix = `${providerId}:`;
  return modelName.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
}

/**
 * migrateSelection（附录B §5.5 @626023）：
 * 有 modelSelection → zod 校验；`builtin:*` 走映射表；非 builtin 原样保留。
 * 旧 `{model:"provider/name", thoughtLevel}` → 特例表或首个 `/` 切分，providerId 经白名单校验。
 */
export function migrateSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, "modelSelection")) {
    const parsed = modelSelectionSchema.safeParse(value.modelSelection);
    if (!parsed.success) return undefined;
    const selection = parsed.data;
    if (!selection.providerId.startsWith("builtin:")) return selection;
    const mapped = resolveLegacyProviderId(selection.providerId);
    if (!mapped) return undefined;
    return {
      ...selection,
      providerId: mapped,
      modelId: resolveLegacyModelName(selection.providerId, selection.modelId),
    };
  }
  const legacy: LegacyDraftLike = value;
  const model = typeof legacy.model === "string" ? legacy.model.trim() : "";
  const override = LEGACY_MODEL_OVERRIDES[model];
  const slashIndex = model.indexOf("/");
  const providerId = override?.providerId ?? (slashIndex > 0 ? model.slice(0, slashIndex) : undefined);
  const modelName = override?.modelName ?? (slashIndex > 0 ? model.slice(slashIndex + 1) : undefined);
  if (!providerId || !modelName) return undefined;
  const resolvedProviderId = resolveLegacyProviderId(providerId);
  if (!resolvedProviderId) return undefined;
  const thoughtLevel = typeof legacy.thoughtLevel === "string" ? legacy.thoughtLevel.trim() : "";
  return {
    providerId: resolvedProviderId,
    modelId: resolveLegacyModelName(providerId, modelName),
    ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}),
  };
}

function normalizeBotCurrentOptions(input: unknown): BotConfig["currentOptions"] {
  const source = isRecord(input) ? input : {};
  const modelSelection = migrateSelection(source);
  const draft: BotConfig["currentOptions"] = {};
  if (modelSelection) draft.modelSelection = modelSelection;
  if (typeof source.mode === "string") draft.mode = source.mode;
  // sandboxMode 是历史遗留的惰性透传：schema 接受（存量持久化数据兼容，两侧 strict 不能删）
  // 但无任何消费方。bots 任务的沙箱由 taskBridge 建/续边界强制注入（0-4），不走该字段。
  if (typeof source.sandboxMode === "string") draft.sandboxMode = source.sandboxMode;
  if (typeof source.approvalPolicy === "string") draft.approvalPolicy = source.approvalPolicy;
  const cli = source.cli;
  if (
    cli === "codex" ||
    cli === "claude" ||
    cli === "opencode" ||
    cli === "gemini" ||
    cli === "glm"
  ) {
    draft.cli = cli;
  }
  return draft;
}

function normalizeBotDraftOptions(input: unknown): NonNullable<BotContext["draftOptions"]> {
  const source = isRecord(input) ? input : {};
  const draft: NonNullable<BotContext["draftOptions"]> = { provider: "glm" };
  const modelSelection = migrateSelection(source);
  if (modelSelection) draft.modelSelection = modelSelection;
  if (typeof source.mode === "string") draft.mode = source.mode;
  return draft;
}

/** importLegacyBotConfig（@626267）：currentOptions = normalize({...n, modelSelection: migrateSelection(n)})；
 *  其余字段按 §5.2 归一（legacy 允许部分 allowedCommands，strict schema 需补齐）。 */
export function importLegacyBotConfig(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.bots)) return value;
  return {
    ...value,
    version: 3,
    bots: value.bots.map((bot) => {
      if (!isRecord(bot)) return bot;
      const currentOptions = isRecord(bot.currentOptions) ? bot.currentOptions : {};
      const legacyLike = {
        ...bot,
        id: typeof bot.id === "string" ? bot.id : "",
        name: typeof bot.name === "string" ? bot.name : "",
        provider: bot.provider,
        enabled: bot.enabled !== false,
        allowedWorkspaces: Array.isArray(bot.allowedWorkspaces) ? bot.allowedWorkspaces : [],
        allowedCommands: isRecord(bot.allowedCommands) ? bot.allowedCommands : {},
        replyMode: bot.replyMode,
        currentOptions: normalizeBotCurrentOptions({
          ...currentOptions,
          modelSelection: migrateSelection(currentOptions),
        }),
      } as Parameters<typeof normalizeBotConfig>[0];
      return normalizeBotConfig(legacyLike);
    }),
  };
}

/** importLegacyBotState（@626619）：draftOptions = normalize({provider:'glm', modelSelection: migrateSelection(o), mode: o.mode})。 */
export function importLegacyBotState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.bots)) return value;
  const bots = Object.entries(value.bots).map(([botId, context]) => {
    if (!isRecord(context) || !isRecord(context.draftOptions)) return [botId, context] as const;
    const draftOptions = context.draftOptions;
    return [
      botId,
      {
        ...context,
        draftOptions: normalizeBotDraftOptions({
          provider: "glm",
          modelSelection: migrateSelection(draftOptions),
          ...(typeof draftOptions.mode === "string" ? { mode: draftOptions.mode } : {}),
        }),
      },
    ] as const;
  });
  return {
    ...value,
    version: 3,
    bots: Object.fromEntries(bots),
  };
}

async function readOptionalJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeJson(filePath: string, value: unknown): Promise<void> {
  return atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export interface BotsRepoOptions {
  configDir: string;
}

/**
 * BotsRepo：v3 文件优先；缺失时走 legacy 迁移链并回写 v3。
 * read-modify-write 统一经 updateConfig/updateState 的进程内链锁（R14）。
 */
export class BotsRepo {
  private readonly configDir: string;
  private configLockChain: Promise<unknown> = Promise.resolve();
  private stateLockChain: Promise<unknown> = Promise.resolve();

  constructor(options: BotsRepoOptions) {
    this.configDir = options.configDir;
  }

  private path(fileName: string): string {
    return join(this.configDir, fileName);
  }

  private withLock<T>(chainRef: "configLockChain" | "stateLockChain", run: () => Promise<T>): Promise<T> {
    const previous = this[chainRef];
    // 失败的任务不阻断后续 RMW；串行语义靠链本身保持
    const next = previous.then(run, run);
    this[chainRef] = next.catch(() => undefined);
    return next;
  }

  readConfig(): Promise<BotsConfigV3> {
    return this.withLock("configLockChain", () => this.readConfigUnlocked());
  }

  writeConfig(config: BotsConfigV3): Promise<BotsConfigV3> {
    return this.withLock("configLockChain", async () => {
      const parsed = botsConfigV3Schema.parse(config);
      await writeJson(this.path(BOT_CONFIG_FILE), parsed);
      return parsed;
    });
  }

  /** R14：跨操作 RMW——读-改-写全程持链锁，避免 last-writer-wins 丢更新。 */
  updateConfig(
    mutate: (config: BotsConfigV3) => BotsConfigV3 | Promise<BotsConfigV3>,
  ): Promise<BotsConfigV3> {
    return this.withLock("configLockChain", async () => {
      const current = await this.readConfigUnlocked();
      const next = await mutate(current);
      const parsed = botsConfigV3Schema.parse(next);
      await writeJson(this.path(BOT_CONFIG_FILE), parsed);
      return parsed;
    });
  }

  readState(): Promise<BotsStateV3> {
    return this.withLock("stateLockChain", () => this.readStateUnlocked());
  }
  writeState(state: BotsStateV3): Promise<BotsStateV3> {
    return this.withLock("stateLockChain", async () => {
      const parsed = botsStateV3Schema.parse(state);
      await writeJson(this.path(BOT_STATE_FILE), parsed);
      return parsed;
    });
  }

  updateState(
    mutate: (state: BotsStateV3) => BotsStateV3 | Promise<BotsStateV3>,
  ): Promise<BotsStateV3> {
    return this.withLock("stateLockChain", async () => {
      const current = await this.readStateUnlocked();
      const next = await mutate(current);
      const parsed = botsStateV3Schema.parse(next);
      await writeJson(this.path(BOT_STATE_FILE), parsed);
      return parsed;
    });
  }

  private async readConfigUnlocked(): Promise<BotsConfigV3> {
    const raw = await readOptionalJson(this.path(BOT_CONFIG_FILE));
    if (raw !== undefined) return botsConfigV3Schema.parse(raw);
    const legacyRaw = await readOptionalJson(this.path(LEGACY_CONFIG_FILE));
    const migrated = importLegacyBotConfig(
      legacyRaw === undefined ? { version: 3, bots: [] } : legacyRaw,
    );
    const parsed = botsConfigV3Schema.parse(migrated);
    await writeJson(this.path(BOT_CONFIG_FILE), parsed);
    return parsed;
  }

  private async readStateUnlocked(): Promise<BotsStateV3> {
    const raw = await readOptionalJson(this.path(BOT_STATE_FILE));
    if (raw !== undefined) return botsStateV3Schema.parse(raw);
    // 迁移链：优先 v2 否则 v1（附录B §5.5）
    const v2Raw = await readOptionalJson(this.path(LEGACY_STATE_V2_FILE));
    const legacyRaw = v2Raw === undefined ? await readOptionalJson(this.path(LEGACY_STATE_V1_FILE)) : v2Raw;
    const migrated = importLegacyBotState(
      legacyRaw === undefined ? { version: 3, bots: {} } : legacyRaw,
    );
    const parsed = botsStateV3Schema.parse(migrated);
    await writeJson(this.path(BOT_STATE_FILE), parsed);
    return parsed;
  }
}
