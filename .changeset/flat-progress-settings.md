---
"@narumitw/pi-progress": minor
---

Flatten the five display settings in `pi-progress.json`. Existing nested `widget` settings remain readable, with top-level fields taking precedence.

Stop reading `pi-todo.json`. Users who rely on that file must copy their preferences into `pi-progress.json`; the extension leaves the old file unchanged.
