import { resolveZaiBusinessBaseUrl } from "@zcode/shared";

// FreeCodeZ fork:Client Scenes 端点(ZCODE_CLIENT_SCENES_URL)已随模板数据本地化删除,
// 见 docs/spec/local-client-scenes.md;不再存在任何 /api/v1/client/scenes 外联。
export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
