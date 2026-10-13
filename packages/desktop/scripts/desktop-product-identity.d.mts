// 声明配对（powershell-command.d.mts/target-platform.d.mts 同款先例）：
// 构建身份脚本是 .mjs（main tsconfig nodenext 不做隐式 any），补类型面。
export declare const ZCODE_PREVIEW_IDENTITY_ENV: string;
export declare const desktopProductIdentities: Readonly<
  Record<string, { readonly flavor: string; [key: string]: unknown }>
>;
export declare function isPreviewIdentityRequested(env?: Record<string, string | undefined>): boolean;
export declare function resolveDesktopProductFlavor(env?: Record<string, string | undefined>): string;
export declare function resolveDesktopProductIdentity(env?: Record<string, string | undefined>): {
  readonly flavor: string;
  [key: string]: unknown;
};
export declare function resolveWindowsAppUserModelIdForFlavor(
  flavor: string,
  runtime?: { isPackaged?: boolean },
): string;
