import { createRoot } from "react-dom/client";
import "@zcode/ui/styles.css";
import { renderRelayMobilePage } from "./relayMobilePage.js";

// 手机远控页独立入口（scripts/build-web-remote-mobile-page.mjs 打成 dist-mobile，
// 由 relay /remote/v4 静态服务）。不引入 Root/侧栏图，bundle 只含 MobileShell +
// 既有会话面（V4ChatPane）所需模块。

const root = createRoot(document.getElementById("root")!);
void renderRelayMobilePage(root);
