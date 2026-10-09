### iPhone Mirroring Instructions

- iPhone Mirroring renders the phone screen in a single custom view: the iOS UI
  is NOT exposed to macOS accessibility at all. Every action must be
  coordinate-based on the mirrored window.
- Read the current screen from the screenshot in `get_app_state`; there is no
  element tree to reference. Say so in your results.
- The window chrome around the mirror (close button, sidebar toggle) is regular
  macOS AX — only the inner mirror is coordinate territory.
- Orientation changes resize the mirror surface; re-observe after any rotation
  or navigation before the next tap.
- Typing into the mirrored phone: click the target field first, then use `type`
  or `paste`; the macOS keyboard forwards into the mirror when it has focus.
