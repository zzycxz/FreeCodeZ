/* eslint-disable max-lines -- 凭据面板同时承载四渠道分支矩阵、扫码注册卡与错误卡，拆文件会让一次保存/解绑的状态分支分居多处。 */
/**
 * 关联机器人凭据面板（附录C §1.3 `ein` 分支矩阵）。
 *
 * 记 C=有凭据、w=feishu|lark、T=weixin、E=T?C:有 providerUserId、D=运行态 error：
 * ① E 已绑定 → 连通状态 + 解绑；② telegram 且 !C → BotFather 卡；
 * ③ (w|T) 且 !C → 扫码注册；④ 其它 → 绑定码 + 移除密钥。
 * webhook 渠道官方渲染 null，FreeCodeZ 补齐出站 URL / 认证头 / 回调密钥卡（决策 R11）。
 */
import { useState, type ReactNode } from "react";
import { CircleAlert, ExternalLink, KeyRound, LoaderCircle, QrCode, Unlink } from "lucide-react";
import type { BotConfig } from "@zcode/shared/bots";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { BotPanelCard, BotPanelGroup, BotPanelRow } from "@/bots/BotHeader.js";
import { BotBindCodeCard, type BotBindCodeState } from "@/bots/BotBindCodeCard.js";
import { TelegramBotFatherCard } from "@/bots/TelegramBotFatherCard.js";
import { isFeishuLikeProvider, type BotRuntimeView } from "@/bots/botsApi.js";

export interface FeishuRegistrationView {
  botId: string;
  deviceCode: string;
  qrUrl: string;
  qrDataUrl: string | null;
  userCode?: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: string;
  status: "pending" | "success" | "access_denied" | "expired" | "error";
  message?: string;
}

export interface WeixinRegistrationView {
  botId: string;
  qrCode: string;
  qrUrl: string;
  qrDataUrl: string | null;
  interval: number;
  expiresAt: number;
  status: "pending" | "scanned" | "success" | "expired" | "error";
  message?: string;
}

function FeishuRegistrationCard({ registration }: { registration: FeishuRegistrationView }) {
  const { intl } = useZCodeIntl();
  return (
    <BotPanelCard>
      <div className="flex flex-wrap items-start justify-center gap-4">
        {registration.qrDataUrl ? (
          <img
            src={registration.qrDataUrl}
            alt={intl.formatMessage({ id: "bots.feishuRegistrationQrAlt" })}
            className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
          />
        ) : null}
        <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
          <div>
            {intl.formatMessage({ id: `bots.feishuRegistrationScanHint.${registration.domain}` })}
          </div>
          {registration.userCode ? (
            <div className="rounded-md bg-surface px-2 py-1 font-mono text-foreground">
              {registration.userCode}
            </div>
          ) : null}
          <div>
            {registration.status === "pending" ? (
              <span className="inline-flex items-center gap-1">
                <LoaderCircle className="size-3 animate-spin" />
                {intl.formatMessage({ id: "common.loading" })}
              </span>
            ) : (
              (registration.message ??
              intl.formatMessage({ id: `bots.feishuRegistration.${registration.status}` }))
            )}
          </div>
        </div>
      </div>
    </BotPanelCard>
  );
}

function WeixinRegistrationCard({ registration }: { registration: WeixinRegistrationView }) {
  const { intl } = useZCodeIntl();
  return (
    <BotPanelCard>
      <div className="flex flex-wrap items-start justify-center gap-4">
        {registration.qrDataUrl ? (
          <img
            src={registration.qrDataUrl}
            alt={intl.formatMessage({ id: "bots.weixinRegistrationQrAlt" })}
            className="size-40 shrink-0 rounded-lg border border-border bg-surface p-2"
          />
        ) : null}
        <div className="min-w-52 flex-1 space-y-3 text-ui-base text-foreground-subtle">
          <div>{intl.formatMessage({ id: "bots.weixinRegistrationScanHint" })}</div>
          <div>
            {registration.status === "pending" || registration.status === "scanned" ? (
              <span className="inline-flex items-center gap-1">
                <LoaderCircle className="size-3 animate-spin" />
                {intl.formatMessage({ id: `bots.weixinRegistration.${registration.status}` })}
              </span>
            ) : (
              (registration.message ??
              intl.formatMessage({ id: `bots.weixinRegistration.${registration.status}` }))
            )}
          </div>
        </div>
      </div>
    </BotPanelCard>
  );
}

/**
 * Webhook 凭据卡（FreeCodeZ 决策 R11）：官方此处渲染 null（有后端无 UI），
 * 这里补齐出站 URL / 认证 Header 名 / 回调密钥三项。
 */
function WebhookCredentialCard({
  bot,
  saving,
  onSaveWebhookCredentials,
}: {
  bot: BotConfig;
  saving: boolean;
  onSaveWebhookCredentials: (params: {
    webhookUrl: string;
    webhookAuthHeaderName: string;
    webhookSecretValue: string;
  }) => void;
}) {
  const { intl } = useZCodeIntl();
  const [outboundUrl, setOutboundUrl] = useState(bot.webhookUrl ?? "");
  const [authHeaderName, setAuthHeaderName] = useState(
    bot.webhookAuthHeaderName ?? "x-zcode-bot-secret",
  );
  const [callbackSecret, setCallbackSecret] = useState("");

  return (
    <BotPanelCard>
      <div className="space-y-3 text-ui-base">
        <div className="space-y-1">
          <div className="font-medium text-foreground">
            {intl.formatMessage({ id: "bots.webhookOutboundUrl" })}
          </div>
          <Input
            size="lg"
            value={outboundUrl}
            onChange={(event) => setOutboundUrl(event.target.value)}
            placeholder={intl.formatMessage({ id: "bots.webhookUrlPlaceholder" })}
            disabled={saving}
          />
        </div>
        <div className="space-y-1">
          <div className="font-medium text-foreground">
            {intl.formatMessage({ id: "bots.webhookAuthHeaderName" })}
          </div>
          <Input
            size="lg"
            value={authHeaderName}
            onChange={(event) => setAuthHeaderName(event.target.value)}
            placeholder="x-zcode-bot-secret"
            disabled={saving}
          />
        </div>
        <div className="space-y-1">
          <div className="font-medium text-foreground">
            {intl.formatMessage({ id: "bots.callbackSecret" })}
          </div>
          <Input
            size="lg"
            type="password"
            value={callbackSecret}
            onChange={(event) => setCallbackSecret(event.target.value)}
            placeholder={intl.formatMessage({ id: "bots.callbackSecretPlaceholder" })}
            disabled={saving}
          />
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="lg"
            onClick={() =>
              onSaveWebhookCredentials({
                webhookUrl: outboundUrl.trim(),
                webhookAuthHeaderName: authHeaderName.trim() || "x-zcode-bot-secret",
                webhookSecretValue: callbackSecret,
              })
            }
            disabled={saving || !callbackSecret.trim()}
          >
            {saving ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <KeyRound className="size-4" />
            )}
            {intl.formatMessage({ id: "bots.saveSecrets" })}
          </Button>
        </div>
      </div>
    </BotPanelCard>
  );
}

/** 飞书/Lark 连接错误卡：错误码 + 错误详情 + 恢复建议（附录C §1.3 错误卡）。 */
function ConnectionErrorCard({
  bot,
  bound,
  runtime,
  formatMessage,
}: {
  bot: BotConfig;
  bound: boolean;
  runtime: BotRuntimeView;
  formatMessage: IntlInstance["formatMessage"];
}) {
  const errorCode = runtime.message?.match(/\b\d{7,}\b/)?.[0];
  const isLark = bot.provider === "lark";
  const titleId = bound
    ? isLark
      ? "bots.runtime.larkConnectionInterrupted"
      : "bots.runtime.feishuConnectionInterrupted"
    : isLark
      ? "bots.runtime.cannotConnectLark"
      : "bots.runtime.cannotConnectFeishu";
  const suggestionId = bound
    ? isLark
      ? "bots.runtime.larkConnectionRecoverySuggestion"
      : "bots.runtime.feishuConnectionRecoverySuggestion"
    : "bots.runtime.connectionBlocksBinding";
  return (
    <BotPanelCard>
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">
            {formatMessage({ id: titleId })}
          </div>
          <div className="mt-1 text-ui-base leading-5 text-foreground-subtle">
            {formatMessage({ id: suggestionId })}
          </div>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-base leading-5">
            {errorCode ? (
              <>
                <dt className="text-foreground-subtle">
                  {formatMessage({ id: "bots.runtime.errorCode" })}
                </dt>
                <dd className="min-w-0 break-all font-mono text-foreground">{errorCode}</dd>
              </>
            ) : null}
            <dt className="text-foreground-subtle">
              {formatMessage({ id: "bots.runtime.errorDetail" })}
            </dt>
            <dd className="min-w-0 break-words text-foreground">
              {runtime.message ?? formatMessage({ id: "bots.runtime.unknownError" })}
            </dd>
          </dl>
        </div>
      </div>
    </BotPanelCard>
  );
}

export function BotCredentialPanel({
  bot,
  runtime,
  credentialValue,
  secretSaving,
  bindCode,
  bindExpired,
  bindRemainingMs,
  bindCountdownProgress,
  feishuRegistration,
  feishuRegistrationLoading,
  weixinRegistration,
  weixinRegistrationLoading,
  weixinActivated,
  onCredentialValueChange,
  onSaveSecret,
  onSaveWebhookCredentials,
  onRemoveSecret,
  onOpenTelegramBotFather,
  onStartWeixinRegistration,
  onStartFeishuRegistration,
  onCreateBindCode,
  onCopyBindCommand,
  onUnbind,
}: {
  bot: BotConfig;
  runtime: BotRuntimeView | undefined;
  credentialValue: string;
  secretSaving: boolean;
  bindCode: BotBindCodeState | null;
  bindExpired: boolean;
  bindRemainingMs: number;
  bindCountdownProgress: number;
  feishuRegistration: FeishuRegistrationView | null;
  feishuRegistrationLoading: boolean;
  weixinRegistration: WeixinRegistrationView | null;
  weixinRegistrationLoading: boolean;
  weixinActivated: boolean;
  onCredentialValueChange: (value: string) => void;
  onSaveSecret: () => void;
  onSaveWebhookCredentials: (params: {
    webhookUrl: string;
    webhookAuthHeaderName: string;
    webhookSecretValue: string;
  }) => void;
  onRemoveSecret: () => void;
  onOpenTelegramBotFather: () => void;
  onStartWeixinRegistration: () => void;
  onStartFeishuRegistration: () => void;
  onCreateBindCode: () => void;
  onCopyBindCommand: () => void;
  onUnbind: () => void;
}) {
  const { intl } = useZCodeIntl();
  // 官方 webhook 渲染 null（R11 缺口）；FreeCodeZ 补出站 URL / 认证头 / 回调密钥卡。
  if (bot.provider === "webhook") {
    const hasSecret = Boolean(bot.webhookSecretRef || bot.credentialRef);
    const hasError = runtime?.status === "error";
    return (
      <BotPanelGroup>
        <BotPanelRow
          label={intl.formatMessage({ id: "bots.botToken" })}
          description={intl.formatMessage({ id: "bots.botTokenDescription.webhook" })}
          control={
            <div className="flex items-center justify-end gap-3">
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-ui-base text-foreground-subtle">
                <span
                  className={`size-2 rounded-full ${hasError ? "bg-destructive" : hasSecret ? "bg-success" : "bg-border"}`}
                />
                {intl.formatMessage({
                  id: hasError
                    ? "bots.runtime.boundConnectionInterrupted"
                    : hasSecret
                      ? "bots.connected"
                      : "bots.notConnected",
                })}
              </span>
              {hasSecret ? (
                <Button variant="outline" size="lg" onClick={onRemoveSecret}>
                  <Unlink className="size-4" />
                  {intl.formatMessage({ id: "bots.removeSecret" })}
                </Button>
              ) : null}
            </div>
          }
          detail={
            <>
              {bot.enabled && runtime?.deliveryError ? (
                <BotPanelCard>
                  <div role="alert" className="min-w-0 space-y-2 text-ui-base">
                    <div className="font-medium text-destructive">
                      {intl.formatMessage({ id: "bots.runtime.deliveryFailed" })}
                    </div>
                    <div className="text-foreground-subtle">
                      {intl.formatMessage({ id: "bots.runtime.deliveryFailedDescription" })}
                    </div>
                    <div className="whitespace-pre-wrap break-all text-foreground-subtle">
                      {runtime.deliveryError}
                    </div>
                  </div>
                </BotPanelCard>
              ) : null}
              <WebhookCredentialCard
                key={bot.id}
                bot={bot}
                saving={secretSaving}
                onSaveWebhookCredentials={onSaveWebhookCredentials}
              />
            </>
          }
        />
      </BotPanelGroup>
    );
  }

  const hasCredential = Boolean(bot.credentialRef);
  const feishuLike = isFeishuLikeProvider(bot.provider);
  const isWeixin = bot.provider === "weixin";
  // 微信的 bot_token 即身份，其它渠道以 providerUserId 判定绑定。
  const bound = isWeixin ? hasCredential : Boolean(bot.providerUserId);
  const hasError = runtime?.status === "error";
  const showFeishuRegistration = feishuRegistration?.botId === bot.id;
  const showWeixinRegistration = weixinRegistration?.botId === bot.id;
  const showBindCode = bindCode?.botId === bot.id;

  const description =
    feishuLike && hasError
      ? intl.formatMessage({
          id: bound
            ? "bots.runtime.boundConnectionInterruptedDescription"
            : "bots.runtime.credentialsSavedConnectionFailedDescription",
        })
      : intl.formatMessage({ id: `bots.botTokenDescription.${bot.provider}` });

  let control: ReactNode;
  let detailNode: ReactNode = null;

  if (bound) {
    control = (
      <div className="flex items-center justify-end gap-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-ui-base text-foreground-subtle">
          <span className={`size-2 rounded-full ${hasError ? "bg-destructive" : "bg-success"}`} />
          {intl.formatMessage({
            id: hasError ? "bots.runtime.boundConnectionInterrupted" : "bots.connected",
          })}
        </span>
        <Button variant="outline" size="lg" onClick={isWeixin ? onRemoveSecret : onUnbind}>
          <Unlink className="size-4" />
          {intl.formatMessage({ id: "bots.unbind" })}
        </Button>
      </div>
    );
    if (isWeixin && !weixinActivated) {
      detailNode = (
        <BotPanelCard>
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "bots.weixinActivationHint" })}
          </div>
        </BotPanelCard>
      );
    }
  } else if (bot.provider === "telegram" && !hasCredential) {
    control = (
      <Button variant="outline" size="lg" onClick={onOpenTelegramBotFather}>
        <ExternalLink className="size-4" />
        {intl.formatMessage({ id: "bots.openBotFather" })}
      </Button>
    );
    detailNode = (
      <TelegramBotFatherCard
        credentialValue={credentialValue}
        secretSaving={secretSaving}
        onCredentialValueChange={onCredentialValueChange}
        onSaveSecret={onSaveSecret}
      />
    );
  } else if ((feishuLike || isWeixin) && !hasCredential) {
    const registering = isWeixin ? weixinRegistrationLoading : feishuRegistrationLoading;
    control = (
      <Button
        variant="outline"
        size="lg"
        onClick={isWeixin ? onStartWeixinRegistration : onStartFeishuRegistration}
        disabled={registering}
      >
        {registering ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <QrCode className="size-4" />
        )}
        {intl.formatMessage({ id: "bots.scanQrCode" })}
      </Button>
    );
  } else {
    control = (
      <div className="flex w-full flex-wrap justify-end gap-2">
        {!showBindCode && !hasError ? (
          <Button variant="outline" size="lg" onClick={onCreateBindCode}>
            {intl.formatMessage({ id: "bots.bind" })}
          </Button>
        ) : null}
        <Button variant="outline" size="lg" onClick={onRemoveSecret}>
          <KeyRound className="size-4" />
          {intl.formatMessage({ id: "bots.removeSecret" })}
        </Button>
      </div>
    );
  }

  if (feishuLike && hasError && runtime) {
    detailNode = (
      <ConnectionErrorCard
        bot={bot}
        bound={bound}
        runtime={runtime}
        formatMessage={intl.formatMessage}
      />
    );
  } else if (showBindCode && bindCode) {
    detailNode = (
      <BotBindCodeCard
        bindCommand={`/bind ${bindCode.code}`}
        bindExpired={bindExpired}
        bindRemainingMs={bindRemainingMs}
        bindCountdownProgress={bindCountdownProgress}
        onCreateBindCode={onCreateBindCode}
        onCopyBindCommand={onCopyBindCommand}
      />
    );
  } else if (showFeishuRegistration && feishuRegistration) {
    detailNode = <FeishuRegistrationCard registration={feishuRegistration} />;
  } else if (showWeixinRegistration && weixinRegistration) {
    detailNode = <WeixinRegistrationCard registration={weixinRegistration} />;
  }

  const deliveryErrorNode =
    bot.enabled && runtime?.deliveryError ? (
      <BotPanelCard>
        <div role="alert" className="min-w-0 space-y-2 text-ui-base">
          <div className="font-medium text-destructive">
            {intl.formatMessage({ id: "bots.runtime.deliveryFailed" })}
          </div>
          <div className="text-foreground-subtle">
            {intl.formatMessage({ id: "bots.runtime.deliveryFailedDescription" })}
          </div>
          <div className="whitespace-pre-wrap break-all text-foreground-subtle">
            {runtime.deliveryError}
          </div>
        </div>
      </BotPanelCard>
    ) : null;

  return (
    <BotPanelGroup>
      <BotPanelRow
        label={intl.formatMessage({ id: "bots.botToken" })}
        description={description}
        control={control}
        detail={
          deliveryErrorNode ? (
            <>
              {deliveryErrorNode}
              {detailNode}
            </>
          ) : (
            detailNode
          )
        }
      />
    </BotPanelGroup>
  );
}
