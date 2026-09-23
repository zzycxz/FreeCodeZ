// FreeCodeZ fork(2026-09-23 视觉绑定解析修复):modelFactory 对 reasoning-level-missing
// 补模型首个可用档的回归锁定。根因:视觉模型绑定存裸 picker 串,selection 缺
// options.reasoningLevel,registry 校验直接拒绝且被 resolveSearchVisionModel 的 catch
// 静默吞掉,绑定从未生效(报"未配置"误导文案)。
// 运行:node --import tsx --test packages/services/test/modelSelectionReasoningDefault.test.ts
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../..", import.meta.url);
const modelRuntimeUrl = new URL(
  "apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts",
  repoRoot,
);
const providerRegistryUrl = new URL("packages/provider/src/registry.ts", repoRoot);

interface StubModel {
  providerId: string;
  modelId: string;
  options: { reasoningLevel: string };
}

async function buildRuntime(values: readonly string[]) {
  const { ApiProviderModelRuntime } = await import(modelRuntimeUrl.href);
  const { validateModelSelectionOptions } = await import(providerRegistryUrl.href);
  const providerStub = { providerId: "p1", config: {} };
  const modelStub = {
    modelId: "m1",
    config: { optionSpecs: { reasoningLevel: { values } } },
  };
  const created: StubModel[] = [];
  const runtime = new ApiProviderModelRuntime({
    registry: {
      getView: () => ({ providers: [] }),
      getProvider: (id: string) => (id === "p1" ? providerStub : undefined),
      getModel: (pid: string, mid: string) =>
        pid === "p1" && mid === "m1" ? modelStub : undefined,
      validateSelection: (selection: { providerId: string; modelId: string }) =>
        validateModelSelectionOptions(modelStub, selection),
      onDidChange: () => () => {},
    } as never,
    modelAdapter: {
      createModel: (input: {
        providerId: string;
        modelId: string;
        options: { reasoningLevel: string };
      }) => {
        const model = {
          providerId: input.providerId,
          modelId: input.modelId,
          options: input.options,
        };
        created.push(model);
        return model;
      },
    } as never,
  });
  runtime.start();
  return { runtime, created };
}

test("selection 缺推理档位时补模型声明的首个可用档(视觉绑定路径)", async () => {
  const { runtime } = await buildRuntime(["low", "medium", "high"]);
  const model = runtime.modelFactory({
    selection: { providerId: "p1", modelId: "m1" },
  }) as unknown as StubModel;
  assert.equal(model.options.reasoningLevel, "low");
});

test("显式档位不被补全覆盖", async () => {
  const { runtime } = await buildRuntime(["low", "medium", "high"]);
  const model = runtime.modelFactory({
    selection: { providerId: "p1", modelId: "m1", options: { reasoningLevel: "high" } },
  }) as unknown as StubModel;
  assert.equal(model.options.reasoningLevel, "high");
});

test("不支持的档位仍严格抛错(不静默改档)", async () => {
  const { runtime } = await buildRuntime(["low", "medium", "high"]);
  assert.throws(() =>
    runtime.modelFactory({
      selection: { providerId: "p1", modelId: "m1", options: { reasoningLevel: "ultra" } },
    }),
  );
});

test("模型无任何可用档位时仍抛原始校验错(不造值)", async () => {
  const { runtime } = await buildRuntime([]);
  assert.throws(() =>
    runtime.modelFactory({ selection: { providerId: "p1", modelId: "m1" } }),
  );
});
