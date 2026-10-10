// FreeCodeZ W-18/W-19：电脑控制设置区（W-19 形态重建，FC 自有件）。
// 面：可用性横幅 + 总开关（cuaControlEnabled，语义沿用旧键）+ 动作层开关
// （cuaActionsEnabled，总开关关时禁用）+ 输入框入口开关 + 权限状态/引导（W-19 简版）。
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { resolveComputerUseAvailability } from "@/lib/computerUseAvailability.js";

interface PermissionStatus {
  platform: string;
  permissions: Array<{ id: string; status: string }>;
  helperUnavailableReason?: string | null;
}

export function ComputerUseSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const platformService = usePlatform();
  const { settings, update } = useSettings();
  const availability = resolveComputerUseAvailability({ isDesktop });
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>(null);
  const [permissionPending, setPermissionPending] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const refreshPermissions = useCallback(async () => {
    if (!platformService.computerUsePermissionStatus) return;
    try {
      setPermissionStatus(await platformService.computerUsePermissionStatus());
    } catch {
      setPermissionStatus(null);
    }
  }, [platformService]);

  useEffect(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  const save = async (patch: Record<string, unknown>, failId: string) => {
    try {
      await update(patch);
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: failId },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  };

  if (!availability.supported) {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.unsupported.title" })}
          description={intl.formatMessage({
            id: "settings.computerUse.unsupported.remoteDescription",
          })}
          control={<span />}
        />
      </SettingsGroupCard>
    );
  }

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
        description={intl.formatMessage({ id: "settings.computerUse.toggleDescription" })}
        control={
          <Switch
            checked={settings?.cuaControlEnabled === true}
            onCheckedChange={(enabled) => {
              void save(
                { cuaControlEnabled: enabled, ...(enabled ? {} : { cuaActionsEnabled: false }) },
                "settings.computerUse.composerEntry.saveFailed",
              );
              // 首次开启电脑控制：自动触发权限引导（W-19 首次体验——
              // 开总开关即弹 helper 授权引导，免用户再找权限行按钮）。
              if (enabled && platformService.openComputerUsePermissionGuide) {
                void (async () => {
                  await refreshPermissions();
                  const status = await platformService
                    .computerUsePermissionStatus?.()
                    .catch(() => null);
                  const allGranted = status?.permissions.every(
                    (entry) => entry.status === "granted",
                  );
                  if (!allGranted) {
                    await platformService.openComputerUsePermissionGuide?.();
                    await refreshPermissions();
                  }
                })();
              }
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.computerUse.actionsLabel" })}
        description={intl.formatMessage({ id: "settings.computerUse.actionsDescription" })}
        control={
          <Switch
            checked={settings?.cuaActionsEnabled === true}
            disabled={settings?.cuaControlEnabled !== true}
            onCheckedChange={(enabled) =>
              void save({ cuaActionsEnabled: enabled }, "settings.computerUse.composerEntry.saveFailed")
            }
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
        description={
          settings?.cuaControlEnabled === true
            ? intl.formatMessage({ id: "settings.computerUse.composerEntry.description" })
            : intl.formatMessage({ id: "settings.computerUse.composerEntry.requiresEnabled" })
        }
        control={
          <Switch
            checked={settings?.computerUseComposerEntryHidden !== true}
            disabled={settings?.cuaControlEnabled !== true}
            onCheckedChange={(visible) =>
              void save(
                { computerUseComposerEntryHidden: visible !== true },
                "settings.computerUse.composerEntry.saveFailed",
              )
            }
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.computerUse.permissions.title" })}
        description={
          permissionStatus
            ? permissionStatus.permissions
                .map(
                  (entry) =>
                    `${intl.formatMessage({ id: `settings.computerUse.permissions.${entry.id}` })}: ${entry.status}`,
                )
                .join(" · ")
            : intl.formatMessage({ id: "settings.computerUse.permissions.unknown" })
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={permissionPending || !platformService.openComputerUsePermissionGuide}
              onClick={async () => {
                setPermissionPending(true);
                try {
                  await platformService.openComputerUsePermissionGuide?.();
                  await refreshPermissions();
                } finally {
                  setPermissionPending(false);
                }
              }}
            >
              {permissionPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                intl.formatMessage({ id: "settings.computerUse.permissions.guide" })
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
              {intl.formatMessage({ id: "settings.computerUse.permissions.reset" })}
            </Button>
          </div>
        }
      />
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.computerUse.permissions.resetTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: "settings.computerUse.permissions.resetDescription" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await platformService.resetComputerUsePermission?.();
                await refreshPermissions();
              }}
            >
              {intl.formatMessage({ id: "settings.computerUse.permissions.reset" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroupCard>
  );
}
