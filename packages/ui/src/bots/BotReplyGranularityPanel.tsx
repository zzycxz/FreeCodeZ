/**
 * 机器人回复颗粒度（附录C §1.5 `Zrn`）：feishu/lark 仅流式卡片一档，其余三档。
 */
import type { BotConfig, ReplyMode } from "@zcode/shared/bots";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotPanelRow } from "@/bots/BotHeader.js";
import { listBotReplyModes, resolveBotReplyModeOption } from "@/bots/botsApi.js";

/** 档位 label key（附录C §5.4 `bots.replyGranularity.*`）。 */
const REPLY_MODE_LABEL_IDS: Record<ReplyMode, string> = {
  assistant_changes: "bots.replyGranularity.assistantChanges",
  assistant_toolcalls_changes: "bots.replyGranularity.assistantToolcallsChanges",
  summary_changes: "bots.replyGranularity.summaryChanges",
  streaming_card: "bots.replyGranularity.streamingCard",
};

export function BotReplyGranularityPanel({
  bot,
  onPatchBot,
}: {
  bot: BotConfig;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const options = listBotReplyModes(bot.provider);
  const current = resolveBotReplyModeOption(bot.provider, bot.replyMode);
  return (
    <BotPanelRow
      label={intl.formatMessage({ id: "bots.replyGranularity" })}
      description={intl.formatMessage({ id: current.descriptionId })}
      control={
        <Select
          value={current.mode}
          onValueChange={(value) => onPatchBot({ replyMode: value as ReplyMode })}
        >
          <SelectTrigger size="lg" className="w-48 justify-between">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.mode} value={option.mode}>
                {intl.formatMessage({ id: REPLY_MODE_LABEL_IDS[option.mode] })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}
