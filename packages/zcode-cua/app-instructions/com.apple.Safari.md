# Safari

- The address bar is an `AXTextField` inside a toolbar group; `element_set_value`
  on it replaces the URL but does not navigate. After set_value, send
  `press_key` with `return` while the field is focused.
- Search-from-address-bar works the same way: set the query text, then Return.
- Safari restores focus to the page body after navigation; re-observe
  (`capture_app`) before the next element action instead of reusing old indices.
- Download confirmation sheets appear as `AXSheet` surfaces — they show up in the
  element tree with `surface_kind: attached_dialog`. Handle them there.
- PDF content renders as a custom AX view: text inside PDFs is usually NOT
  reachable through the AX tree. Use screenshot + coordinates only as a last
  resort and say so in the result.
