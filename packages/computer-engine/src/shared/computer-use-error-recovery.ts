// FreeCodeZ 修改声明（V1.19 P2）：orca 1.4.214 派生件改写——恢复指导自 orca CLI
// 命令句全面改写为本引擎 computer.* API 面（A1 卫生：模型可见面零 orca 残留），
// 并吸收两条例化经验（V1.17 shell 启动、V1.18 无窗口处置）。接线点=SDK call() 错误路径。
export type ComputerUseErrorRecoveryData = {
  nextSteps: string[]
}

export function computerUseErrorRecoveryData(
  code: string,
  message?: string
): ComputerUseErrorRecoveryData | undefined {
  switch (code) {
    case 'app_not_found':
      return recoverWith(
        'Call computer.listApps() and retry with the exact app name or bundleId it returns.',
        'If the app is not running, launch it with the host shell first (macOS `open -a <name>` / `open -b <bundleId>`, Windows `start`, Linux `gtk-launch`), confirm via listApps(), then retry — the engine has no launch verb.',
        'If the target is a website or web app such as Gmail, choose the desktop browser app/window that contains it; app selectors refer to desktop apps, not website names.',
        'If the desired browser is not listed, open or focus that browser first, then re-run computer.listApps() and computer.listWindows({ app }).'
      )
    case 'app_blocked':
      return recoverWith(
        'Do not continue with this app through computer-use; choose a non-sensitive target or ask the user to handle it manually.'
      )
    case 'window_not_found':
      return recoverWith(
        'Call computer.listWindows({ app }) and target one of the listed windows via windowId (preferred) or windowIndex.',
        'If the app is listed but has no window at all (e.g. Finder with nothing open), retry observation once with restoreWindow: true to reveal one; if that fails, ask the user to open a window.',
        'Do not loop on listWindows when the app has no window — it cannot list what does not exist.'
      )
    case 'window_not_focused':
      if (message?.includes('may already have been delivered')) {
        return recoverWith(
          'Call computer.getAppState({ app }) and verify whether the intended action already occurred before retrying.',
          'Do not retry the click if it already took effect; otherwise bring the target window forward (restoreWindow: true) and use fresh state before trying again.'
        )
      }
      return recoverWith(
        'Retry once with restoreWindow: true on the target.',
        'If restoreWindow was already used, stop retrying restore; bring the app forward manually, check permissions, or prefer computer.setValue for editable fields.'
      )
    case 'window_stale':
      return recoverWith(
        'Call computer.listWindows({ app }) and choose a current window selector.',
        'Then re-run computer.getAppState({ app }) before acting.',
        'If the app has no window at all, use restoreWindow: true or ask the user to open one.'
      )
    case 'provider_incompatible':
      return recoverWith(
        'Call computer.capabilities() and verify the local provider supports the requested operation.',
        'Update FreeCodeZ or use a supported platform/provider path before retrying.'
      )
    case 'unsupported_capability':
      return recoverWith(
        'Call computer.capabilities() and choose a supported action.',
        'Use a semantic alternative such as computer.setValue or computer.leftClick, or install the missing desktop dependency if the error names one.'
      )
    case 'permission_denied':
      return recoverWith(
        'Call computer.requestAccess() — or computer.requestAccess({ capabilities: ["accessibility"] }) / ({ capabilities: ["screenshots"] }) when the message names one missing permission — and follow its guidance.',
        'For remote or SSH targets, verify the command is running inside an active graphical desktop session.'
      )
    case 'element_not_found':
      return recoverWith(
        'Call computer.getAppState({ app }) again and use an element index from the fresh tree.',
        'Do not infer valid indexes from elementCount or reuse indexes after navigation, scrolling, focus changes, or delays.'
      )
    case 'element_not_clickable':
      return recoverWith(
        'Choose a nearby parent or child element that has an actionable frame.',
        'If using coordinates, derive window-local coordinates from the latest screenshot of the same target window (divide pixels by scale).'
      )
    case 'action_not_supported':
      return recoverWith(
        'Inspect the element in a fresh computer.getAppState({ app }) result and use one of its advertised secondary actions (computer.performAction).',
        'If no suitable action is listed, use computer.leftClick, computer.setValue, or another semantic action instead.'
      )
    case 'value_not_settable':
      return recoverWith(
        'Choose a settable text element from a fresh computer.getAppState({ app }) result.',
        'If the target cannot accept direct value writes, focus it and use keyboard input only after inspecting the returned state.'
      )
    case 'invalid_argument':
      return recoverWith(
        'Fix the method arguments exactly as described by the error message.',
        'Do not retry the same call unchanged.'
      )
    case 'action_timeout':
      return recoverWith(
        'Call computer.getAppState({ app }) before retrying so you know whether the UI changed — a timed-out action may already have taken effect.',
        'Retry with a simpler semantic action or includeScreenshot: false if observation is slow; do not repeat the same timed-out action blindly.'
      )
    case 'screenshot_failed':
      return recoverWith(
        'If the accessibility tree is sufficient, re-observe with computer.getAppState({ app, includeScreenshot: false }) instead of retrying the same capture.',
        'If the message mentions Screen Recording or screenshots permission, call computer.requestAccess({ capabilities: ["screenshots"] }) and guide the user to grant access before retrying.',
        'If the message mentions the payload cap, target a smaller/current window or set includeScreenshot: false.'
      )
    case 'accessibility_error':
      return recoverWith(
        'Call computer.capabilities() to confirm the provider is available before retrying.',
        'If the message mentions permissions, call computer.requestAccess({ capabilities: ["accessibility"] }) and guide the user to grant access.',
        'Do not loop on the same action if provider availability or permissions remain unchanged.'
      )
    default:
      return undefined
  }
}

function recoverWith(...nextSteps: string[]): ComputerUseErrorRecoveryData {
  return { nextSteps }
}
