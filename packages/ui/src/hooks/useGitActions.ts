import { useCallback, useState } from "react";
import type { GitRejectHunksResult, GitChangeSourceId } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 条目 7（升级实施手册）：GitPane 动作从占位接通真实 gitService。
 * discard 是 destructive（git restore）——调用方（UI 按钮）必须先弹确认；
 * 本 hook 只做服务调用与错误呈现，不重复确认。
 */
export function useGitActions(options: { workspacePath: string }) {
  const { workspacePath } = options;
  const { intl } = useZCodeIntl();
  const { gitService } = useServices();
  const [refreshVersion, setRefreshVersion] = useState(0);

  const fail = useCallback(
    (action: string, detail: Record<string, unknown>) => {
      logger.warn(`[GitPane] ${action} failed workspace=${workspacePath}`, detail);
      toast(intl.formatMessage({ id: "diff.action.failed.toast" }));
    },
    [intl, workspacePath],
  );

  const bumpRefresh = useCallback(() => {
    setRefreshVersion((value) => value + 1);
  }, []);

  const refresh = useCallback(
    async (_sourceId: GitChangeSourceId) => {
      bumpRefresh();
    },
    [bumpRefresh],
  );

  const stagePaths = useCallback(
    async (paths: string[]) => {
      try {
        await gitService.stagePaths({ workspacePath, paths });
        bumpRefresh();
      } catch (error) {
        fail("stagePaths", { count: paths.length, error: String(error) });
      }
    },
    [gitService, workspacePath, bumpRefresh, fail],
  );

  const unstagePaths = useCallback(
    async (paths: string[]) => {
      try {
        await gitService.unstagePaths({ workspacePath, paths });
        bumpRefresh();
      } catch (error) {
        fail("unstagePaths", { count: paths.length, error: String(error) });
      }
    },
    [gitService, workspacePath, bumpRefresh, fail],
  );

  const discardPaths = useCallback(
    async (paths: string[]) => {
      try {
        await gitService.discardPaths({ workspacePath, paths });
        bumpRefresh();
      } catch (error) {
        fail("discardPaths", { count: paths.length, error: String(error) });
      }
    },
    [gitService, workspacePath, bumpRefresh, fail],
  );

  /**
   * hunk 级拒绝（条目 7 核心）：patch = 观察时的 GitDiffResult.patch；
   * expectedContentHash = 观察时 after 内容指纹（漂移预检，缺省跳过）。
   * 返回结构化结果（stale/hunk_drift 由 UI 呈现可重试指引）。
   */
  const rejectHunks = useCallback(
    async (input: {
      path: string;
      patch: string;
      hunkIndexes: number[];
      expectedContentHash?: string;
    }): Promise<GitRejectHunksResult> => {
      try {
        const result = await gitService.rejectHunks({
          workspacePath,
          path: input.path,
          patch: input.patch,
          hunkIndexes: input.hunkIndexes,
          ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
        });
        if (result.ok) bumpRefresh();
        return result;
      } catch (error) {
        return { ok: false, code: "write_failed", message: String(error) };
      }
    },
    [gitService, workspacePath, bumpRefresh],
  );

  const commit = useCallback(
    async (_message: string) => {
      // commit 走 GitPane 既有提交流（非本 hook 职责）；保留接口兼容。
      bumpRefresh();
    },
    [bumpRefresh],
  );

  return {
    refreshVersion,
    refresh,
    stagePaths,
    unstagePaths,
    discardPaths,
    rejectHunks,
    commit,
  };
}
