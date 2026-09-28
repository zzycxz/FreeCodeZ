// 入站/附件类型的再导出：让非 RPC 模块（attachments 等）按需引用，避免把整包类型散到各文件。
export type {
  BotActor,
  BotAttachment,
  BotConfig,
  BotContext,
  BotDeliveryTarget,
  BotProvider,
  BotSelection,
  BotsConfigV3,
  BotsStateV3,
  ElicitationView,
  InboundMessage,
  OutboundMessage,
  PendingElicitation,
  PendingPermissionOption,
  ReplyMode,
  SelectionOption,
} from "@zcode/shared/bots";
export type { ZCodePromptAttachment } from "@zcode/shared";
