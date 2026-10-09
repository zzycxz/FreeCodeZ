// FreeCodeZ W-22：金样场景清单（R4/W-22 口径——仅继承旧金样 36 例的**场景覆盖面**，
// 期望值全部以新引擎自有点位重录，禁止以官方实录作期望值）。来源：
// 测试计划-CUA-金样场景清单.md（W-00③ 提取）。
export interface GoldenScenario {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  /** success：需引擎真跑成功（多数需 TCC/真机）；error：错误族（无 TCC 可录）。 */
  kind: "success" | "error";
  /** 依赖系统权限（TCC/AT-SPI）才能到成功面。 */
  needsTcc?: boolean;
  /** 清单处置注记。 */
  note?: string;
}

export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  // —— 握手/探测（无 TCC 可录）——
  { id: "00-handshake-capabilities", method: "capabilities", kind: "success" },
  { id: "02-capabilities-no-auth", method: "capabilities", kind: "success", note: "无鉴权门" },
  { id: "04-unknown-method", method: "nonexistent_method", kind: "error", note: "替补 authenticate_ok 的缺席面" },
  { id: "11-supports-flags", method: "capabilities", kind: "success", note: "supports.* 真值" },
  // —— 观测三场景 ——
  { id: "12-list-apps", method: "listApps", kind: "success", note: "NSWorkspace 无 TCC" },
  { id: "13-list-windows", method: "listWindows", params: { app: "com.apple.finder" }, kind: "success", needsTcc: true },
  { id: "14-app-state-tree", method: "getAppState", params: { app: "com.apple.finder", noScreenshot: true }, kind: "success", needsTcc: true },
  { id: "15-app-state-screenshot", method: "getAppState", params: { app: "com.apple.finder" }, kind: "success", needsTcc: true },
  // —— 元素读写 ——
  { id: "19-set-value", method: "setValue", params: { app: "com.apple.finder", elementIndex: 1, value: "x" }, kind: "success", needsTcc: true },
  { id: "23-click-element", method: "click", params: { app: "com.apple.finder", elementIndex: 1 }, kind: "success", needsTcc: true },
  { id: "18-stale-index", method: "click", params: { app: "com.apple.finder", elementIndex: 99999 }, kind: "error", note: "element_not_found 族" },
  { id: "20-not-settable", method: "setValue", params: { app: "com.apple.finder", elementIndex: 1, value: "" }, kind: "error", needsTcc: true },
  { id: "22-bad-action", method: "performSecondaryAction", params: { app: "com.apple.finder", elementIndex: 1, action: "NoSuchAction" }, kind: "error", needsTcc: true },
  // —— 错误族（无 TCC 可录：provider/权限未授的结构化错误）——
  { id: "26-bad-args", method: "click", params: { app: "com.apple.finder" }, kind: "error", note: "invalid_argument：无目标" },
  { id: "27-method-not-found", method: "no_such_tool", kind: "error" },
  { id: "29-window-not-focused-family", method: "click", params: { app: "com.apple.finder", elementIndex: 1 }, kind: "error", note: "未授权环境的权限族错误" },
  { id: "36-app-not-found", method: "listWindows", params: { app: "No Such App Ever" }, kind: "error", note: "app_not_found 族" },
  // —— 会话层/SDK 面（新面自录，golden 归 W-25 测试族）——
  { id: "06-controller-status", method: "capabilities", kind: "success", note: "租约状态在会话层 W-25 单测族" },
  { id: "07-permissions", method: "capabilities", kind: "success", note: "permissionsStatus 经宿主权限面（W-13），非 sidecar wire" },
  // —— 砍除登记（无替补，留档）——
  { id: "16-hidden-tree", method: "getAppState", params: { app: "com.apple.finder", tree_shown_to_model: false }, kind: "error", note: "砍：引擎恒全量——旧参数现为 invalid_argument 面" },
  { id: "32-35-pip-family", method: "capabilities", kind: "success", note: "D5 PiP 砍，无替补" },
];

/** W-22 增补（旧金样未覆盖、新契约必测）——随录制器扩展。 */
export const GOLDEN_SCENARIOS_EXTRA: GoldenScenario[] = [
  { id: "x-scroll", method: "scroll", params: { app: "com.apple.finder", elementIndex: 1, direction: "down", pages: 0.5 }, kind: "success", needsTcc: true },
  { id: "x-drag", method: "drag", params: { app: "com.apple.finder", fromElementIndex: 1, toElementIndex: 2 }, kind: "success", needsTcc: true },
  { id: "x-type-cjk", method: "typeText", params: { app: "com.apple.finder", text: "中文输入测试" }, kind: "success", needsTcc: true },
  { id: "x-press-key", method: "pressKey", params: { app: "com.apple.finder", key: "Return" }, kind: "success", needsTcc: true },
  { id: "x-hotkey", method: "hotkey", params: { app: "com.apple.finder", key: "CmdOrCtrl+A" }, kind: "success", needsTcc: true },
  { id: "x-paste", method: "pasteText", params: { app: "com.apple.finder", text: "paste" }, kind: "success", needsTcc: true },
  { id: "x-no-screenshot-skipped", method: "getAppState", params: { app: "com.apple.finder", noScreenshot: true }, kind: "success", needsTcc: true, note: "screenshotStatus.skipped" },
];
