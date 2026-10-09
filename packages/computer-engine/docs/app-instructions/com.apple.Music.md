## Music Computer Use

- Playback controls live in the window's top toolbar as small `AXButton`s
  (play/pause, next, previous). Use element actions on them; they stay stable
  across track changes.
- The song list is an `AXTable`/`AXOutline`: rows expose selection and
  double-activate semantics through `perform_action` rather than synthetic
  double clicks.
- The search field opens a results dropdown; set the query with `set_value`,
  then allow the dropdown to populate before re-observing — its rows are a
  separate surface in the tree.
- The current-track indicator updates constantly. Re-observe after any playback
  action instead of trusting earlier indices.
