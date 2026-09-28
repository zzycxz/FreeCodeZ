import { LucideProvider } from "lucide-react";
import type { GitRepositorySummary, IPlatformService, ZCodeProvider } from "@zcode/shared";
import type { RemoteTaskListItem, RemoteWorkspaceDescriptor } from "@zcode/shared/web-remote-control";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import type { MobileBridgeConnection } from "./mobileRemoteTypes.js";

// 手机端 chat 视图（附录C §7.3）：renderChatHeader（compact WorkspaceHeader，
// simplifyForNarrowRemote）→ main[data-mobile-chat-surface] 内的既有会话面 V4ChatPane。
// 服务面复用到 RemoteServiceAccess 层（桥 ChannelClient）：发消息/新任务/续任务/传附件
// （≤20MB 分片上传走 attachmentBeginV4/ChunkV4/CommitV4）/停止生成/权限与 elicitation 应答
// 全部由既有 SessionPane/composer/交互弹窗完成，不重写协议。

const EMPTY_GIT_SUMMARY = (workspacePath: string): GitRepositorySummary => ({
  workspacePath,
  repoRoot: workspacePath,
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: null,
  trackingBranchName: null,
  headRefType: "detached",
  ahead: 0,
  behind: 0,
  isDirty: false,
  isGitAvailable: false,
  isRepository: false,
});

export interface MobileChatViewProps {
  bridge: MobileBridgeConnection;
  workspace: RemoteWorkspaceDescriptor;
  task?: RemoteTaskListItem | null;
  platform: IPlatformService;
  sidePaneOpen: boolean;
  onToggleSidePane: () => void;
  onSessionCreated: (sessionId: string) => void;
  onSessionDeleted: () => void;
}

export function MobileChatView({
  bridge,
  workspace,
  task,
  platform,
  sidePaneOpen,
  onToggleSidePane,
  onSessionCreated,
  onSessionDeleted,
}: MobileChatViewProps) {
  const workspacePath = workspace.workspacePath;
  const workspaceIdentity = workspace.workspaceIdentity;
  const sessionId = task?.taskId ?? null;
  // FreeCodeZ 唯一 provider 为 glm（zcode-task-types-core）；远控任务项的 provider 枚举更宽，非 glm 不下传。
  const provider: ZCodeProvider | undefined = task?.provider === "glm" ? "glm" : undefined;

  return (
    <ServiceProvider services={bridge.services}>
      <PlatformProvider platform={platform}>
        <LucideProvider strokeWidth={1.5}>
          <TooltipProvider>
            <TabStoreProvider>
              <MobileChatHeader
                workspace={workspace}
                task={task}
                sidePaneOpen={sidePaneOpen}
                onToggleSidePane={onToggleSidePane}
              />
              <main
                data-mobile-chat-surface="true"
                className="flex min-h-0 flex-1 flex-col"
                aria-hidden={sidePaneOpen || undefined}
                inert={sidePaneOpen ? true : undefined}
              >
                <V4ChatPane
                  workspacePath={workspacePath}
                  {...(workspaceIdentity ? { workspaceIdentity } : {})}
                  sessionId={sessionId}
                  provider={provider}
                  onSessionCreated={onSessionCreated}
                  onSessionDeleted={onSessionDeleted}
                />
              </main>
            </TabStoreProvider>
          </TooltipProvider>
        </LucideProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
}

/** renderChatHeader：compact WorkspaceHeader（isDesktop=false + simplifyForNarrowRemote）。 */
function MobileChatHeader({
  workspace,
  task,
  sidePaneOpen,
  onToggleSidePane,
}: {
  workspace: RemoteWorkspaceDescriptor;
  task?: RemoteTaskListItem | null;
  sidePaneOpen: boolean;
  onToggleSidePane: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { formatMessage } = intl;
  const workspacePath = workspace.workspacePath;
  const title = task?.title.trim() || formatMessage({ id: "taskList.untitled" });
  // FreeCodeZ 唯一 provider 为 glm（zcode-task-types-core），header 选择态固定收敛到该值。
  const provider: ZCodeProvider = "glm";
  return (
    <WorkspaceHeader
      variant={task ? "task" : "draft"}
      workspaceAbsPath={workspacePath}
      {...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {})}
      {...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {})}
      projectName={workspace.label}
      activeTaskTitle={title}
      hasUpdateReady={false}
      activeTaskId={task?.taskId ?? null}
      activeTraceId={null}
      activeSessionId={task?.taskId ?? null}
      activeTaskProvider={task?.provider === "glm" ? "glm" : null}
      sessionLogPath={null}
      nativeSessionLogProvider={null}
      nativeSessionLogPath={null}
      nativeSessionLogExists={false}
      nativeSessionLogLoading={false}
      workspaceHeaderState={{ selectedProvider: provider }}
      gitSummary={EMPTY_GIT_SUMMARY(workspacePath)}
      gitDirtyFileCount={0}
      isDesktop={false}
      simplifyForNarrowRemote
      isSidebarVisible={false}
      isTerminalOpen={false}
      isSidePaneOpen={sidePaneOpen}
      onRefreshGit={() => {}}
      onToggleTerminal={() => {}}
      onToggleBrowser={() => {}}
      onToggleSidePane={onToggleSidePane}
      onReloadSession={() => {}}
      onCreateTask={() => {}}
      onOpenWorkspace={() => {}}
    />
  );
}
