# Slack

- The channel list is a tree of `AXButton`/`AXStaticText` rows in the left
  sidebar; activating a row switches the whole conversation pane — re-observe
  after switching.
- The message composer is a custom rich-text surface at the window bottom;
  `set_value` is unreliable there. Click to focus, then `type` + `return` to
  send. Never send without the user asking.
- The message list is custom-rendered virtualized content: individual messages
  are not AX elements. Read what you need from the screenshot; use coordinates
  sparingly and verify.
- Threads open in a right-hand pane that changes the window layout — expect
  indices to shift and re-observe after opening/closing threads.
