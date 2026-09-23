import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { Model } from "@zcode/contracts";
import type { AgentRuntimeDeps } from "@zcode/core";
import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    // 修复(2026-09-23):reasoning-level-missing 不再直接拒绝。该形态来自内部辅助绑定——
    // 视觉模型 visionUnderstandModel 存裸 picker 串("providerId/modelId"),core runtime
    // 拿不到 provider registry 无法自行补全档位。此处按辅助模型语义补模型声明的首个
    // 可用档(与 auxiliaryModelOptions 同款 values[0]);模型无任何可用档位、档位不支持、
    // 供应商/模型不存在仍严格抛错。会话主选择路径的 selection 在执行入口已按
    // model-selection-config 规则补全,不经过此分支。
    if (!validation.ok && validation.code !== "reasoning-level-missing") {
      throw createRegistrySelectionProtocolError(validation);
    }
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    const fallbackReasoningLevel = validation.ok
      ? undefined
      : registryModel.config.optionSpecs.reasoningLevel.values[0];
    if (!validation.ok && !fallbackReasoningLevel) {
      throw createRegistrySelectionProtocolError(validation);
    }
    const resolvedTarget = fallbackReasoningLevel
      ? {
          ...target,
          selection: { ...target.selection, options: { reasoningLevel: fallbackReasoningLevel } },
        }
      : target;
    return this.#createRegistryModel(provider, registryModel, resolvedTarget);
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // Selection 已在上面的 Registry 边界完成校验，Factory 不再承担任何缺省修复。
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      modelConfig: config,
      // FreeCodeZ fork(P2 §4.2):off-peak requestDependencies 分支已删。

      options: {
        reasoningLevel: normalReasoningLevel,
      },
    });
  }
}
