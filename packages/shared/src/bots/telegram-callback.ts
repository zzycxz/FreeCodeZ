// Telegram callback_data 编解码（附录B §1.4）：纯函数。
// 数字 = 选项 1-based 下标；飞书按钮走 value.command 文本命令；微信走数字序号。

export type SelectionAction =
  | "workspace.set"
  | "model.provider.set"
  | "model.set"
  | "mode.set"
  | "thoughtLevel.set"
  | "task.set"
  | "reply.set"
  | "permission.respond"
  | "elicitation.respond";

export interface SelectionCallbackSpec {
  action: SelectionAction;
  index: number;
  token?: string;
  cancel?: boolean;
}

export function buildSelectionCallbackData(spec: SelectionCallbackSpec): string {
  if (spec.cancel) return "zc:cancel";
  const n = spec.index;
  switch (spec.action) {
    case "permission.respond":
      return `zc:permission:${n}`;
    case "elicitation.respond":
      return spec.token ? `zc:e:${spec.token}:${n}` : `zc:elicitation:${n}`;
    case "model.provider.set":
      return `zc:cmd:/model provider ${n}`;
    case "model.set":
      return `zc:cmd:/model model ${n}`;
    default:
      return `zc:${spec.action.replace(".set", "")}:${n}`;
  }
}

/** 解码为可直接进入 parseBotCommand 的文本命令。 */
export function decodeTelegramCallbackData(data: string): string {
  if (data === "zc:cancel") return "/cancel";
  if (data.startsWith("zc:e:")) {
    const body = data.slice("zc:e:".length);
    const sep = body.lastIndexOf(":");
    if (sep > 0) {
      const token = body.slice(0, sep);
      const index = body.slice(sep + 1);
      return `/elicitation ${token} ${index}`;
    }
    return `/elicitation ${body}`;
  }
  if (data.startsWith("zc:cmd:")) return data.slice("zc:cmd:".length);
  if (data.startsWith("zc:")) return `/${data.slice(3).replace(":", " ")}`;
  return data;
}
