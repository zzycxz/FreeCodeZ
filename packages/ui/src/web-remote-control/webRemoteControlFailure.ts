import type { FailureReason } from "@zcode/shared/web-remote-control";
import { failureReasonI18nKeys } from "@zcode/shared/web-remote-control";

/** 与 intl.formatMessage 同形，便于非 hook 场景（useMemo 派生）复用映射。 */
export type WebRemoteControlFormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface WebRemoteControlFailureView {
  reason: FailureReason;
  message: string;
}

/**
 * 11 个失败 reason → 弹窗横幅文案。
 *
 * `session-conflict` 需按 message 分流：单终端配对下第二页面把旧页面顶掉时 relay 发 KICKED，
 * 文案要说明"被踢出"而不是"被占用"（spec 失败语义 §3，附录C §1.2 `pin`）。
 */
export function resolveWebRemoteControlFailureMessage(
  failure: WebRemoteControlFailureView | null | undefined,
  formatMessage: WebRemoteControlFormatMessage,
): string | null {
  if (!failure) {
    return null;
  }
  const messageKey =
    failure.reason === "session-conflict" && failure.message.toLowerCase().includes("kicked")
      ? "webRemoteControl.failure.kicked"
      : failureReasonI18nKeys[failure.reason];
  return formatMessage({ id: messageKey });
}
