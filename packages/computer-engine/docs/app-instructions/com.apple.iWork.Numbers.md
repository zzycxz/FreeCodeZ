## Numbers Computer Use

- The spreadsheet canvas is custom-rendered: cells are NOT individual AX
  elements. Select a cell by clicking its grid coordinates, then type; do not
  look for per-cell AX nodes.
- The formula bar at the top is a real `AXTextField` — `set_value` there edits
  the selected cell's content directly.
- Sheet tabs sit at the window bottom as `AXRadioButton`s; switch sheets by
  activating the tab, then re-observe (the grid below changes entirely).
- The toolbar's insert/format controls are `AXButton`s. Dialogs (export, print)
  appear as separate windows — pick them from `list_windows`.
