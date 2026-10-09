# Clock

- The toolbar switches between World Clock / Alarms / Stopwatch / Timers; each
  tab is an `AXRadioButton` — activate it and re-observe before touching
  controls below.
- Creating an alarm: open the add (+) button, then fill the time picker. The
  picker is a group of small `AXTextField`s plus `AXStepper`s; prefer `set_value`
  on the hour/minute fields over clicking arrows.
- Toggling an alarm is the `AXSwitch`/checkbox at its row end; one `AXPress`.
- Stopwatch and Timers own their own start/pause/reset buttons; state text
  (running/paused) is an `AXStaticText` you can read from the tree — confirm it
  after acting.
