---
"@narumitw/pi-notify": patch
---

Prebuild the package-owned TypeScript into a split Jiti runtime to reduce package loading work while preserving lazy menu loading and notification behavior. Local package-directory loading now requires a build; published packages include the generated runtime.
