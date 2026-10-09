# Notion

- Notion is a web-tech UI: most content is custom-rendered. The page tree
  (left sidebar) exposes rows you can activate; the page body mostly does not
  expose per-block AX elements.
- Click into a block to focus it, then `type`; `press_key` `return` creates a
  new block below. Use `set_value` only on known text fields (page title, simple
  inputs).
- Slash commands (`/` at empty block) open a popup menu that appears in the
  tree — open it, re-observe, then pick the entry.
- Databases (tables/boards) are custom widgets: use coordinates on visible
  cells and verify with a fresh `get_app_state` after each action.
- Dialogs (share, settings) render as overlay windows; find them with
  `list_windows` before acting.
