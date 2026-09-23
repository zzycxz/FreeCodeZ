// 「搜索与视觉」卡1 原生搜索状态行三态映射单测(spec §4.3f-1)。
// 运行:cd packages/ui && npx tsx --test test/searchVisionStatus.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveNativeSearchStatus } from "../src/lib/searchVisionStatus.js";

function view(supportsNativeWebSearch: boolean) {
  return {
    effectiveSelection: { providerId: "p1", modelId: "m1" },
    providers: [
      {
        providerId: "p1",
        models: [
          {
            modelId: "m1",
            config: { properties: { supportsNativeWebSearch } },
          },
        ],
      },
    ],
  };
}

test("模型声明原生搜索 → native", () => {
  assert.equal(resolveNativeSearchStatus(view(true)), "native");
});

test("声明不支持或缺省 → fallback,不猜成可用", () => {
  assert.equal(resolveNativeSearchStatus(view(false)), "fallback");
  const absent = view(true);
  delete (absent.providers[0]!.models[0]!.config.properties as { supportsNativeWebSearch?: boolean })
    .supportsNativeWebSearch;
  assert.equal(resolveNativeSearchStatus(absent), "fallback");
});

test("无 view/无选择/模型不在视图 → unknown", () => {
  assert.equal(resolveNativeSearchStatus(null), "unknown");
  assert.equal(resolveNativeSearchStatus(undefined), "unknown");
  assert.equal(resolveNativeSearchStatus({ providers: [] }), "unknown");
  assert.equal(
    resolveNativeSearchStatus({
      effectiveSelection: { providerId: "gone", modelId: "m1" },
      providers: [],
    }),
    "unknown",
  );
});
