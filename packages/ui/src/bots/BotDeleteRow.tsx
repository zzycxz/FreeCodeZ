/** 危险区「删除机器人」（附录C §1.5 `Qrn`）：二次确认由弹窗负责。 */
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotPanelGroup, BotPanelRow } from "@/bots/BotHeader.js";

export function BotDeleteRow({ onDelete }: { onDelete: () => void }) {
  const { intl } = useZCodeIntl();
  const deleteLabel = intl.formatMessage({ id: "bots.delete" });
  return (
    <BotPanelGroup>
      <BotPanelRow
        label={deleteLabel}
        description={intl.formatMessage({ id: "bots.delete.description" })}
        control={
          <Button variant="destructive" size="lg" onClick={onDelete} title={deleteLabel}>
            <Trash2 className="size-4" />
            {deleteLabel}
          </Button>
        }
      />
    </BotPanelGroup>
  );
}
