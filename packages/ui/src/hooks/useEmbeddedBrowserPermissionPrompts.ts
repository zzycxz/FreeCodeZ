import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EMBEDDED_BROWSER_PROMPT_TIMEOUT_MS,
  type EmbeddedBrowserPermissionPrompt,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";

export interface EmbeddedBrowserPromptWithDeadline {
  prompt: EmbeddedBrowserPermissionPrompt;
  /** 展示倒计时用（20s，超时由 main 侧裁决为拒绝；本地到点即从列表摘除）。 */
  deadlineAt: number;
}

/**
 * U2-4（移植自 ZCode 3.15.1）：内置浏览器权限询问卡数据源。
 * 订阅 main 推送的询问（webContents.send），按 requestId 维护在途列表；
 * 超时由 main 侧裁决，本地到点仅做摘除以保持 UI 与裁决一致。
 */
export function useEmbeddedBrowserPermissionPrompts(guestWebContentsId: number | undefined): {
  prompts: EmbeddedBrowserPromptWithDeadline[];
  resolve: (
    requestId: string,
    action: "allow-always" | "allow-session" | "block-always" | "dismiss",
    selectedDeviceId?: string,
  ) => void;
} {
  const platform = usePlatform();
  const [prompts, setPrompts] = useState<EmbeddedBrowserPromptWithDeadline[]>([]);

  useEffect(() => {
    const off = platform.onEmbeddedBrowserPermissionPrompt?.((prompt) => {
      setPrompts((current) =>
        current.some((entry) => entry.prompt.requestId === prompt.requestId)
          ? current
          : [...current, { prompt, deadlineAt: Date.now() + EMBEDDED_BROWSER_PROMPT_TIMEOUT_MS }],
      );
    });
    return off;
  }, [platform]);

  useEffect(() => {
    if (prompts.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setPrompts((current) => current.filter((entry) => entry.deadlineAt > now));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [prompts.length]);

  const resolve = useCallback(
    (
      requestId: string,
      action: "allow-always" | "allow-session" | "block-always" | "dismiss",
      selectedDeviceId?: string,
    ) => {
      setPrompts((current) => current.filter((entry) => entry.prompt.requestId !== requestId));
      void platform
        .resolveEmbeddedBrowserPermissionPrompt?.({ requestId, action, selectedDeviceId })
        ?.catch(() => {
          // 应答失败：main 侧 20s 超时兜底拒绝，无需 UI 补偿。
        });
    },
    [platform],
  );

  const filtered = useMemo(
    () =>
      prompts.filter(
        (entry) => guestWebContentsId === undefined || entry.prompt.guestWebContentsId === guestWebContentsId,
      ),
    [prompts, guestWebContentsId],
  );

  return { prompts: filtered, resolve };
}
