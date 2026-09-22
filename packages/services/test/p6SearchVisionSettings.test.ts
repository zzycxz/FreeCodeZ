// FreeCodeZ fork(P6 §6.2 接线,docs/spec/search-vision-settings.md §8):
// 设置透传协议兼容、safeSearch 参数映射、系统提示条件引导、caption 渲染。
// 运行:npx tsx --test packages/services/test/p6SearchVisionSettings.test.ts
// (沿用 p6SearchCapabilities.test.ts 的 URL 直引源码模式,绕开包依赖。)
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../..", import.meta.url);
const sharedProtocol = new URL("packages/shared/src/zcode-protocol/index.ts", repoRoot);
const imageSearch = new URL(
  "apps/zcode-cli/packages/core/src/tool/handlers/image-search.ts",
  repoRoot,
);
const visionGuidance = new URL(
  "apps/zcode-cli/packages/core/src/context/sections/vision-guidance.ts",
  repoRoot,
);
const normalizeSettingsPatchUrl = new URL(
  "packages/services/src/setting/normalizeSettingsPatch.ts",
  repoRoot,
);

test("runtime preferences schema accepts new search/vision fields", async () => {
  const { zcodeSessionRuntimePreferencesResultSchema } = await import(sharedProtocol.href);
  const parsed = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: "preflight-v1",
    searchSummaryMode: "vlm",
    searchSafeSearch: "strict",
    searchCountry: "cn",
    visionUnderstandModel: "zhipu/glm-4.6v",
  });
  assert.equal(parsed.searchSummaryMode, "vlm");
  assert.equal(parsed.searchSafeSearch, "strict");
  assert.equal(parsed.searchCountry, "cn");
  assert.equal(parsed.visionUnderstandModel, "zhipu/glm-4.6v");
});

test("runtime preferences schema defaults for legacy hosts (fields absent)", async () => {
  const { zcodeSessionRuntimePreferencesResultSchema } = await import(sharedProtocol.href);
  // 旧 Host 应答不含新字段:必须在解析边界取协议默认,而非 undefined 透传到工具。
  const parsed = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
  });
  assert.equal(parsed.searchSummaryMode, "on");
  assert.equal(parsed.searchSafeSearch, "moderate");
  assert.equal(parsed.searchCountry, undefined);
  assert.equal(parsed.visionUnderstandModel, undefined);
});

test("runtime preferences schema rejects unknown fields (strict)", async () => {
  const { zcodeSessionRuntimePreferencesResultSchema } = await import(sharedProtocol.href);
  // .strict() 白名单:Host 侧组装漂移(拼错字段名)必须在协议层被拒,不能静默丢字段。
  assert.throws(() =>
    zcodeSessionRuntimePreferencesResultSchema.parse({
      nativeSearchEnhancementsEnabled: true,
      searchSummaryMod: "on",
    }),
  );
});

test("serpapiSafeSearchParam maps three modes onto serpapi's active/off", async () => {
  const { serpapiSafeSearchParam } = await import(imageSearch.href);
  assert.equal(serpapiSafeSearchParam("off"), "off");
  assert.equal(serpapiSafeSearchParam("moderate"), "active");
  assert.equal(serpapiSafeSearchParam("strict"), "active");
});

test("image search model content renders vlm captions", async () => {
  const { imageSearchToolEntry } = await import(imageSearch.href);
  const output = {
    query: "apples",
    results: [
      {
        kind: "image",
        title: "Ripe red apples",
        caption: "阳光下树上挂着的红苹果",
        originalUrl: "https://example.com/apple.jpg",
        width: 1600,
        height: 1102,
        provider: "serpapi",
      },
    ],
    meta: {
      provider: "serpapi",
      cacheHit: false,
      requestMs: 800,
      page: 1,
      pageSize: 10,
      hasMore: true,
    },
  };
  const content = imageSearchToolEntry.formatModelContent!(output) as string;
  assert.match(content, /Ripe red apples — 阳光下树上挂着的红苹果/);
  assert.match(content, /1600x1102/);
});

test("vision guidance section only injected for non-vision models", async () => {
  const { buildVisionGuidanceSection } = await import(visionGuidance.href);
  const visionModel = { properties: { inputFormat: { supportsImage: true } } };
  const textModel = { properties: { inputFormat: { supportsImage: false } } };

  assert.equal(buildVisionGuidanceSection(visionModel), null);
  assert.equal(buildVisionGuidanceSection(undefined), null);

  const section = buildVisionGuidanceSection(textModel);
  assert.ok(section);
  // 上下文经济学约束(spec §2/§4.5):引导段必须小且稳定,不破坏前缀缓存。
  assert.equal(section.cacheHint, "stable");
  assert.ok(section.chars < 600, `guidance too large: ${section.chars} chars`);
  assert.match(section.content, /ImageUnderstand/);
});

test("settings patch normalizes empty strings to cleared search/vision fields", async () => {
  const { normalizeSettingsPatch } = await import(normalizeSettingsPatchUrl.href);
  // RPC 传输会吞掉 undefined,UI 清空走空串;归一层必须把它变回 undefined,
  // 否则 {...current, ...patch} 合并后旧值残留,「跟随当前会话模型」永远清不掉。
  const cleared = normalizeSettingsPatch({ searchCountry: "", visionUnderstandModel: "" });
  assert.equal(cleared.searchCountry, undefined);
  assert.equal(cleared.visionUnderstandModel, undefined);

  const set = normalizeSettingsPatch({
    searchCountry: " cn ",
    visionUnderstandModel: " zhipu/glm-4.6v ",
  });
  assert.equal(set.searchCountry, "cn");
  assert.equal(set.visionUnderstandModel, "zhipu/glm-4.6v");
});
