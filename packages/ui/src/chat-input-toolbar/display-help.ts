import type { ZCodeProvider } from "@zcode/shared";

export const ZCODE_MODE_OPTION_LABEL_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    // U2-1（移植自 ZCode 3.15.1，上游 mode.label.glm.guarded=自主模式/"Ask when there's risk"）
    guarded: "mode.label.glm.guarded",
    yolo: "mode.label.glm.yolo",
  },
};

export const ZCODE_MODE_OPTION_DESCRIPTION_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    build: "mode.description.glm.build",
    edit: "mode.description.glm.edit",
    plan: "mode.description.glm.plan",
    guarded: "mode.description.glm.guarded",
    yolo: "mode.description.glm.yolo",
  },
};
