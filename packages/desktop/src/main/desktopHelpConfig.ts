import { net } from "electron";
import {
  buildHelpAppConfigUrl,
  buildZCodeSourceHeadersFromContext,
  createHelpAppConfigReader,
  ZCODE_ENV,
} from "@zcode/shared";

export function createDesktopHelpConfigReader(options: {
  resolveEndpointOrigin: () => Promise<string>;
  appVersion: string;
  deviceMid: string;
}) {
  // Electron net.fetch 的 input 面含 URL，而 typeof fetch 的 RequestInfo 不含——
  // 桥接窄化（URL 在此链路只会是 help 配置端点字符串）。
  const read = createHelpAppConfigReader({
    // Electron net.fetch 的 input 面含 URL（typeof fetch 的 RequestInfo 不含）；
    // 桥接参数按 fetch 全面收（string | URL | Request），toString 归一。
    fetchImpl: (input: string | URL | Request, init?: RequestInit) =>
      net.fetch(input.toString(), init),
  });
  return async () => {
    const endpointOrigin = await options.resolveEndpointOrigin();
    return read(
      buildHelpAppConfigUrl(
        endpointOrigin,
        options.appVersion,
        `${process.platform}-${process.arch}`,
      ),
      buildZCodeSourceHeadersFromContext({
        endpointOrigin,
        appVersion: options.appVersion,
        deviceMid: options.deviceMid,
        platform: process.platform,
        arch: process.arch,
        releaseChannel: ZCODE_ENV,
        sourceTitle: "electron",
      }),
    );
  };
}
