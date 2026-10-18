import type { Providers } from "./provider.js";
import { createGotifyProvider } from "./providers/gotify.js";
import { createTelegramProvider } from "./providers/telegram.js";

export const providers: Providers = new Map([
  ["telegram", createTelegramProvider()],
  ["gotify", createGotifyProvider()],
]);
