## Spotify Computer Use

- The left sidebar is the navigation surface (Home / Search / Your Library):
  rows are `AXButton`s — activate and re-observe, the main pane rebuilds.
- Search: activate Search first, then `set_value` on the search field at the
  top of the main pane; results populate asynchronously, so re-observe before
  selecting.
- Playback bar is pinned to the window bottom: play/pause/shuffle/repeat are
  `AXButton`s; the progress element is custom — use coordinates only if needed.
- Context menus (right-click rows) are separate menu surfaces; the menu
  children appear in the tree after opening — do not assume they pre-exist.
