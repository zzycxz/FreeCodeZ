import { app } from "electron";
import { join } from "node:path";
import { resolveBuiltinProviderConfigPath } from "./desktopProviderConfigExplicit.js";

export function resolveZCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
  readonly logger?: { warn(message: string, ...args: unknown[]): void };
}): string {
  const bundledPath = (() => {
    if (options?.isPackaged ?? app.isPackaged) {
      return join(
        options?.resourcesPath ?? process.resourcesPath,
        "config/provider/zcode-builtin.json",
      );
    }
    // 开发态与打包共用唯一线上配置源。
    return join(
      options?.appPath ?? app.getAppPath(),
      "../../config/provider",
      "zcode-builtin.json",
    );
  })();
  // 显式路径先过 fork schema 预检（官方 ZCode 的 shell 集成会写入指向官方配置的
  // 同名键——外来配置不可信，校验不过回退打包内置基线，不打死 agent）。
  return resolveBuiltinProviderConfigPath({
    explicitPath: (options?.env ?? process.env)["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"],
    bundledPath,
    onFallback: (explicitPath, reason) => {
      (options?.logger ?? console).warn(
        `[desktopProviderConfig] explicit ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ${reason}, falling back to bundled config`,
        explicitPath,
      );
    },
  });
}
