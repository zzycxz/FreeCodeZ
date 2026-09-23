// FreeCodeZ fork(2026-09-23 视觉模型误报"不支持读图"修复 §4.3g-修复B):
// resolveInitialModelSelection 对裸 configuredDefault(接入向导落盘的
// {providerId,modelId},无 options.reasoningLevel)按「用户主动选模型」同一规则补
// 声明最高档,不再被 isSelectable 按 reasoning-level-missing 静默拒绝后退回
// Registry 顺序第一个模型(用户配置的默认模型从未生效)。
// 运行:node --import tsx --test packages/services/test/modelSelectionBareDefault.test.ts
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../..", import.meta.url);
const modelSelectionConfigUrl = new URL(
  "packages/provider/src/model-selection-config.ts",
  repoRoot,
);

interface ModelStub {
  modelId: string;
  values: readonly string[];
}

function registryStub(providers: Array<{ providerId: string; models: ModelStub[]; hidden?: boolean }>) {
  return {
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      config: { visibility: provider.hidden ? "hidden" : undefined },
      models: provider.models.map((model) => ({
        modelId: model.modelId,
        config: { optionSpecs: { reasoningLevel: { values: model.values } } },
      })),
    })),
  };
}

async function resolve(configuredDefault: unknown, registry: unknown) {
  const { resolveInitialModelSelection } = await import(modelSelectionConfigUrl.href);
  return resolveInitialModelSelection({
    configuredDefault,
    registry,
  } as never);
}

test("裸默认选择 → 补声明最高档,source 仍为 configured-default", async () => {
  const result = await resolve(
    { providerId: "mimo-2", modelId: "flash" },
    registryStub([
      {
        providerId: "mimo-2",
        models: [
          { modelId: "v2.5-pro", values: ["disabled", "enabled"] },
          { modelId: "flash", values: ["low", "medium", "high", "xhigh", "max"] },
        ],
      },
    ]),
  );
  assert.deepEqual(result, {
    source: "configured-default",
    selection: {
      providerId: "mimo-2",
      modelId: "flash",
      options: { reasoningLevel: "max" },
    },
  });
});

test("带合法档位的完整默认 → 原样返回,不重补档", async () => {
  const result = await resolve(
    { providerId: "mimo-2", modelId: "flash", options: { reasoningLevel: "low" } },
    registryStub([
      { providerId: "mimo-2", models: [{ modelId: "flash", values: ["low", "medium"] }] },
    ]),
  );
  assert.deepEqual(result, {
    source: "configured-default",
    selection: { providerId: "mimo-2", modelId: "flash", options: { reasoningLevel: "low" } },
  });
});

test("裸默认指向 hidden/不存在的模型 → 仍走 registry-fallback,不复活失效默认", async () => {
  const registry = registryStub([
    { providerId: "hidden-p", hidden: true, models: [{ modelId: "m", values: ["on"] }] },
    { providerId: "p1", models: [{ modelId: "fallback-m", values: ["off", "on"] }] },
  ]);
  assert.deepEqual(
    await resolve({ providerId: "hidden-p", modelId: "m" }, registry),
    {
      source: "registry-fallback",
      selection: { providerId: "p1", modelId: "fallback-m", options: { reasoningLevel: "on" } },
    },
  );
  assert.deepEqual(
    await resolve({ providerId: "p1", modelId: "missing" }, registry),
    {
      source: "registry-fallback",
      selection: { providerId: "p1", modelId: "fallback-m", options: { reasoningLevel: "on" } },
    },
  );
});

test("裸默认指向空档位模型 → 补不出档,走 registry-fallback", async () => {
  const result = await resolve(
    { providerId: "p1", modelId: "no-levels" },
    registryStub([
      { providerId: "p1", models: [{ modelId: "no-levels", values: [] }] },
      { providerId: "p2", models: [{ modelId: "ok", values: ["low", "high"] }] },
    ]),
  );
  assert.deepEqual(result, {
    source: "registry-fallback",
    selection: { providerId: "p2", modelId: "ok", options: { reasoningLevel: "high" } },
  });
});

test("过期档位(reasoning-level-not-supported)不静默补档,仍走 fallback", async () => {
  const result = await resolve(
    { providerId: "p1", modelId: "m", options: { reasoningLevel: "max" } },
    registryStub([
      { providerId: "p1", models: [{ modelId: "m", values: ["low", "medium"] }] },
    ]),
  );
  assert.equal(result.source, "registry-fallback");
});
