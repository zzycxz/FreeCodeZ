# Finder

- The file list exposes files as `AXRow` inside `AXOutline` elements. Each row
  supports `AXPress` (open), `AXShowMenu` (context menu), and
  `AXOpen`/`AXDisclose` actions where applicable — prefer these over
  double-click synthesis.
- Renaming: select the row, `press_key` `return`, then `element_set_value` on
  the focused text field, then `return`. Do not synthesize double-click.
- Sidebar items are `AXButton`s; they navigate immediately on `AXPress`.
- Go-to-Folder is `cmd+shift+g` on any window; it opens a sheet with a normal
  text field (`element_set_value` then `return`).
