# 系统依赖说明（W-12，FreeCodeZ 自有文档）

电脑控制引擎的三平台 provider 对宿主环境的前置要求。缺依赖时 provider 不可用，
sidecar 返回结构化 `unsupported_capability`（不静默降级，R7 fail-closed 口径）。

## Linux（desktop-script provider：`runtime.py`）

- **交互式图形桌面会话**：必须运行在图形会话内（Wayland/X11），headless/SSH 无显示
  服务器会话不可用。
- **python3**（3.10+）：runtime.py 的执行底座。
- **python3-gi + AT-SPI**：UI Automation 经 AT-SPI2（`gi.repository.Atspi`）读控件树。
  发行版包名参考：Debian/Ubuntu `gir1.2-atspi-2.0 python3-gi`；Fedora `at-spi2-core
  python3-gobject`。桌面会话需启用 AT-SPI（多数桌面默认开；无桌面/极简 WM 需手动
  拉起 `at-spi2-registryd`）。
- **截图**：X11 用 `import`（ImageMagick）或 `gnome-screenshot`；Wayland 用
  `grim`/门户截图。缺失时 screenshot 返回不可用并建议 `--no-screenshot`。
- **合成键鼠**：`xdotool`（X11）或 ydotool/wtype（Wayland）；缺失时动作类方法返回
  `unsupported_capability`。

## Windows（desktop-script provider：`runtime.ps1`）

- **PowerShell 5.1+**（系统自带 Windows PowerShell 或 pwsh）。
- **ExecutionPolicy**：脚本以 `-ExecutionPolicy RemoteSigned` 首选启动；命中策略阻塞时
  一次性降级 `-ExecutionPolicy Bypass` 重试（判别器见
  `src/main/computer/windows-powershell-execution-policy.ts`，普通 Access Denied 不降级）。
- **UI Automation**：经 .NET `System.Windows.Automation`（WPF UIA3）；需交互式用户会话
  （服务会话/非交互 RDP 断开态不可用）。
- **PowerShell 7（pwsh）约束**：`-File` 传参语义差异已由 serve 通道规避（one-shot 回退
  统一走 Windows PowerShell）。

## macOS（native provider：`FreeCodeZ Computer Use.app`）

- **TCC 双权限**：Accessibility（读/操作控件）+ Screen Recording（截图），授权对象为
  `app.freecodez.computer-use`（见 `native/computer-use-macos/`）。
- **helper 由 sidecar 经 `--agent <socket-path>` 拉起**；peer 信任双检只放行
  `app.freecodez.*` 族进程（W-11 红线：不信任任意 Electron 进程）。
- macOS 版本门槛见 helper 的 `LSMinimumSystemVersion`（14.0）。

## 通用

- 会话必须有可用的输入/展示面（合成输入不跨用户/锁屏会话生效）。
- 依赖缺失/权限未授予时的行为差异与恢复步骤由 `computer-use-error-recovery.ts` 的
  16 码剧本统一给出（W-25 信封重建后接入新 SDK）。
