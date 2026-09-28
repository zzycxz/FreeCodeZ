import { BUNDLED_CLIENT_SCENES } from "./bundledClientScenes.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

/**
 * Client Scenes 数据来源：随包内置，不再请求远程 ZCode 后端。
 *
 * FreeCodeZ fork：默认端点自 P4 §3.2 起是占位域 `https://freecodez.local`（不解析），
 * 远程拉取必然失败，定时/闲时任务模板与输入框推荐提示词长期为空。按产品裁决
 * （docs/spec/local-client-scenes.md）改为内置数据。
 *
 * 契约保持 `list(): Promise<ClientScenesResponse>` 不变，下游
 * `useClientScenesResource` 与模板映射无需改动。
 */
export function createClientScenesService(): IClientScenesService {
  return {
    // 每次返回拷贝，避免下游把内置常量当成可变数组就地改写。
    list: () =>
      Promise.resolve<ClientScenesResponse>({
        code: 0,
        msg: "",
        data: [...BUNDLED_CLIENT_SCENES],
      }),
  };
}
