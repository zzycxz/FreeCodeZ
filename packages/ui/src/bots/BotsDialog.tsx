/* eslint-disable max-lines -- 机器人弹窗的状态机（绑定码/两种扫码注册/6 个定时器/自动引导）与面板组合必须共享同一份状态所有者，拆文件会把一次保存的乐观更新与回滚切成多处真相。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotConfig, BotProvider, BotsConfigV3 } from "@zcode/shared/bots";
import { isAllWorkspacesAllowed } from "@zcode/shared/bots";
import { Bot, LoaderCircle, Plus } from "lucide-react";
import { toDataURL } from "qrcode";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { BotChannelIcon, BotChannelLabel } from "@/bots/BotChannelIcon.js";
import { BotHeader, BotPanelGroup, resolveBotStatusDotClassName } from "@/bots/BotHeader.js";
import {
  BotCredentialPanel,
  type FeishuRegistrationView,
  type WeixinRegistrationView,
} from "@/bots/BotCredentialPanel.js";
import type { BotBindCodeState } from "@/bots/BotBindCodeCard.js";
import { BotReplyGranularityPanel } from "@/bots/BotReplyGranularityPanel.js";
import { BotAllowedWorkspacesPanel } from "@/bots/BotAllowedWorkspacesPanel.js";
import { BotDeleteRow } from "@/bots/BotDeleteRow.js";
import { TELEGRAM_BOT_FATHER_URL } from "@/bots/TelegramBotFatherCard.js";
import {
  createDefaultBot,
  createEmptyBotsConfig,
  isFeishuLikeProvider,
  resolveBotDisplayName,
  useBotsService,
  type BotRuntimeView,
  type BotStateView,
  type BotWorkspaceRef,
} from "@/bots/botsApi.js";

const LOG_SCOPE = "[BotsDialog]";
/** 绑定码 TTL（附录B §3：30s 内存一次性）。 */
const BIND_CODE_TTL_MS = 30_000;
const WEBHOOK_AUTH_HEADER_DEFAULT = "x-zcode-bot-secret";

/** 渠道目录（附录C §1.3 `krn`）：webhook 在 FreeCodeZ 放开创建（决策 R11）。 */
const BOT_CHANNEL_CATALOG: readonly {
  id: BotProvider | "dingding";
  label: string;
  implemented: boolean;
}[] = [
  { id: "weixin", label: "Weixin", implemented: true },
  { id: "feishu", label: "Feishu", implemented: true },
  { id: "lark", label: "Lark", implemented: true },
  { id: "telegram", label: "Telegram", implemented: true },
  { id: "dingding", label: "DingTalk", implemented: false },
  { id: "discord", label: "Discord", implemented: false },
  { id: "wecom", label: "WeCom", implemented: false },
  { id: "webhook", label: "Webhook", implemented: true },
];

type EntryTarget = { mode: "select"; botId: string } | { mode: "create"; provider: BotProvider };

/** entryProvider 定位（附录C §1.3 `Irn`）：该渠道已有 bot 选中，否则新建并预选渠道。 */
function resolveEntryTarget(bots: readonly BotConfig[], provider: string): EntryTarget {
  const existing = bots.find((bot) => bot.provider === provider);
  return existing
    ? { mode: "select", botId: existing.id }
    : { mode: "create", provider: provider as BotProvider };
}

export function BotsDialog({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  entryProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  entryProvider?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const botsService = useBotsService();

  const [config, setConfig] = useState<BotsConfigV3>(() => createEmptyBotsConfig());
  const [workspaceRefs, setWorkspaceRefs] = useState<BotWorkspaceRef[]>([]);
  const [status, setStatus] = useState<{ botRuntime: BotRuntimeView[] } | null>(null);
  const [botStates, setBotStates] = useState<BotStateView[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState<string | null>(null);
  const [bindCode, setBindCode] = useState<BotBindCodeState | null>(null);
  const [feishuRegistration, setFeishuRegistration] = useState<FeishuRegistrationView | null>(null);
  const [feishuRegistrationLoading, setFeishuRegistrationLoading] = useState(false);
  const [weixinRegistration, setWeixinRegistration] = useState<WeixinRegistrationView | null>(null);
  const [weixinRegistrationLoading, setWeixinRegistrationLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [credentialValue, setCredentialValue] = useState("");
  const [secretSaving, setSecretSaving] = useState(false);
  const [allowedWorkspacesSaving, setAllowedWorkspacesSaving] = useState(false);
  const [nameDraft, setNameDraft] = useState<{ botId: string; value: string } | null>(null);
  const [renamingBotId, setRenamingBotId] = useState<string | null>(null);

  const entryProviderHandledRef = useRef<string | null>(null);
  const registrationGuardRef = useRef(new Set<string>());
  const bindCodeGuardRef = useRef(new Set<string>());

  const currentWorkspace = useMemo<BotWorkspaceRef>(
    () => ({
      id: workspaceIdentity?.trim() || workspacePath,
      label: workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspaceIdentity, workspacePath],
  );

  const selectedBot = config.bots.find((bot) => bot.id === selectedBotId) ?? null;
  const selectedBotState = botStates.find((state) => state.botId === selectedBotId) ?? null;
  const selectedRuntime = selectedBot
    ? (status?.botRuntime.find((item) => item.botId === selectedBot.id) ?? undefined)
    : undefined;
  const fallbackName = intl.formatMessage({ id: "bots.newBot.fallbackName" });
  const selectedBotName =
    nameDraft && nameDraft.botId === selectedBot?.id ? nameDraft.value : (selectedBot?.name ?? "");
  const bindRemainingMs = bindCode ? Math.max(0, bindCode.expiresAt - now) : 0;
  const bindExpired = Boolean(bindCode && bindRemainingMs <= 0);
  const bindCountdownProgress = bindCode
    ? Math.max(0, Math.min(100, (bindRemainingMs / Math.max(1, bindCode.ttlMs)) * 100))
    : 0;

  // 绑定码 250ms 倒计时 tick（附录C §1.3 定时器表）。
  useEffect(() => {
    if (!open || !bindCode) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [bindCode, open]);

  // 绑定结果 2s 轮询：providerUserId 出现即清码。
  useEffect(() => {
    if (!open || !bindCode || bindExpired || !botsService) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await botsService.getConfig();
        if (cancelled) {
          return;
        }
        setConfig(next);
        if (next.bots.find((bot) => bot.id === bindCode.botId)?.providerUserId) {
          setBindCode(null);
        }
      } catch (error) {
        logger.warn(
          `${LOG_SCOPE} 轮询 Bot 绑定结果失败`,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bindCode, bindExpired, botsService, open]);

  useEffect(() => {
    if (!bindCode || bindCode.botId !== selectedBot?.id || !selectedBot.providerUserId) {
      return;
    }
    setBindCode(null);
  }, [bindCode, selectedBot?.id, selectedBot?.providerUserId]);

  // 切换 bot 时清掉上一个 bot 的凭据草稿与注册会话。
  useEffect(() => {
    setCredentialValue("");
    setSecretSaving(false);
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  }, [selectedBot?.id, selectedBot?.provider]);

  // 运行状态 2s 轮询（递归 setTimeout，官方语义）。
  useEffect(() => {
    if (!open || !botsService) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await botsService.getStatus();
        if (!cancelled) {
          setStatus(next);
        }
      } catch (error) {
        logger.debug(
          `${LOG_SCOPE} 刷新 Bot 运行状态失败`,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void poll(), 2000);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [botsService, open]);

  const reload = useCallback(async () => {
    if (!botsService) {
      return;
    }
    try {
      const [nextConfig, nextStatus, nextRefs, nextStates] = await Promise.all([
        botsService.getConfig(),
        botsService.getStatus(),
        botsService.listWorkspaceRefs({ currentWorkspace }),
        botsService.getBotStates(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setWorkspaceRefs(nextRefs);
      setBotStates(nextStates);
      setLoaded(true);
      setSelectedBotId((current) => current ?? nextConfig.bots[0]?.id ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_SCOPE} 加载 Bots 配置失败`, message);
      toast(intl.formatMessage({ id: "bots.loadFailed" }, { error: message }));
    }
  }, [botsService, currentWorkspace, intl.formatMessage]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setLoaded(false);
    void reload();
  }, [open, reload]);

  // 微信激活 2s 轮询：有凭据但 bot_token 尚未激活（附录C §1.3）。
  useEffect(() => {
    if (
      !open ||
      !botsService ||
      selectedBot?.provider !== "weixin" ||
      !selectedBot.credentialRef ||
      selectedBotState?.weixinActivatedAt
    ) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await botsService.getBotStates();
        if (!cancelled) {
          setBotStates(next);
        }
      } catch (error) {
        logger.warn(
          `${LOG_SCOPE} 轮询微信 Bot 激活状态失败`,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const timer = setInterval(() => void poll(), 2000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    botsService,
    open,
    selectedBot?.credentialRef,
    selectedBot?.id,
    selectedBot?.provider,
    selectedBotState?.weixinActivatedAt,
  ]);

  const saveBot = useCallback(
    async (
      bot: BotConfig,
      options?: { credentialValue?: string; webhookSecretValue?: string },
    ): Promise<BotConfig> => {
      if (!botsService) {
        return bot;
      }
      const saved = await botsService.saveBot({
        bot,
        ...(options?.credentialValue ? { credentialValue: options.credentialValue } : {}),
        ...(options?.webhookSecretValue ? { webhookSecretValue: options.webhookSecretValue } : {}),
      });
      setConfig((current) => ({
        ...current,
        bots: [...current.bots.filter((item) => item.id !== saved.id), saved],
      }));
      setSelectedBotId(saved.id);
      setCreatingNew(false);
      setCreatingProvider(null);
      setCredentialValue("");
      await reload();
      return saved;
    },
    [botsService, reload],
  );

  const createBindCode = useCallback(
    async (bot: BotConfig) => {
      if (!botsService) {
        return;
      }
      const createdAt = Date.now();
      const created = await botsService.createBindCode({
        botId: bot.id,
        ttlMs: BIND_CODE_TTL_MS,
        allowedWorkspaces: bot.allowedWorkspaces,
      });
      setNow(createdAt);
      setBindCode({
        botId: bot.id,
        code: created.code,
        expiresAt: created.expiresAt,
        createdAt,
        ttlMs: Math.max(1, created.expiresAt - createdAt),
      });
    },
    [botsService],
  );

  const beginFeishuRegistration = useCallback(async () => {
    if (!botsService || !selectedBot || !isFeishuLikeProvider(selectedBot.provider)) {
      return;
    }
    setFeishuRegistrationLoading(true);
    try {
      const started = await botsService.beginFeishuRegistration({
        domain: selectedBot.provider === "lark" ? "lark" : "feishu",
      });
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await toDataURL(started.qrUrl, { margin: 1, width: 220 });
      } catch (error) {
        logger.error(
          `${LOG_SCOPE} 生成飞书注册二维码失败`,
          error instanceof Error ? error.message : String(error),
        );
      }
      setFeishuRegistration({
        botId: selectedBot.id,
        deviceCode: started.deviceCode,
        qrUrl: started.qrUrl,
        qrDataUrl,
        ...(started.userCode ? { userCode: started.userCode } : {}),
        interval: started.interval,
        expiresAt: started.expiresAt,
        domain: started.domain,
        ...(started.pollDomain ? { pollDomain: started.pollDomain } : {}),
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.feishuRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_SCOPE} 启动飞书扫码注册失败`, message);
      toast(intl.formatMessage({ id: "bots.feishuRegistrationFailed" }, { error: message }));
    } finally {
      setFeishuRegistrationLoading(false);
    }
  }, [botsService, intl.formatMessage, selectedBot]);

  const beginWeixinRegistration = useCallback(async () => {
    if (!botsService || !selectedBot || selectedBot.provider !== "weixin") {
      return;
    }
    setWeixinRegistrationLoading(true);
    try {
      const started = await botsService.beginWeixinRegistration();
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await toDataURL(started.qrUrl, { margin: 1, width: 220 });
      } catch (error) {
        logger.error(
          `${LOG_SCOPE} 生成微信登录二维码失败`,
          error instanceof Error ? error.message : String(error),
        );
      }
      setWeixinRegistration({
        botId: selectedBot.id,
        qrCode: started.qrCode,
        qrUrl: started.qrUrl,
        qrDataUrl,
        interval: started.interval,
        expiresAt: started.expiresAt,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.weixinRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_SCOPE} 启动微信扫码登录失败`, message);
      toast(intl.formatMessage({ id: "bots.weixinRegistrationFailed" }, { error: message }));
    } finally {
      setWeixinRegistrationLoading(false);
    }
  }, [botsService, intl.formatMessage, selectedBot]);

  // 飞书注册 poll（interval 秒，pending 期间持续）。
  useEffect(() => {
    const registration = feishuRegistration;
    if (!open || !botsService || !selectedBot || !isFeishuLikeProvider(selectedBot.provider)) {
      return;
    }
    if (!registration || registration.status !== "pending") {
      return;
    }
    let cancelled = false;
    const intervalMs = Math.max(1, registration.interval) * 1000;
    const poll = async () => {
      try {
        const result = await botsService.pollFeishuRegistration({
          deviceCode: registration.deviceCode,
          domain: registration.domain,
          ...(registration.pollDomain ? { pollDomain: registration.pollDomain } : {}),
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending") {
          setFeishuRegistration((current) =>
            current?.deviceCode !== registration.deviceCode ||
            (current.interval === (result.interval ?? current.interval) &&
              current.domain === (result.domain ?? current.domain) &&
              current.pollDomain === (result.pollDomain ?? current.pollDomain))
              ? current
              : {
                  ...current!,
                  interval: result.interval ?? current!.interval,
                  domain: (result.domain as "feishu" | "lark") ?? current!.domain,
                  pollDomain: result.pollDomain ?? current!.pollDomain,
                },
          );
          return;
        }
        if (result.status === "success") {
          const saved = await saveBot(
            {
              ...selectedBot,
              provider: selectedBot.provider,
              name: result.appName?.trim() || selectedBot.name,
              feishuAppId: result.appId,
            },
            { credentialValue: result.appSecret },
          );
          if (cancelled) {
            return;
          }
          setConfig((current) => ({
            ...current,
            bots: current.bots.map((bot) => (bot.id === saved.id ? saved : bot)),
          }));
          setFeishuRegistration(null);
          toast(intl.formatMessage({ id: "bots.feishuRegistrationSuccess" }));
          return;
        }
        setFeishuRegistration((current) =>
          current?.deviceCode === registration.deviceCode
            ? {
                ...current,
                status: result.status,
                message:
                  ("message" in result ? result.message : undefined) ??
                  intl.formatMessage({ id: `bots.feishuRegistration.${result.status}` }),
              }
            : current,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${LOG_SCOPE} 飞书扫码注册轮询失败`, message);
        if (!cancelled) {
          setFeishuRegistration((current) =>
            current?.deviceCode === registration.deviceCode
              ? { ...current, status: "error", message }
              : current,
          );
        }
      }
    };
    const timer = setInterval(() => void poll(), intervalMs);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [botsService, feishuRegistration, intl.formatMessage, open, saveBot, selectedBot]);

  // 微信注册 poll（pending/scanned 期间持续）。
  useEffect(() => {
    const registration = weixinRegistration;
    if (
      !open ||
      !botsService ||
      !selectedBot ||
      selectedBot.provider !== "weixin" ||
      !registration ||
      (registration.status !== "pending" && registration.status !== "scanned")
    ) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const intervalMs = Math.max(1, registration.interval) * 1000;
    const schedule = () => {
      if (!cancelled) {
        timer = setTimeout(() => void poll(), intervalMs);
      }
    };
    const poll = async () => {
      try {
        const result = await botsService.pollWeixinRegistration({
          qrCode: registration.qrCode,
        });
        if (cancelled) {
          return;
        }
        if (result.status === "pending" || result.status === "scanned") {
          setWeixinRegistration((current) =>
            current?.qrCode !== registration.qrCode ||
            (current.interval === (result.interval ?? current.interval) &&
              current.status === result.status)
              ? current
              : {
                  ...current!,
                  interval: result.interval ?? current!.interval,
                  status: result.status,
                },
          );
          schedule();
          return;
        }
        if (result.status === "success") {
          await saveBot(
            {
              ...selectedBot,
              webhookUrl: undefined,
              providerUserId: result.botId ?? selectedBot.providerUserId,
              displayName: result.botId ?? selectedBot.displayName,
              name: selectedBot.name,
            },
            { credentialValue: result.botToken },
          );
          if (!cancelled) {
            setWeixinRegistration(null);
            toast(intl.formatMessage({ id: "bots.weixinRegistrationSuccess" }));
          }
          cancelled = true;
          return;
        }
        setWeixinRegistration((current) =>
          current?.qrCode === registration.qrCode
            ? {
                ...current,
                status: result.status,
                message:
                  ("message" in result ? result.message : undefined) ??
                  intl.formatMessage({ id: `bots.weixinRegistration.${result.status}` }),
              }
            : current,
        );
        cancelled = true;
      } catch (error) {
        logger.error(
          `${LOG_SCOPE} 微信扫码登录轮询失败`,
          error instanceof Error ? error.message : String(error),
        );
        schedule();
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [botsService, intl.formatMessage, open, saveBot, selectedBot, weixinRegistration]);

  const patchBot = useCallback(
    (patch: Partial<BotConfig>) => {
      if (!selectedBot) {
        return;
      }
      void saveBot({ ...selectedBot, ...patch }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${LOG_SCOPE} 保存 Bot 失败`, message);
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      });
    },
    [intl.formatMessage, saveBot, selectedBot],
  );

  const startRename = useCallback(() => {
    if (!selectedBot) {
      return;
    }
    setRenamingBotId(selectedBot.id);
    setNameDraft({ botId: selectedBot.id, value: selectedBot.name });
  }, [selectedBot]);

  const commitNameDraft = useCallback(() => {
    if (!selectedBot) {
      return;
    }
    const value = selectedBotName.trim();
    setNameDraft(null);
    setRenamingBotId(null);
    if (value !== selectedBot.name) {
      void saveBot({ ...selectedBot, name: value }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${LOG_SCOPE} 保存 Bot 失败`, message);
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      });
    }
  }, [intl.formatMessage, saveBot, selectedBot, selectedBotName]);

  const cancelRename = useCallback(() => {
    setNameDraft(null);
    setRenamingBotId(null);
  }, []);

  // 工作区授权：乐观保存 + 失败回滚旧快照（附录C §1.3 `Se`）。
  const patchAllowedWorkspaces = useCallback(
    async (allowedWorkspaces: string[]) => {
      if (!selectedBot) {
        return;
      }
      setAllowedWorkspacesSaving(true);
      const previous = selectedBot;
      const next: BotConfig = { ...selectedBot, allowedWorkspaces };
      setConfig((current) => ({
        ...current,
        bots: current.bots.map((bot) => (bot.id === next.id ? next : bot)),
      }));
      try {
        await saveBot(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${LOG_SCOPE} 保存工作区访问范围失败`, message);
        setConfig((current) => ({
          ...current,
          bots: current.bots.map((bot) => (bot.id === previous.id ? previous : bot)),
        }));
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setAllowedWorkspacesSaving(false);
      }
    },
    [intl.formatMessage, saveBot, selectedBot],
  );

  const toggleWorkspaceAccess = useCallback(
    async (workspaceId: string, checked: boolean) => {
      if (!selectedBot) {
        return;
      }
      const current = isAllWorkspacesAllowed(selectedBot.allowedWorkspaces)
        ? workspaceRefs.map((ref) => ref.id)
        : selectedBot.allowedWorkspaces;
      await patchAllowedWorkspaces(
        checked
          ? [...new Set([...current, workspaceId])]
          : current.filter((id) => id !== workspaceId),
      );
    },
    [patchAllowedWorkspaces, selectedBot, workspaceRefs],
  );

  const startCreateFlow = useCallback(() => {
    setCreatingNew(true);
    setCreatingProvider(null);
    setSelectedBotId(null);
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  }, []);

  const createBot = useCallback(
    async (provider: string) => {
      if (creatingProvider || !botsService) {
        return;
      }
      setCreatingProvider(provider);
      const draft = createDefaultBot({ provider: provider as BotProvider });
      try {
        await saveBot({
          ...draft,
          name: "",
          ...(provider === "webhook" ? { webhookAuthHeaderName: WEBHOOK_AUTH_HEADER_DEFAULT } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${LOG_SCOPE} 创建 Bot 失败`, message);
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      } finally {
        setCreatingProvider(null);
      }
    },
    [botsService, creatingProvider, intl.formatMessage, saveBot],
  );

  // entryProvider 定位：已有 bot 选中，否则新建并预选渠道（spec web-remote-control §1.4）。
  useEffect(() => {
    if (!open || !entryProvider || !loaded) {
      return;
    }
    if (entryProviderHandledRef.current === entryProvider) {
      return;
    }
    entryProviderHandledRef.current = entryProvider;
    const target = resolveEntryTarget(config.bots, entryProvider);
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);
    if (target.mode === "select") {
      setCreatingNew(false);
      setCreatingProvider(null);
      setSelectedBotId(target.botId);
      return;
    }
    setCreatingNew(true);
    setSelectedBotId(null);
    void createBot(target.provider);
  }, [config.bots, createBot, entryProvider, loaded, open]);

  useEffect(() => {
    entryProviderHandledRef.current = null;
  }, [entryProvider, open]);

  // 自动引导（附录C §1.3）：无凭据自动走注册，有凭据未绑定自动出绑定码。
  useEffect(() => {
    if (!open || creatingNew || !selectedBot || !botsService) {
      return;
    }
    const bot = selectedBot;
    if (isFeishuLikeProvider(bot.provider)) {
      if (!bot.credentialRef) {
        if (feishuRegistrationLoading || feishuRegistration?.botId === bot.id) {
          return;
        }
        const guardKey = `${bot.id}:feishu-registration`;
        if (registrationGuardRef.current.has(guardKey)) {
          return;
        }
        registrationGuardRef.current.add(guardKey);
        void beginFeishuRegistration();
        return;
      }
      if (!bot.providerUserId) {
        if ((bindCode?.botId === bot.id && !bindExpired) || bindCodeGuardRef.current.has(bot.id)) {
          return;
        }
        bindCodeGuardRef.current.add(bot.id);
        void createBindCode(bot).finally(() => bindCodeGuardRef.current.delete(bot.id));
      }
      return;
    }
    if (bot.provider === "telegram") {
      // 无凭据时先显示 BotFather 卡；有凭据未绑定自动出绑定码。
      if (
        !bot.credentialRef ||
        bot.providerUserId ||
        (bindCode?.botId === bot.id && !bindExpired) ||
        bindCodeGuardRef.current.has(bot.id)
      ) {
        return;
      }
      bindCodeGuardRef.current.add(bot.id);
      void createBindCode(bot).finally(() => bindCodeGuardRef.current.delete(bot.id));
      return;
    }
    if (bot.provider !== "weixin") {
      return;
    }
    if (bot.credentialRef || weixinRegistrationLoading || weixinRegistration?.botId === bot.id) {
      return;
    }
    const guardKey = `${bot.id}:weixin-registration`;
    if (registrationGuardRef.current.has(guardKey)) {
      return;
    }
    registrationGuardRef.current.add(guardKey);
    void beginWeixinRegistration();
  }, [
    beginFeishuRegistration,
    beginWeixinRegistration,
    bindCode,
    bindCodeGuardRef,
    bindExpired,
    botsService,
    createBindCode,
    creatingNew,
    feishuRegistration,
    feishuRegistrationLoading,
    open,
    selectedBot,
    weixinRegistration,
    weixinRegistrationLoading,
  ]);

  const handleCopyBindCommand = useCallback(async () => {
    if (!bindCode || bindExpired) {
      return;
    }
    await navigator.clipboard?.writeText(`/bind ${bindCode.code}`).catch((error: unknown) => {
      logger.warn(
        `${LOG_SCOPE} 复制绑定命令失败`,
        error instanceof Error ? error.message : String(error),
      );
    });
    toast(intl.formatMessage({ id: "bots.bindCommandCopied" }));
  }, [bindCode, bindExpired, intl.formatMessage]);

  const handleOpenTelegramBotFather = useCallback(() => {
    platform.openExternal(TELEGRAM_BOT_FATHER_URL);
  }, [platform]);

  const handleSaveSecret = useCallback(() => {
    if (!selectedBot || secretSaving) {
      return;
    }
    setSecretSaving(true);
    void saveBot(selectedBot, { credentialValue })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${LOG_SCOPE} 保存 Bot secret 失败`, message);
        toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
      })
      .finally(() => setSecretSaving(false));
  }, [credentialValue, intl.formatMessage, saveBot, secretSaving, selectedBot]);

  const handleSaveWebhookCredentials = useCallback(
    (params: { webhookUrl: string; webhookAuthHeaderName: string; webhookSecretValue: string }) => {
      if (!selectedBot || secretSaving) {
        return;
      }
      setSecretSaving(true);
      void saveBot(
        {
          ...selectedBot,
          webhookUrl: params.webhookUrl
            ? (params.webhookUrl as BotConfig["webhookUrl"])
            : undefined,
          webhookAuthHeaderName: params.webhookAuthHeaderName,
        },
        { webhookSecretValue: params.webhookSecretValue },
      )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`${LOG_SCOPE} 保存 Webhook 凭据失败`, message);
          toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
        })
        .finally(() => setSecretSaving(false));
    },
    [intl.formatMessage, saveBot, secretSaving, selectedBot],
  );

  const handleUnbind = useCallback(async () => {
    if (!selectedBot || !botsService) {
      return;
    }
    await saveBot({ ...selectedBot, providerUserId: undefined, displayName: undefined });
    await botsService.resetBotState(selectedBot.id);
  }, [botsService, saveBot, selectedBot]);

  const handleRemoveSecret = useCallback(async () => {
    if (!selectedBot || !botsService) {
      return;
    }
    try {
      const next = await botsService.removeBotSecret(selectedBot.id);
      registrationGuardRef.current.delete(`${selectedBot.id}:feishu-registration`);
      registrationGuardRef.current.delete(`${selectedBot.id}:weixin-registration`);
      bindCodeGuardRef.current.delete(selectedBot.id);
      setConfig((current) => ({
        ...current,
        bots: current.bots.map((bot) => (bot.id === next.id ? next : bot)),
      }));
      setCredentialValue("");
      setBindCode(null);
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_SCOPE} 移除 Bot secret 失败`, message);
      toast(intl.formatMessage({ id: "bots.removeSecretFailed" }, { error: message }));
    }
  }, [botsService, intl.formatMessage, reload, selectedBot]);

  const handleDelete = useCallback(async () => {
    if (!selectedBot || !botsService) {
      return;
    }
    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "bots.deleteConfirmTitle" },
        { name: resolveBotDisplayName(selectedBot.name, fallbackName) },
      ),
      description: intl.formatMessage({ id: "bots.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "bots.delete" }),
    });
    if (!confirmed) {
      return;
    }
    try {
      await botsService.deleteBot(selectedBot.id);
      setSelectedBotId(null);
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${LOG_SCOPE} 删除 Bot 失败`, message);
      toast(intl.formatMessage({ id: "bots.deleteFailed" }, { error: message }));
    }
  }, [botsService, confirmDialog, fallbackName, intl.formatMessage, reload, selectedBot]);

  const handleEscapeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (renamingBotId !== null) {
        event.preventDefault();
        setNameDraft(null);
        setRenamingBotId(null);
      }
    },
    [renamingBotId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-6rem)] max-h-168 max-w-4xl flex-col overflow-hidden rounded-2xl"
        onEscapeKeyDown={handleEscapeKeyDown}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Bot className="size-5 text-foreground" />
            <DialogTitle className="text-ui-lg font-medium text-foreground">
              {intl.formatMessage({ id: "bots.title" })}
            </DialogTitle>
            <DialogDescription className="ml-3">
              {intl.formatMessage({ id: "bots.description" })}
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-3">
          <aside className="flex w-64 shrink-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={startCreateFlow}
                className="mb-3 w-full justify-start gap-2 rounded-xl"
              >
                <Plus className="size-4" />
                <span className="min-w-0 truncate">
                  {intl.formatMessage({ id: "bots.addBot" })}
                </span>
              </Button>
              {config.bots.length === 0 ? (
                <div className="p-4 text-ui-base text-foreground-subtle">
                  {creatingNew
                    ? intl.formatMessage({ id: "bots.newBot.selectProviderHint" })
                    : intl.formatMessage({ id: "bots.empty" })}
                </div>
              ) : (
                config.bots.map((bot) => {
                  const runtime = status?.botRuntime.find((item) => item.botId === bot.id);
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => {
                        setCreatingNew(false);
                        setCreatingProvider(null);
                        setSelectedBotId(bot.id);
                      }}
                      className={cn(
                        "mb-1 w-full rounded-xl px-2.5 py-3 pr-4 text-left transition-colors",
                        bot.id === selectedBotId
                          ? "bg-surface-hover text-foreground"
                          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <BotChannelIcon
                          provider={bot.provider}
                          className="size-10 shrink-0 object-contain text-foreground-subtle"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-ui-base font-medium text-foreground">
                            {resolveBotDisplayName(bot.name, fallbackName)}
                          </span>
                          <span className="mt-0.5 flex min-w-0 text-ui-base text-foreground-subtle">
                            <BotChannelLabel provider={bot.provider} />
                          </span>
                        </span>
                        <span
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            resolveBotStatusDotClassName(runtime, bot.enabled),
                          )}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>
          <section className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background p-4">
            {creatingNew ? (
              <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-start gap-6">
                <div className="space-y-2">
                  <div className="text-ui-lg font-medium">
                    {intl.formatMessage({ id: "bots.newBot.title" })}
                  </div>
                  <p className="max-w-2xl text-ui-base leading-6 text-foreground-subtle">
                    {intl.formatMessage({ id: "bots.newBot.description" })}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {BOT_CHANNEL_CATALOG.map((channel) => {
                    const busy = creatingProvider === channel.id;
                    const disabled = !channel.implemented || creatingProvider !== null;
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        disabled={disabled}
                        aria-busy={busy}
                        onClick={() =>
                          channel.implemented ? void createBot(channel.id) : undefined
                        }
                        className={cn(
                          "flex items-start gap-3 rounded-lg border border-card-border bg-card px-3 py-4 text-left transition-colors",
                          !disabled
                            ? "hover:border-input-border-focused hover:bg-surface-hover"
                            : "cursor-not-allowed opacity-60",
                          busy && "border-input-border-focused bg-surface-hover opacity-100",
                        )}
                      >
                        {busy ? (
                          <div className="flex size-10 items-center justify-center">
                            <LoaderCircle className="size-6 shrink-0 animate-spin text-foreground-subtle" />
                          </div>
                        ) : (
                          <BotChannelIcon
                            provider={channel.id}
                            className="size-10 shrink-0 text-foreground"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 text-ui-lg font-medium">
                            <BotChannelLabel provider={channel.id} />
                          </span>
                          <span className="mt-1 block text-ui-base text-foreground-subtle">
                            {channel.implemented
                              ? intl.formatMessage({
                                  id: `bots.newBot.providerDescription.${channel.id}`,
                                })
                              : intl.formatMessage({ id: "bots.newBot.comingSoon" })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : selectedBot ? (
              <div className="space-y-4">
                <BotHeader
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  renaming={renamingBotId === selectedBot.id}
                  nameDraft={selectedBotName}
                  onStartRename={startRename}
                  onNameDraftChange={(value) => setNameDraft({ botId: selectedBot.id, value })}
                  onCommitNameDraft={commitNameDraft}
                  onCancelRename={cancelRename}
                  onPatchBot={patchBot}
                />
                <BotCredentialPanel
                  bot={selectedBot}
                  runtime={selectedRuntime}
                  credentialValue={credentialValue}
                  secretSaving={secretSaving}
                  bindCode={bindCode}
                  bindExpired={bindExpired}
                  bindRemainingMs={bindRemainingMs}
                  bindCountdownProgress={bindCountdownProgress}
                  feishuRegistration={feishuRegistration}
                  feishuRegistrationLoading={feishuRegistrationLoading}
                  weixinRegistration={weixinRegistration}
                  weixinRegistrationLoading={weixinRegistrationLoading}
                  weixinActivated={Boolean(selectedBotState?.weixinActivatedAt)}
                  onCredentialValueChange={setCredentialValue}
                  onSaveSecret={handleSaveSecret}
                  onSaveWebhookCredentials={handleSaveWebhookCredentials}
                  onRemoveSecret={() => void handleRemoveSecret()}
                  onOpenTelegramBotFather={handleOpenTelegramBotFather}
                  onStartWeixinRegistration={() => void beginWeixinRegistration()}
                  onStartFeishuRegistration={() => void beginFeishuRegistration()}
                  onCreateBindCode={() => void createBindCode(selectedBot)}
                  onCopyBindCommand={() => void handleCopyBindCommand()}
                  onUnbind={() => void handleUnbind()}
                />
                <BotPanelGroup>
                  <BotReplyGranularityPanel bot={selectedBot} onPatchBot={patchBot} />
                  <BotAllowedWorkspacesPanel
                    bot={selectedBot}
                    workspaceRefs={workspaceRefs}
                    currentWorkspace={currentWorkspace}
                    loading={allowedWorkspacesSaving}
                    onPatchAllowedWorkspaces={(next) => void patchAllowedWorkspaces(next)}
                    onToggleWorkspaceAccess={(id, checked) =>
                      void toggleWorkspaceAccess(id, checked)
                    }
                  />
                </BotPanelGroup>
                <BotDeleteRow onDelete={() => void handleDelete()} />
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
                <Bot className="size-8" />
                <div>{intl.formatMessage({ id: "bots.empty" })}</div>
                <Button variant="outline" size="lg" onClick={startCreateFlow}>
                  <Plus className="size-4" />
                  {intl.formatMessage({ id: "bots.addBot" })}
                </Button>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
