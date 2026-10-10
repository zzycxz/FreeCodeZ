---
name: computer-use
description: Drive desktop apps (macOS, Windows, Linux) to read and operate their interfaces — click, type, scroll, drag, and inspect UI state. Use when the user asks to operate a native desktop application, interact with system UI outside the browser, or automate GUI actions on their computer.
---

# Computer Use

Operate desktop applications through accessibility APIs and screenshots. This skill
teaches the discipline the engine expects; the tools themselves are self-describing.

## Bootstrap（每个 js 调用开头）

Computer Use 经 `mcp__node_repl__js` 工具驱动（JavaScript 作为 `code` 参数）。每次调用
先引导再操作：

```js
const computer = await setupComputerUseRuntime();
```

引导函数由 node_repl host 注入（`injectedGlobals`），零 import 直接可调。

引导后用 `computer.*` 方法操作（见下）。每个 `js` 调用都是新内核——每次调用都要重跑引导。

## Preconditions

- The computer-use engine must be ready (`capabilities` succeeds). If it returns
  `CUA_NOT_READY`, tell the user the engine is unavailable — never pretend an action ran.
- Some actions need system permissions (macOS Accessibility + Screen Recording).
  Ask the user to run `request_access` and follow its guidance before reading UI state.
- Only one controller drives the computer at a time. If a tool returns
  `controller_busy`, wait for the user to free the session — do not retry.

## Core Loop

1. `computer.listApps()` to find the target application (name, bundle id, pid).
2. `computer.getAppState({ app })` on the chosen app to obtain the UI tree and (usually) a screenshot.
3. Act on the state you just received: reference elements by their **index** from that
   tree, or by coordinates computed from that screenshot.
4. After each action, read the returned verification, then `get_app_state` again
   before the next action. Never chain actions against stale state.

## Sparse Index Discipline

- The UI tree lists element indices sparsely — index `7` does not imply six elements
  before it. Never infer indices from `elementCount`; only use indices present in the
  tree text you are looking at.
- Indices expire quickly (menus close, dialogs appear, lists reorder). If an action
  returns `ELEMENT_UNAVAILABLE` or `WINDOW_STALE`, re-observe first; do not guess
  nearby indices.

## App and Window Selectors

- Identify apps by name, bundle id, or `pid:<n>`. If several apps match a name,
  disambiguate with `list_apps` output, not by guessing.
- When an app has multiple windows, pick one with `list_windows` and pass
  `windowId` (preferred) or `windowIndex`. Otherwise the engine targets the
  frontmost/main window and may hit the wrong one.
- To open or reveal a hidden app, use `get_app_state` with `restoreWindow: true`.

## Coordinates and Scale

- Coordinates in actions are **window coordinates**. If you measured pixel positions
  from a screenshot, divide by the screenshot's scale factor
  (`action_x = pixel_x / scale`). Retina screenshots commonly use scale 2.
- Prefer element-index actions over coordinates whenever the tree exposes the target.

## Screenshots and Sensitive Input

- Use `get_app_state` without screenshots (`include_screenshot: false`) for
  text/structure-only checks — it is faster and avoids leaking pixels.
- Never type passwords, tokens, or card numbers through this skill unless the user
  explicitly asked for that exact input in this conversation. Sensitive values are
  redacted in outputs; blocked password-manager targets refuse actions outright.
- For pasting long text use `paste` (text only) instead of `type`.

## Action Rules

- `type` splits text longer than 1024 characters automatically; keep one logical
  input per call and wait for the result.
- `type` with a target first clicks the target to focus it — ensure the click cannot
  trigger an unintended control (prefer `set_value` on form fields).
- `set_value` returns a verification verdict. A `value_mismatch` verdict means the UI
  rejected or reformatted the value — re-observe and adapt, do not blindly repeat.
- `key` handles single keys; modifier chords belong to `hotkey` (e.g. `CmdOrCtrl+A`).
- `select_text` selects all text of a target element. Partial ranges are not
  available (`not_selectable`): select all and rewrite instead.
- `drag` requires both endpoints in the same application. Cross-app drag is refused.
- Actions that report `possibly_sent` (timeout, focus loss mid-action) **may have
  already taken effect**. Re-observe before any retry; never auto-repeat them.

## Verification Discipline

- An action marked `unverified` (no post-state assertion) is **not** proof of
  success. Follow with `get_app_state` and confirm the expected change before you
  report success to the user.
- If verification shows the UI did not change, report the failure honestly and
  re-plan; do not claim the step is done.

## Stop and Cancellation

- `stop_computer_control(reason)` halts all further computer actions for the session
  (idempotent; probing tools stay available). Use it when the user asks to stop, or
  when continuing would be unsafe.
- The user can cancel at any time (Esc in the HUD). A `cancelled` rejection means
  stop immediately and summarize what had completed.

## Error Playbook

| Code | Retry class | What to do |
| --- | --- | --- |
| `ELEMENT_UNAVAILABLE` | re-observe | `get_app_state` again; use fresh indices |
| `WINDOW_STALE` | re-observe | `list_windows`, reselect, retry |
| `FOREGROUND_REQUIRED` | re-observe (or never if `possibly_sent`) | bring the app forward; if possibly sent, verify before retry |
| `TIMEOUT` | never auto-retry | verify effect first; then decide |
| `INVALID_APP` | re-observe | `list_apps`, reselect |
| `app_blocked` / `permission_denied` | never | tell the user; `request_access` guidance |
| `NOT_SETTABLE` / `ACTION_UNAVAILABLE` | never | use a different control or method |
| `INVALID_REQUEST` | never | fix arguments |
| `CUA_NOT_READY` | retry once, then report | engine not ready/unreachable |
| `unsupported_capability` / `accessibility_error` / `screenshot_failed` | retry once | `capabilities` check; fall back to `include_screenshot: false` |

## App Notes

- **Browsers**: target the browser app itself (Chrome/Safari/Edge), not a web app
  name; the browser's own window tree exposes page chrome — page content itself is
  better read through browser tools when available.
- **Forms**: prefer `set_value` on fields; watch for validation reformatting.
- **File dialogs**: they are separate windows — select them with `list_windows`.
