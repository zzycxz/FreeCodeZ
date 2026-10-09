# Visual Studio Code

- The editor is a custom-rendered surface: individual characters/lines are NOT AX
  elements. Operate on the whole editor via keyboard (`press_key`/`type`), not by
  clicking text offsets.
- The Integrated Terminal is also custom; `set_value` on it does not type
  commands. Focus it (click its tab), then `type` + `return`.
- Command Palette (`cmd+shift+p`) is the reliable entry point for any command:
  it is a normal AX text field plus a list; type the command, then press
  `return` on the top result.
- File navigation: `cmd+p` quick-open behaves like the Command Palette.
- Lists (explorer, tabs, quick-open) expose `AXRow`/`AXListItem` elements with
  `AXPress`; prefer them via `perform_action` over coordinate clicks on labels.
