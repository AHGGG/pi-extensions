---
"@narumitw/pi-starship": patch
---

Fix the configuration skill path resolver for managed extension installs with a separate npm or Bun global Pi installation. Resolve the public Pi API beside the first Pi executable on PATH when the host peer is absent from the skill module tree, preserve the original working directory, and stop with actionable guidance instead of guessing a settings path.
