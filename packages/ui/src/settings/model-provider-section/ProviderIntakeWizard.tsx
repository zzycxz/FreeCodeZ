/* oxlint-disable eslint(max-lines) -- 三步向导共享同一草稿状态机（§P1.4 单一 owner），
 * 拆成 KeyStep/ModelStep 子组件需要 15+ prop 钻取或引入新 context；待向导稳定后按步拆文件。 */
/**
 * ProviderIntakeWizard —— 三步接入向导（spec: docs/spec/model-provider-intake-and-expansion.md §P1）。
 *
 * ①选厂商（模板墙/自定义）→ ②填 key 并验证（provider/probeAccess 只读探测，不落盘）
 * → ③选模型（provider/listRemoteModels 自动发现 + 预设回退）→ 完成即 setupPersonalProvider
 * 原子落盘（创建 + key + 模型 + 默认模型单次写入，§P1.R3）。
 *
 * Step1 复用 ProviderTemplatePicker（onCreateFromTemplate/onCreateCustom 语义改为「选中并前进」，
 * 不创建空壳）；KeyStep/ModelStep 为本向导新建。验证错误四分类本地化（§P1.R2），
 * 禁止硬编码英文错误。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { logger } from "@/logger.js";
import { ApiKeyInput } from "./ApiKeyInput.js";
import { ProviderTemplatePicker } from "./ProviderTemplatePicker.js";

type WizardStep = "vendor" | "key" | "models";

type VendorSelection =
  | {
      kind: "template";
      templateId: string;
      displayName: string;
      apiType: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
      baseUrl: string;
      presetModelIds: readonly string[];
      /** access.type==="none"（本地免密，D-P2.1）：跳过 key 步（§P1.R1）。 */
      keyless: boolean;
      /** api.baseUrlEditable（MoMA 内网地址，§P2.5）：key 步显示平台地址输入行。 */
      baseUrlEditable: boolean;
      /** 模板控制台地址：key 步显示「获取 API Key」外链（fairpeer docUrl 对标）。 */
      apiKeyManagementUrl?: string;
    }
  | { kind: "custom"; providerName: string };

type ProbeOutcome = { ok: true; unverified?: boolean } | { ok: false };

interface ProviderIntakeWizardProps {
  /** `done` 携带新供应商 providerId（设置页用于落点选中）；`skip` 仅首页场景。 */
  onComplete: (reason: "done" | "skip", providerId?: string) => void | Promise<void>;
  /** 设置页传入时 Step1 显示返回按钮（回列表）；首页不传。 */
  onCancel?: () => void;
}

const MOBILE_SAFE_INPUT_CLASS = "text-mobile-input-safe md:text-ui-base";

export function ProviderIntakeWizard({ onComplete, onCancel }: ProviderIntakeWizardProps) {
  const { intl, locale } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const platform = usePlatform();
  const providerSettingsRead = useProviderSettingsView();
  const templates =
    providerSettingsRead.state.status === "ready"
      ? providerSettingsRead.state.view.providerTemplates
      : [];

  const [step, setStep] = useState<WizardStep>("vendor");
  const [selection, setSelection] = useState<VendorSelection | null>(null);

  // ---- Step2：key 验证草稿（完成前不落盘） ----
  const [apiKey, setApiKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiType, setCustomApiType] = useState<
    "anthropic-messages" | "openai-chat-completions" | "openai-responses"
  >("openai-chat-completions");
  const [probeState, setProbeState] = useState<
    { kind: "idle" } | { kind: "probing" } | { kind: "done"; outcome: ProbeOutcome; warning?: boolean }
  >({ kind: "idle" });

  // ---- Step3：模型草稿 ----
  const [models, setModels] = useState<string[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [defaultModelId, setDefaultModelId] = useState("");
  const [modelFetchState, setModelFetchState] = useState<
    { kind: "loading" } | { kind: "ready"; fallback: boolean } | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [manualModelId, setManualModelId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 发现赢家 base（§P2.7-5 /v1 修正）：openai 系发现端点比当前 base 多 /v1 时回写。
  const [discoveredBaseUrl, setDiscoveredBaseUrl] = useState<string | null>(null);

  const effectiveBaseUrl =
    discoveredBaseUrl ??
    (selection?.kind === "template"
      ? selection.baseUrlEditable
        ? customBaseUrl.trim() || selection.baseUrl
        : selection.baseUrl
      : customBaseUrl.trim() || undefined);
  const effectiveApiType =
    selection?.kind === "template" ? selection.apiType : customApiType;
  const displayName =
    selection?.kind === "template"
      ? selection.displayName
      : customName.trim() ||
        intl.formatMessage({ id: "settings.modelProvider.newProviderName" });
  const apiKeyManagementUrl =
    selection?.kind === "template" ? selection.apiKeyManagementUrl : undefined;

  const resetProbe = useCallback(() => {
    setProbeState({ kind: "idle" });
  }, []);

  // ---- Step2 验证（provider/probeAccess：只读探测，不落盘，§P1.R2） ----
  const runProbe = useCallback(async () => {
    const baseUrl = effectiveBaseUrl;
    if (!baseUrl || !apiKey.trim()) return;
    setProbeState({ kind: "probing" });
    try {
      const result = await providerSettingsService.probeProviderAccess({
        apiType: effectiveApiType,
        baseUrl,
        apiKey: apiKey.trim(),
      });
      if (result.ok) {
        setProbeState({ kind: "done", outcome: { ok: true, unverified: result.unverified }, warning: result.unverified });
        // 验证通过（含 unverified 温和放行）后进入模型步。
        setStep("models");
      } else {
        setProbeState({
          kind: "done",
          outcome: { ok: false },
        });
        setSaveError(describeAccessError(intl, result.errorKind, result.message));
      }
    } catch (error) {
      logger.error("[ProviderIntakeWizard] 接入探测失败", error);
      setProbeState({ kind: "done", outcome: { ok: false } });
      setSaveError(
        intl.formatMessage({ id: "providerIntake.errNetwork" }),
      );
    }
  }, [apiKey, effectiveApiType, effectiveBaseUrl, intl, providerSettingsService]);

  // ---- Step3 模型发现（provider/listRemoteModels，§P2.7；失败回退预设，§P1.R5） ----
  useEffect(() => {
    if (step !== "models" || !selection) return;
    let cancelled = false;
    setModelFetchState({ kind: "loading" });
    (async () => {
      const baseUrl = effectiveBaseUrl;
      const presetModelIds = selection.kind === "template" ? selection.presetModelIds : [];
      try {
        const result = baseUrl
          ? await providerSettingsService.listRemoteModels({
              apiType: effectiveApiType,
              baseUrl,
              apiKey: apiKey.trim(),
            })
          : null;
        if (cancelled) return;
        if (result?.ok && result.models.length > 0) {
          applyModelCandidates(result.models);
          // §P2.7-5 回写：openai 系发现端点比当前 base 多 /v1 时以赢家 base 修正提交值；
          // anthropic-messages 不回写（适配器边界已归一，回写反造 /v1/v1 风险位）。
          if (
            effectiveApiType !== "anthropic-messages" &&
            result.resolvedBaseUrl &&
            result.resolvedBaseUrl !== effectiveBaseUrl
          ) {
            setDiscoveredBaseUrl(result.resolvedBaseUrl);
          }
          setModelFetchState({ kind: "ready", fallback: false });
          return;
        }
        // 发现失败 / 空目录 / 无 baseUrl：回退模板预设（§P1.R5）。
        if (result && !result.ok && result.errorKind !== "endpoint-miss") {
          setSaveError(describeAccessError(intl, result.errorKind, result.message));
        }
        if (presetModelIds.length > 0) {
          applyModelCandidates(presetModelIds);
          setModelFetchState({ kind: "ready", fallback: true });
        } else {
          setModels([]);
          setSelectedModelIds(new Set());
          setDefaultModelId("");
          setModelFetchState({ kind: "ready", fallback: true });
        }
      } catch (error) {
        if (cancelled) return;
        logger.error("[ProviderIntakeWizard] 模型发现失败", error);
        if (presetModelIds.length > 0) {
          applyModelCandidates(presetModelIds);
          setModelFetchState({ kind: "ready", fallback: true });
        } else {
          setModelFetchState({
            kind: "error",
            message: intl.formatMessage({ id: "providerIntake.errNetwork" }),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随 step/selection 变化重拉；key/base 由向导草稿持有
  }, [step, selection]);

  const applyModelCandidates = useCallback((candidates: readonly string[]) => {
    setModels([...candidates]);
    setSelectedModelIds(new Set(candidates));
    setDefaultModelId(candidates[0] ?? "");
  }, []);

  const toggleModel = useCallback((modelId: string) => {
    setSelectedModelIds((previous) => {
      const next = new Set(previous);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
    setDefaultModelId((previous) => {
      // 默认模型必须始终落在已选集合内。
      if (previous === modelId) return previous;
      return previous;
    });
  }, []);

  const checkedModelIds = useMemo(
    () => models.filter((modelId) => selectedModelIds.has(modelId)),
    [models, selectedModelIds],
  );

  useEffect(() => {
    // 取消勾选默认模型后自动改选第一个已选模型（默认模型必选，§P1.R1）。
    if (checkedModelIds.length > 0 && !checkedModelIds.includes(defaultModelId)) {
      setDefaultModelId(checkedModelIds[0] ?? "");
    }
    if (checkedModelIds.length === 0) setDefaultModelId("");
  }, [checkedModelIds, defaultModelId]);

  const addManualModel = useCallback(() => {
    const modelId = manualModelId.trim();
    if (!modelId || models.includes(modelId)) return;
    setModels((previous) => [...previous, modelId]);
    setSelectedModelIds((previous) => new Set(previous).add(modelId));
    setManualModelId("");
  }, [manualModelId, models]);

  // ---- 原子提交（setupPersonalProvider：单次写入，§P1.R3） ----
  const finish = useCallback(async () => {
    if (!selection || checkedModelIds.length === 0 || !defaultModelId || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await providerSettingsService.setupPersonalProvider({
        ...(selection.kind === "template"
          ? { templateId: selection.templateId }
          : { providerName: displayName }),
        apiKey: apiKey.trim(),
        apiType: effectiveApiType,
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        modelIds: checkedModelIds,
        defaultModelId,
        locale,
      });
      await onComplete("done", created.providerId);
    } catch (error) {
      logger.error("[ProviderIntakeWizard] 供应商提交失败", error);
      setSaveError(intl.formatMessage({ id: "providerIntake.finishError" }));
    } finally {
      setSaving(false);
    }
  }, [
    apiKey,
    checkedModelIds,
    defaultModelId,
    displayName,
    effectiveApiType,
    effectiveBaseUrl,
    intl,
    locale,
    onComplete,
    providerSettingsService,
    saving,
    selection,
  ]);

  // ---- Step1：模板墙（复用 ProviderTemplatePicker，点击=选中并前进） ----
  if (step === "vendor") {
    return (
      <div className="flex flex-col gap-4">
        {providerSettingsRead.state.status === "error" && (
          // P1.R6：模板快照加载失败必须显式可见（含重试），不得静默降级为空列表。
          <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-surface p-3">
            <span className="min-w-0 flex-1 text-ui-caption text-destructive">
              {intl.formatMessage({ id: "providerIntake.templatesError" })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void providerSettingsRead.reload()}
            >
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          </div>
        )}
        <ProviderTemplatePicker
          templates={templates}
          creating={false}
          onBack={onCancel}
          onCreateFromTemplate={async (templateId) => {
            const template = templates.find((item) => item.templateId === templateId);
            if (!template) return;
            const keyless = template.config.access?.type === "none";
            const baseUrlEditable = template.config.api?.baseUrlEditable === true;
            setSelection({
              kind: "template",
              templateId,
              displayName: resolveTemplateName(template, locale),
              apiType: template.config.api?.type ?? "openai-chat-completions",
              baseUrl: template.config.api?.baseUrl ?? "",
              presetModelIds: template.config.builtinModelIds ?? [],
              keyless,
              baseUrlEditable,
              apiKeyManagementUrl:
                template.config.access?.type === "api-key"
                  ? (template.config.access.apiKeyManagementUrl ?? undefined)
                  : undefined,
            });
            if (baseUrlEditable) {
              // 平台地址草稿预填模板默认值；提交时以用户输入为准（§P2.5）。
              setCustomBaseUrl(template.config.api?.baseUrl ?? "");
            }
            setApiKey("");
            setSaveError(null);
            setDiscoveredBaseUrl(null);
            resetProbe();
            // 免密厂商跳过 key 步（§P1.R1）；keyless 无需探测，直接进模型步。
            setStep(keyless ? "models" : "key");
          }}
          onCreateCustom={async (label) => {
            setSelection({
              kind: "custom",
              providerName: label.trim() || intl.formatMessage({ id: "settings.modelProvider.newProviderName" }),
            });
            setSaveError(null);
            setDiscoveredBaseUrl(null);
            resetProbe();
            setStep("key");
          }}
        />
      </div>
    );
  }

  const stepLabel = intl.formatMessage({
    id: step === "key" ? "providerIntake.stepKey" : "providerIntake.stepModel",
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-ui-lg font-semibold">{displayName}</h2>
        <p className="text-ui-caption text-foreground-subtle">{stepLabel}</p>
      </div>

      {step === "key" ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void runProbe();
          }}
        >
          {selection?.kind === "custom" && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-ui-caption font-medium">
                  {intl.formatMessage({ id: "providerIntake.customNameLabel" })}
                </span>
                <Input
                  className={MOBILE_SAFE_INPUT_CLASS}
                  value={customName}
                  placeholder={intl.formatMessage({
                    id: "settings.modelProvider.newProviderName",
                  })}
                  onChange={(event) => setCustomName(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-ui-caption font-medium">
                  {intl.formatMessage({ id: "providerIntake.baseUrlLabel" })}
                </span>
                <Input
                  className={MOBILE_SAFE_INPUT_CLASS}
                  value={customBaseUrl}
                  placeholder={intl.formatMessage({ id: "providerIntake.baseUrlPlaceholder" })}
                  onChange={(event) => {
                    setCustomBaseUrl(event.target.value);
                    resetProbe();
                  }}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-ui-caption font-medium">
                  {intl.formatMessage({ id: "providerIntake.apiTypeLabel" })}
                </span>
                <select
                  className="h-8 rounded-lg border border-input-border bg-input px-3 text-ui-base outline-none hover:border-input-border-hover focus-visible:border-input-border-focused"
                  value={customApiType}
                  onChange={(event) => {
                    setCustomApiType(event.target.value as typeof customApiType);
                    resetProbe();
                  }}
                >
                  <option value="openai-chat-completions">OpenAI Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                  <option value="openai-responses">OpenAI Responses</option>
                </select>
              </label>
            </>
          )}
          {selection?.kind === "template" && selection.baseUrlEditable && (
            // MoMA 类内网地址因部署而异（§P2.5）：显示可编辑「平台地址」行，预填模板默认值。
            <label className="flex flex-col gap-1.5">
              <span className="text-ui-caption font-medium">
                {intl.formatMessage({ id: "providerIntake.baseUrlLabel" })}
              </span>
              <Input
                className={MOBILE_SAFE_INPUT_CLASS}
                value={customBaseUrl}
                placeholder={intl.formatMessage({ id: "providerIntake.baseUrlPlaceholder" })}
                onChange={(event) => {
                  setCustomBaseUrl(event.target.value);
                  resetProbe();
                }}
              />
            </label>
          )}
          {selection?.kind === "template" &&
            !selection.baseUrlEditable &&
            selection.baseUrl && (
              <p className="text-ui-caption text-foreground-subtle font-mono">{selection.baseUrl}</p>
            )}
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between gap-2">
              <span className="text-ui-caption font-medium">
                {intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
              </span>
              {apiKeyManagementUrl && (
                <button
                  type="button"
                  className="cursor-pointer rounded-sm text-ui-caption font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => platform.openExternal(apiKeyManagementUrl)}
                >
                  {intl.formatMessage({ id: "settings.modelProvider.getApiKey" })} →
                </button>
              )}
            </span>
            <ApiKeyInput
              value={apiKey}
              visible={keyVisible}
              onChange={(value) => {
                setApiKey(value);
                resetProbe();
              }}
              onBlur={() => {}}
              onToggleVisibility={() => setKeyVisible((previous) => !previous)}
            />
          </label>
          {saveError && (
            <p role="alert" className="text-ui-caption text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSaveError(null);
                setStep("vendor");
              }}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="submit"
              disabled={
                probeState.kind === "probing" || !apiKey.trim() ||
                (selection?.kind === "custom" && !customBaseUrl.trim())
              }
            >
              {probeState.kind === "probing" ? (
                <Spinner className="size-3.5" />
              ) : (
                intl.formatMessage({ id: "providerIntake.connect" })
              )}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          {selection?.kind === "template" && selection.keyless && (
            // 本地免密厂商提示（§P2.4-5）：llama.cpp --jinja 等本地约束，不作硬门控。
            <p role="status" className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "providerIntake.localHint" })}
            </p>
          )}
          {probeState.kind === "done" && probeState.warning && (
            <p role="status" className="text-ui-caption text-warning">
              {intl.formatMessage({ id: "providerIntake.unverified" })}
            </p>
          )}
          {modelFetchState.kind === "loading" && (
            <div className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
              <Spinner className="size-3.5" />
              {intl.formatMessage({ id: "providerIntake.modelsFetching" })}
            </div>
          )}
          {modelFetchState.kind === "ready" && modelFetchState.fallback && (
            <p role="status" className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "providerIntake.modelsFallback" })}
            </p>
          )}
          {modelFetchState.kind === "error" && (
            <p role="alert" className="text-ui-caption text-destructive">
              {modelFetchState.message}
            </p>
          )}
          {models.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-ui-caption font-medium">
                  {intl.formatMessage({ id: "providerIntake.modelsTitle" })}
                </span>
                <span className="text-ui-caption text-foreground-subtle">
                  {checkedModelIds.length}/{models.length}
                </span>
              </div>
              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-surface p-2">
                {models.map((modelId) => (
                  <label
                    key={modelId}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
                  >
                    <Checkbox
                      checked={selectedModelIds.has(modelId)}
                      onCheckedChange={() => toggleModel(modelId)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-ui-caption">
                      {modelId}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-caption font-medium">
              {intl.formatMessage({ id: "providerIntake.defaultModelLabel" })}
            </span>
            <select
              className="h-8 rounded-lg border border-input-border bg-input px-3 text-ui-base outline-none hover:border-input-border-hover focus-visible:border-input-border-focused"
              value={defaultModelId}
              disabled={checkedModelIds.length === 0}
              onChange={(event) => setDefaultModelId(event.target.value)}
            >
              {checkedModelIds.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <Input
              className={MOBILE_SAFE_INPUT_CLASS}
              value={manualModelId}
              placeholder={intl.formatMessage({ id: "providerIntake.manualModelPlaceholder" })}
              onChange={(event) => setManualModelId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addManualModel();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!manualModelId.trim()}
              onClick={addManualModel}
            >
              {intl.formatMessage({ id: "providerIntake.manualModelAdd" })}
            </Button>
          </div>
          {saveError && (
            <p role="alert" className="text-ui-caption text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setSaveError(null);
                setStep("key");
              }}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="button"
              disabled={saving || checkedModelIds.length === 0 || !defaultModelId}
              onClick={() => void finish()}
            >
              {saving ? (
                <Spinner className="size-3.5" />
              ) : (
                intl.formatMessage({ id: "providerIntake.finish" })
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function resolveTemplateName(
  template: { templateNameMap?: Record<string, string> },
  locale: string,
): string {
  return template.templateNameMap?.[locale] ?? template.templateNameMap?.["en-US"] ?? "";
}

/** 探测/发现错误四分类本地化（§P1.R2）；unknown 原样透出 message。 */
function describeAccessError(
  intl: { formatMessage: (descriptor: { id: string }) => string },
  errorKind: string,
  message: string,
): string {
  switch (errorKind) {
    case "invalid-key":
      return intl.formatMessage({ id: "providerIntake.errInvalidKey" });
    case "rate-limited":
      return intl.formatMessage({ id: "providerIntake.errRateLimited" });
    case "network":
      return intl.formatMessage({ id: "providerIntake.errNetwork" });
    case "endpoint-miss":
      return intl.formatMessage({ id: "providerIntake.errEndpointMiss" });
    default:
      return message || intl.formatMessage({ id: "providerIntake.errUnknown" });
  }
}
