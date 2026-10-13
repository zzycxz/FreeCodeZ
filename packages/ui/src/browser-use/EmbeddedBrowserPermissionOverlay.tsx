import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EMBEDDED_BROWSER_ASKABLE_PERMISSIONS,
  type EmbeddedBrowserPermissionPrompt,
} from "@zcode/shared";
import { ShieldAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  useEmbeddedBrowserPermissionPrompts,
  type EmbeddedBrowserPromptWithDeadline,
} from "@/hooks/useEmbeddedBrowserPermissionPrompts.js";

type FormatMessage = (descriptor: { id: string }, values?: Record<string, number | string>) => string;

const PERMISSION_LABEL_KEYS: Record<string, string> = {
  media: "browser.permission.kind.media",
  "clipboard-read": "browser.permission.kind.clipboardRead",
  geolocation: "browser.permission.kind.geolocation",
  notifications: "browser.permission.kind.notifications",
  midi: "browser.permission.kind.midi",
  midiSysex: "browser.permission.kind.midiSysex",
  "idle-detection": "browser.permission.kind.idleDetection",
  "speaker-selection": "browser.permission.kind.speakerSelection",
  "window-management": "browser.permission.kind.windowManagement",
  "storage-access": "browser.permission.kind.storageAccess",
  "top-level-storage-access": "browser.permission.kind.topLevelStorageAccess",
  keyboardLock: "browser.permission.kind.keyboardLock",
  fileSystem: "browser.permission.kind.fileSystem",
  usb: "browser.permission.kind.usb",
  hid: "browser.permission.kind.hid",
  serial: "browser.permission.kind.serial",
  display: "browser.permission.kind.display",
};

function permissionLabel(
  formatMessage: FormatMessage,
  permission: string,
): string {
  const key = PERMISSION_LABEL_KEYS[permission] ?? "browser.permission.kind.unknown";
  return formatMessage({ id: key });
}

function promptTitleKey(prompt: EmbeddedBrowserPermissionPrompt): string {
  if (prompt.kind === "device") return "browser.permission.deviceTitle";
  if (prompt.kind === "screen-share") return "browser.permission.shareTitle";
  return "browser.permission.promptTitle";
}

function PromptCard({
  entry,
  formatMessage,
  onResolve,
}: {
  entry: EmbeddedBrowserPromptWithDeadline;
  formatMessage: FormatMessage;
  onResolve: (
    requestId: string,
    action: "allow-always" | "allow-session" | "block-always" | "dismiss",
    selectedDeviceId?: string,
  ) => void;
}): React.JSX.Element {
  const { prompt } = entry;
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(
    prompt.options?.[0]?.deviceId,
  );
  const needsSelection = prompt.kind === "device" || prompt.kind === "screen-share";
  return (
    <div
      data-testid="embedded-browser-permission-card"
      className="pointer-events-auto w-72 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur"
    >
      <p className="text-sm font-medium">
        {formatMessage({ id: promptTitleKey(prompt) }, { origin: prompt.origin })}
      </p>
      {prompt.kind === "permission" ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {permissionLabel(formatMessage, prompt.permission)}
        </p>
      ) : null}
      {needsSelection && prompt.options && prompt.options.length > 0 ? (
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {prompt.options.map((option) => (
            <li key={option.deviceId}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted">
                <input
                  type="radio"
                  name={`permission-device-${prompt.requestId}`}
                  checked={selectedDeviceId === option.deviceId}
                  onChange={() => setSelectedDeviceId(option.deviceId)}
                />
                <span className="truncate">{option.name}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {prompt.kind === "permission" ? (
          <>
            <Button size="xs" variant="outline" onClick={() => onResolve(prompt.requestId, "dismiss")}>
              {formatMessage({ id: "browser.permission.dismiss" })}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => onResolve(prompt.requestId, "allow-session")}
            >
              {formatMessage({ id: "browser.permission.allowOnce" })}
            </Button>
            <Button
              size="xs"
              onClick={() => onResolve(prompt.requestId, "allow-always")}
            >
              {formatMessage({ id: "browser.permission.allowAlways" })}
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => onResolve(prompt.requestId, "block-always")}
            >
              {formatMessage({ id: "browser.permission.block" })}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="xs"
              disabled={needsSelection && !selectedDeviceId}
              onClick={() => onResolve(prompt.requestId, "allow-session", selectedDeviceId)}
            >
              {formatMessage({
                id: prompt.kind === "device" ? "browser.permission.allowOnce" : "browser.permission.shareAllow",
              })}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => onResolve(prompt.requestId, "dismiss")}
            >
              {formatMessage({ id: "browser.permission.dismiss" })}
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => onResolve(prompt.requestId, "block-always")}
            >
              {formatMessage({ id: "browser.permission.block" })}
            </Button>
          </>
        )}
      </div>
      <p className="mt-1.5 text-[10px] text-muted-foreground">
        {formatMessage({ id: "browser.permission.timeoutHint" })}
      </p>
    </div>
  );
}

type SitePermissionValue = "allow" | "deny";

/**
 * U2-4（移植自 ZCode 3.15.1）：内置浏览器权限询问卡 + 站点权限管理面板。
 * 询问卡按 guestWebContentsId 归到当前视口（上游 renderer 同款过滤）；
 * 管理面板以当前站点 origin 为标题，13 项可询问权限三态（询问=删条目）。
 */
export function EmbeddedBrowserPermissionOverlay({
  guestWebContentsId,
  currentOrigin,
  formatMessage,
}: {
  guestWebContentsId: number | undefined;
  currentOrigin: string | undefined;
  formatMessage: FormatMessage;
}): React.JSX.Element {
  const platform = usePlatform();
  const { prompts, resolve } = useEmbeddedBrowserPermissionPrompts(guestWebContentsId);
  const [panelOpen, setPanelOpen] = useState(false);
  const [entries, setEntries] = useState<Record<string, Record<string, SitePermissionValue>>>({});

  const refresh = useCallback(() => {
    if (!panelOpen) return;
    void platform
      .getEmbeddedBrowserSitePermissions?.()
      .then((next) => setEntries(next ?? {}))
      .catch(() => {});
  }, [panelOpen, platform]);

  useEffect(refresh, [refresh]);

  const originEntries = useMemo(
    () => (currentOrigin ? (entries[currentOrigin] ?? {}) : {}),
    [entries, currentOrigin],
  );

  const write = useCallback(
    (permission: string, value: SitePermissionValue | null) => {
      if (!currentOrigin) return;
      if (value === null) {
        void platform
          .resetEmbeddedBrowserSitePermission?.({ origin: currentOrigin, permission })
          ?.catch(() => {});
      } else {
        void platform
          .setEmbeddedBrowserSitePermission?.({ origin: currentOrigin, permission, value })
          ?.catch(() => {});
      }
      setEntries((current) => {
        if (!currentOrigin) return current;
        const perOrigin = { ...current[currentOrigin] };
        if (value === null) delete perOrigin[permission];
        else perOrigin[permission] = value;
        return { ...current, [currentOrigin]: perOrigin };
      });
    },
    [currentOrigin, platform],
  );

  return (
    <>
      {prompts.length > 0 ? (
        <div className="pointer-events-none absolute left-3 top-3 z-20 flex flex-col gap-2">
          {prompts.map((entry) => (
            <PromptCard
              key={entry.prompt.requestId}
              entry={entry}
              formatMessage={formatMessage}
              onResolve={resolve}
            />
          ))}
        </div>
      ) : null}
      <div className="absolute right-3 top-3 z-20">
        <Button
          size="icon"
          variant="outline"
          className="size-7"
          aria-label={formatMessage({ id: "browser.sitePermissions.title" })}
          title={formatMessage({ id: "browser.sitePermissions.title" })}
          onClick={() => setPanelOpen((open) => !open)}
        >
          <ShieldAlertIcon className="size-4" />
        </Button>
      </div>
      {panelOpen ? (
        <div
          data-testid="browser-site-permissions"
          className="absolute right-3 top-12 z-20 w-80 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur"
        >
          <p className="text-sm font-medium">{formatMessage({ id: "browser.sitePermissions.title" })}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {currentOrigin ?? formatMessage({ id: "browser.sitePermissions.noOrigin" })}
          </p>
          <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {EMBEDDED_BROWSER_ASKABLE_PERMISSIONS.map((permission) => {
              const value = originEntries[permission];
              return (
                <li key={permission} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="truncate text-xs">
                    {formatMessage({ id: PERMISSION_LABEL_KEYS[permission] ?? "browser.permission.kind.unknown" })}
                  </span>
                  <select
                    className="h-6 rounded border bg-transparent px-1 text-xs"
                    value={value ?? "ask"}
                    onChange={(event) => {
                      const next = event.target.value;
                      write(permission, next === "ask" ? null : (next as SitePermissionValue));
                    }}
                  >
                    <option value="ask">{formatMessage({ id: "browser.sitePermissions.ask" })}</option>
                    <option value="allow">{formatMessage({ id: "browser.sitePermissions.allow" })}</option>
                    <option value="deny">{formatMessage({ id: "browser.sitePermissions.deny" })}</option>
                  </select>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={!currentOrigin}
              onClick={() => {
                if (!currentOrigin) return;
                void platform
                  .setEmbeddedBrowserSitePermission?.({
                    origin: currentOrigin,
                    permission: "__all__",
                    value: null,
                  })
                  ?.catch(() => {});
                setEntries((current) => ({ ...current, [currentOrigin]: {} }));
              }}
            >
              {formatMessage({ id: "browser.sitePermissions.reset" })}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
