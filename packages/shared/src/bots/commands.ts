// 命令文法（附录B §1.1/§1.2）：纯函数，host 与测试共用。
// 17 词法动词 → 27 结果类型 / 33 别名串；非命令且 trim 后 "0" → selection.cancel。

export interface BotCommandMessage {
  type: "message";
  text: string;
}
export interface BotCommandSelectionCancel {
  type: "selection.cancel";
}
export interface BotCommandBind {
  type: "bind";
  code: string;
}
export interface BotCommandSimple {
  type:
    | "help"
    | "status"
    | "new"
    | "reconnect"
    | "stop"
    | "workspace.list"
    | "model.list"
    | "mode.list"
    | "thoughtLevel.list"
    | "task.list"
    | "reply.list"
    | "elicitation.submit";
}
export interface BotCommandValue {
  type:
    | "workspace.set"
    | "mode.set"
    | "model.provider.set"
    | "model.set"
    | "thoughtLevel.set"
    | "task.set"
    | "reply.set"
    | "permission.respond"
    | "elicitation.respond"
    | "deny";
  value: string;
}
export interface BotCommandApprove {
  type: "approve";
  requestId: string;
  optionId: string;
}
export interface BotCommandUnknown {
  type: "unknown";
  name: string;
  raw: string;
}

export type ParsedBotCommand =
  | BotCommandMessage
  | BotCommandSelectionCancel
  | BotCommandBind
  | BotCommandSimple
  | BotCommandValue
  | BotCommandApprove
  | BotCommandUnknown;

export interface SplitCommand {
  name: string;
  rest: string;
}

/** trim 后以 "/" 开头才成命令；name 小写；rest 去首尾空白。 */
export function splitCommand(text: string): SplitCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const match = /^(\S*)([\s\S]*)$/u.exec(body);
  if (!match) return null;
  return { name: (match[1] ?? "").toLowerCase(), rest: (match[2] ?? "").trim() };
}

const ELICITATION_SUBMIT_TOKENS = new Set(["submit", "done", "完成", "提交"]);

export function parseBotCommand(text: string): ParsedBotCommand {
  const split = splitCommand(text);
  if (!split) {
    if (text.trim() === "0") return { type: "selection.cancel" };
    return { type: "message", text };
  }
  const { name, rest } = split;
  const raw = text.trim();
  switch (name) {
    case "bind":
      return rest ? { type: "bind", code: rest } : { type: "unknown", name, raw };
    case "help":
    case "帮助":
      return { type: "help" };
    case "cancel":
    case "取消":
      return { type: "selection.cancel" };
    case "status":
    case "状态":
      return { type: "status" };
    case "new":
    case "clear":
    case "新建":
      return { type: "new" };
    case "reconnect":
    case "重连":
      return { type: "reconnect" };
    case "stop":
    case "停止":
      return { type: "stop" };
    case "workspace":
    case "project":
    case "项目":
      return rest ? { type: "workspace.set", value: rest } : { type: "workspace.list" };
    case "model":
    case "模型":
      return parseModelCommand(rest);
    case "mode":
    case "模式":
      return rest ? { type: "mode.set", value: rest } : { type: "mode.list" };
    case "thoughtlevel":
    case "thought_level":
    case "thought-level":
    case "think":
    case "思考":
      return rest ? { type: "thoughtLevel.set", value: rest } : { type: "thoughtLevel.list" };
    case "task":
      return rest ? { type: "task.set", value: rest } : { type: "task.list" };
    case "reply":
    case "回复":
      return rest ? { type: "reply.set", value: rest } : { type: "reply.list" };
    case "permission":
      return rest
        ? { type: "permission.respond", value: rest }
        : { type: "unknown", name, raw };
    case "elicitation":
    case "answer":
    case "回答":
      if (!rest) return { type: "unknown", name, raw };
      return ELICITATION_SUBMIT_TOKENS.has(rest.toLowerCase())
        ? { type: "elicitation.submit" }
        : { type: "elicitation.respond", value: rest };
    case "approve": {
      const parts = rest.split(/\s+/u).filter((part) => part.length > 0);
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return { type: "approve", requestId: parts[0], optionId: parts[1] };
      }
      return { type: "unknown", name, raw };
    }
    case "deny":
      return rest ? { type: "deny", value: rest } : { type: "unknown", name, raw };
    default:
      return { type: "unknown", name, raw };
  }
}

function parseModelCommand(rest: string): ParsedBotCommand {
  if (!rest) return { type: "model.list" };
  const providerMatch = /^provider\s+([\s\S]+)$/iu.exec(rest);
  if (providerMatch?.[1]) return { type: "model.provider.set", value: providerMatch[1].trim() };
  const modelMatch = /^model\s+([\s\S]+)$/iu.exec(rest);
  if (modelMatch?.[1]) return { type: "model.set", value: modelMatch[1].trim() };
  return { type: "model.set", value: rest };
}
