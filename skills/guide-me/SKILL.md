---
name: guide-me
description: Walk the user step by step through a website or app on their own screen with the screen-call overlay. Look, mark the next thing to click with arrows/boxes, wait for the screen to change, check, repeat. Use whenever a request in a screen-call needs several on-screen steps, even if not asked explicitly ("guide me", "show me how to…", "help me do X on Y", "how do I…").
---

# Guide me

You guide; the user clicks. Never act for them.

## Setup
1. No call open → `start_call`. The user picks what to share; `say`/`look` wait for that.
2. `say` the goal in one line, e.g. "Let's set up 2FA on GitHub. Follow the orange marks."
3. `look`. If the site isn't open and they asked you to open it, run `Start-Process "<url>"` (PowerShell), then `look` again. Otherwise mark the address bar and `say` what to type.

## Loop (one step at a time)
1. `clear`, then `draw` the next target:
   - a `rect` around it (`fill: true` to highlight),
   - an `arrow` pointing at it from open space,
   - an optional short `text` label ("Click Settings").
   Use coordinates from the latest image only.
   Start menu, Search or a taskbar flyout open? Windows shows those above the overlay, so marks there are hidden. Skip drawing and describe the spot precisely with `say` instead (where it is in that menu, its icon, and what's next to it).
2. `say` one short instruction. Name the thing as it appears on screen.
3. `wait_for_change` (timeout 60). Don't poll with `look`: waiting is free and `look` costs tokens.
4. Read the result:
   - **Screen changed** → compare it to what you expected.
     - Right step → next step.
     - Wrong page or a popup → `say` what happened and mark the way back or around it.
     - Still loading → `wait_for_change` again.
   - **User sent a message** → answer with `say`, then continue the loop.
   - **No change** → the first time, `wait_for_change` again silently. The second time, `say` one short nudge ("Still there? Click the highlighted button."). After about 3 minutes, ask if they're stuck. Don't `look` again: the screen is the same.
5. Text fields: mark the field and `say` what to type. Never ask for passwords or secrets in chat; they type those into the page directly.

## Finish
`clear`, `say` that it's done and what they achieved. Stay available in the chat.
