---
name: computer-use
description: Drive native desktop apps on macOS, Windows, and Linux — read UI trees and screenshots, then click, type, scroll, drag, and verify. Use when a task needs a native app's own UI or the OS. For anything inside a web page use Browser Use. Prefer a shell/API/CLI path when it can complete the task. Main agent only.
---

# Computer Use

Read and operate the UI of native desktop applications through the FreeCodeZ
Computer Use engine: accessibility trees first, screenshots for visual
confirmation, element actions over keyboard, keyboard over coordinates.

## Routing

- Prefer a dedicated connector, API, CLI, or the shell when one can complete the
  task. This skill is for visible-window GUI control those cannot reach.
- Web page content → Browser Use. This skill drives the browser's own window
  (chrome, address bar, downloads); page content itself is better read through
  Browser tools when available.
- Main agent only — the runtime refuses computer actions in subagents.
- Never switch to AppleScript, `osascript`, JXA, System Events, or other
  UI-automation technology — especially after a permission refusal.

## Bootstrap — every js call

Each js call runs in a fresh kernel: globals and module cache do not persist,
but UI state does. Bootstrap first, in the same cell, before any action:

```js
const computer = await setupComputerUseRuntime();
const caps = await computer.capabilities(); // always await — every method is async
```

- "Computer use is turned off in FreeCodeZ settings" → the master switch is
  off. Tell the user to enable 电脑操作 in Settings → 计算机控制 and start a new
  session. Never retry, never substitute another automation technology.
- "Computer engine sidecar is not built" → installation defect; report it.
- Probe `capabilities()` once when unsure what the platform supports; it is a
  cheap, read-only call.

## Launching apps

The engine drives **running** apps and has no launch verb. If the target is not
in `computer.listApps()`, launch it with the host shell first, then confirm via
listApps:

- macOS: `open -a "App Name"` (or `open -b com.apple.Calculator`)
- Windows: `start "" "App Name"`; Linux: `gtk-launch <app-id>` / `xdg-open`

Never assume a non-running app exists — `getAppState` on it returns
`INVALID_APP`. A web app name (Gmail) never resolves: target the desktop
browser window that contains it.

## App and window selectors

- Target apps by the exact name or bundleId from `listApps()`. Copy the user's
  app name character-for-character — do not translate, localize, normalize, or
  trim suffixes: `网易云音乐app` is not `网易云音乐`; `日历` is not `Calendar`.
  A rewritten name resolves to a different app or to nothing. If the exact
  string fails, call `listApps()` once and pick the matching identifier.
- `pid:<n>` disambiguates same-name apps.
- Multiple windows: `computer.listWindows({ app })`, then pass `windowId`
  (preferred) or `windowIndex` on every later call for that window.
- **Running but windowless** (e.g. Finder with no open window): `getAppState`
  fails `WINDOW_STALE` and there is no window to reselect — use
  `restoreWindow: true` to reveal one, or ask the user to open a window.
- A modal or dialog becomes the captured window. If the tree reads like another
  part of the app, re-observe: the dialog is there. Read it, act on it, or
  dismiss it (Escape) and observe again.

## The loop

Observe → act on what you just saw → observe again. Never chain actions against
stale state.

- Element indices come from the newest tree only. They are **sparse** (index 7
  does not imply six before it — never infer from elementCount) and expire on
  navigation, focus change, scrolling, window change, or re-render.
  `ELEMENT_UNAVAILABLE` means stale: re-observe, never guess a nearby index.
- Batch related actions that share one observation into a single call, ending
  with a fresh observation.
- Observations wait for the UI to settle automatically — no `setTimeout`, no
  polling loops.
- `includeScreenshot: false` for structure-only checks: faster, and avoids
  leaking pixels.

## Action ladder

For a target, descend only as far as needed:

1. **Element action**: `leftClick` on its index; `performAction` for a semantic
   action the tree advertises — never guess an action name.
2. **`setValue`** for editable fields (returns a verification verdict;
   `value_mismatch` means the UI reformatted the value — re-observe, do not
   repeat).
3. **`type`** after focusing the field (`elementFocus` or a click), for text a
   setValue cannot write. Over 1024 characters it auto-splits; keep one logical
   input per call.
4. **Keys**: `key` for single/navigation keys (Return, Escape, Tab, arrows);
   `hotkey` for one modifier chord plus one key (`CmdOrCtrl+S`); prefer
   `CmdOrCtrl+…` for cross-platform chords. For modifier-clicks use the
   `modifiers` parameter of `leftClick` — never synthesize separate modifier
   down/up around a click (interruption leaves a modifier logically held).
5. **Coordinates last** — canvas, games, and content accessibility cannot see.

`selectText` without `textRange` selects all (composed). Partial ranges are
`not_selectable`: select all and rewrite instead.

## Coordinates and scale

Coordinates are **window-local**. Measure from the latest screenshot of the
same window and convert: `action_x = pixel_x / scale` (Retina is commonly
scale 2) — or pass raw pixels plus `scale` and let the SDK convert. Never copy
element or window bounds into a coordinate. If a coordinate fails with a stale
or wrong-owner error, the window moved — re-observe. Never move, resize, or
close a window to make a coordinate land.

## Verification discipline

- **Accepted is not acted.** The API accepting an action does not mean the app
  did it: typing into web-content editors can be accepted and change nothing.
  Re-observe to confirm the result visibly.
- Actions report verification: `verified` vs `unverified` (accessibility action
  unasserted, or synthetic input). **Never report an unverified action as
  success** — if it could have sent, submitted, bought, or deleted something,
  say the effect is unproven.
- `possiblySent: true` (timeout or focus loss mid-action) may have taken
  effect: re-observe before any retry; never auto-repeat non-idempotent
  actions.
- If success does not change the UI: refresh state, choose a more semantic
  action, or restore/focus the window. Retrying the same synthetic input the
  same way will fail the same way.

## Error playbook

| sdkCode | What to do |
| --- | --- |
| `INVALID_APP` | App not running (launch via shell first) or a web-app name (target the containing browser). `listApps()`, reselect. |
| `INVALID_REQUEST` | Unknown method or bad arguments — fix them; never retry unchanged. |
| `WINDOW_STALE` | Window closed or changed: `listWindows`, reselect. If the app has **no window at all**: `restoreWindow: true` or ask the user to open one. |
| `FOREGROUND_REQUIRED` | Bring the app forward (`restoreWindow: true`); if `possiblySent`, verify before retrying. |
| `ELEMENT_UNAVAILABLE` | Stale index: re-observe and take fresh indices. |
| `NOT_SETTABLE` / `ACTION_UNAVAILABLE` | The element cannot take it: use a different control, or keyboard. |
| `not_selectable` | Partial-range selection is unavailable: select all and rewrite. |
| `TIMEOUT` | Never auto-retry: observe whether it took effect first. |
| `controller_busy` | Another session owns input. Never retryable — report and wait for the user. |
| `control_stopped` | Kill switch fired: stop immediately and summarize what completed. |
| `actions_disabled` | 动作层被设置关闭（观察类方法仍可用）：告知用户在 设置 → 计算机控制 开启「允许操作」并重开会话；不要重试，不要改用其他自动化技术。 |
| `app_blocked` / `permission_denied` | Intentionally blocked or TCC missing: stop and follow `requestAccess()` guidance. Never switch technology. |
| `unsupported_capability` | The platform cannot do it: use a semantic alternative. |
| `CUA_NOT_READY` | Engine unreachable: retry once, then report honestly. |
| `screenshot_failed` | Retry once without screenshot (the tree may suffice); if it names Screen Recording, guide the permission setup. |
| `accessibility_error` | Check `capabilities()`; guide the Accessibility permission setup. |

## Safety and scope

- Never submit forms, send messages, buy items, delete data, or change account
  settings unless the user explicitly asked for that action.
- If an app contains sensitive content, read only what the user requested.
- Never type passwords, tokens, or card numbers unless the user asked for
  exactly that, in this conversation. Sensitive values are redacted in outputs;
  password-manager targets refuse actions outright.
- `computer.stop(reason)` is the kill switch (idempotent; probing tools stay
  available). The user can always cancel (Esc in the HUD): a `cancelled`
  rejection means stop at once and summarize what had completed.
- Persist until the request is actually complete: verify the returned state
  visibly shows the result before reporting success, or explain the concrete
  blocker you cannot resolve.

## Platform notes

- **macOS**: synthetic clicks land where the real pointer sits — an action
  accepted with no change may have acted there; prefer element indices. TCC
  needs Accessibility + Screen Recording granted to FreeCodeZ.
- **Windows**: name apps by their Start-menu name, not a window title.
  Launching a non-packaged app steals focus; taking a screenshot may
  un-minimize — a minimized tree is fully usable, so keep screenshots off by
  default.
- **Linux**: needs a desktop session (AT-SPI). Prefer element indices and trust
  the tree over potentially occluded pixels.
