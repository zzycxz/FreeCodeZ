// /bind 处理（附录B §1.5 j4）：私聊门禁 → code 校验（30s TTL/一次性/跨 bot 无效）→
// bot 缺失 → 写 providerUserId/displayName/allowedWorkspaces/allowedCommands/replyMode → bindSuccess+help。
import {
  normalizeAllowedWorkspaces,
  normalizeBotCommandPolicy,
  normalizeBotReplyGranularity,
  validateBotConfig,
  type BotConfig,
  type InboundMessage,
  type OutboundMessage,
} from "@zcode/shared/bots";
import { formatBotMessage } from "./hostMessages.js";
import { buildHelpText, createOutbound, type BotCommandDeps } from "./commandHandlers.js";

export async function handleBindCommand(
  deps: BotCommandDeps,
  message: InboundMessage,
  code: string,
): Promise<OutboundMessage[]> {
  const { actor } = message;
  const locale = await deps.resolveLocale();
  const reply = (text: string): OutboundMessage[] => [
    createOutbound(actor, text, undefined, { locale }),
  ];
  // bind 自带私聊门禁（无策略门控，群聊回 bindPrivateOnly 且不校验 code）
  if (actor.chatType !== "private") {
    return reply(formatBotMessage(locale, "bindPrivateOnly"));
  }
  const record = deps.bindCodes.consume(code, message.botId);
  if (!record) {
    return reply(formatBotMessage(locale, "bindCodeInvalid"));
  }
  const config = await deps.repo.readConfig();
  const bot = config.bots.find((candidate) => candidate.id === message.botId) ?? null;
  if (!bot) {
    return reply(formatBotMessage(locale, "bindBotMissing"));
  }
  const bound: BotConfig = {
    ...bot,
    providerUserId: actor.providerUserId,
    displayName: actor.displayName,
    allowedWorkspaces: normalizeAllowedWorkspaces(record.allowedWorkspaces ?? bot.allowedWorkspaces),
    allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
    replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
  };
  const validation = validateBotConfig(bound, config.bots);
  if (!validation.ok) {
    return reply(formatBotMessage(locale, "bindCodeInvalid"));
  }
  await deps.saveBotConfig(bound);
  return reply(
    [formatBotMessage(locale, "bindSuccess"), buildHelpText(locale, bound)].join("\n\n"),
  );
}
