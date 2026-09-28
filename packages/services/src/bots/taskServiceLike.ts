// IZCodeTaskService 的 bots 桥接子集 + 流事件别名：
// 测试可注入轻量 double；生产走 zcodeTaskService 适配器（结构兼容即可）。
import type { Event } from "@zcode/rpc";
import type { ZCodeStreamEvent } from "@zcode/shared";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";

export type BotTaskStreamEvent = ZCodeStreamEvent;

export type BotTaskServiceLike = Pick<
  IZCodeTaskService,
  | "createTask"
  | "sendPrompt"
  | "resumeTask"
  | "stopGeneration"
  | "respondPermission"
  | "respondElicitation"
  | "setMode"
  | "setModel"
  | "setConfigOption"
  | "listTasks"
  | "listDeletedTaskIds"
  | "getTaskMeta"
  | "getTaskSnapshot"
  | "getTaskModelSelection"
  | "getTaskConfigOptions"
  | "deleteTask"
  | "onDynamicTaskEvent"
> & {
  onDynamicTaskEvent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    clientId?: string;
    deliveryKind?: "continuous" | "replayable" | "mixed";
  }): Event<ZCodeStreamEvent>;
};
