// FreeCodeZ fork(2026-09-23 视觉模型误报"不支持读图"修复 §4.3g-修复A):
// 输入框引用提示 chip 判定对象必须是被发送的模型(effectiveSelection 优先于
// preferredSelection)。根因:preferredSelection 是新草稿初始推荐,裸默认选择被拒时
// 退回 Registry 顺序第一个模型(文本模型),与输入框实际选中的视觉模型无关。
// 运行:node --import tsx --test packages/ui/test/composerImageReferenceHint.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposerImageReferenceHintVisible } from "../src/lib/composerImageReferenceHint.js";

function model(supportsImage?: boolean) {
  return {
    modelId: "",
    config: { properties: { inputFormat: { supportsImage } } },
  };
}

function view(params: {
  effective?: { providerId: string; modelId: string } | null;
  preferred?: { providerId: string; modelId: string } | null;
  providers: Array<{
    providerId: string;
    models: Array<{ modelId: string; supportsImage?: boolean }>;
  }>;
}) {
  return {
    ...(params.effective === undefined ? {} : { effectiveSelection: params.effective }),
    ...(params.preferred === undefined ? {} : { preferredSelection: params.preferred }),
    providers: params.providers.map((provider) => ({
      providerId: provider.providerId,
      models: provider.models.map((entry) => ({
        ...model(entry.supportsImage),
        modelId: entry.modelId,
      })),
    })),
  };
}

test("实际选中视觉模型(effectiveSelection)优先,初始推荐是文本模型也不误报", () => {
  const v = view({
    effective: { providerId: "mimo-2", modelId: "pro-ultraspeed" },
    preferred: { providerId: "mimo-2", modelId: "v2.5-pro" },
    providers: [
      {
        providerId: "mimo-2",
        models: [
          { modelId: "v2.5-pro", supportsImage: false },
          { modelId: "pro-ultraspeed", supportsImage: true },
        ],
      },
    ],
  });
  assert.equal(resolveComposerImageReferenceHintVisible(true, v), false);
});

test("实际选中文本模型 → 显示提示", () => {
  const v = view({
    effective: { providerId: "mimo-2", modelId: "v2.5-pro" },
    preferred: { providerId: "mimo-2", modelId: "pro-ultraspeed" },
    providers: [
      {
        providerId: "mimo-2",
        models: [
          { modelId: "v2.5-pro", supportsImage: false },
          { modelId: "pro-ultraspeed", supportsImage: true },
        ],
      },
    ],
  });
  assert.equal(resolveComposerImageReferenceHintVisible(true, v), true);
});

test("无 effectiveSelection(草稿未选模型)退 preferredSelection,原兜底行为保留", () => {
  const v = view({
    preferred: { providerId: "mimo-2", modelId: "v2.5-pro" },
    providers: [
      { providerId: "empty", models: [] },
      {
        providerId: "mimo-2",
        models: [
          { modelId: "v2.5-pro", supportsImage: false },
          { modelId: "flash", supportsImage: true },
        ],
      },
    ],
  });
  assert.equal(resolveComposerImageReferenceHintVisible(true, v), true);
});

test("无图片附件一律不显示;supportsImage 缺省(undefined)不视为 false", () => {
  const v = view({
    effective: { providerId: "p", modelId: "m" },
    providers: [{ providerId: "p", models: [{ modelId: "m" }] }],
  });
  assert.equal(resolveComposerImageReferenceHintVisible(false, v), false);
  assert.equal(resolveComposerImageReferenceHintVisible(true, v), false);
});

test("两种选择都缺 → 视图第一个模型兜底(与原实现一致)", () => {
  const v = view({
    providers: [
      { providerId: "first", models: [{ modelId: "m0", supportsImage: false }] },
    ],
  });
  assert.equal(resolveComposerImageReferenceHintVisible(true, v), true);
});
