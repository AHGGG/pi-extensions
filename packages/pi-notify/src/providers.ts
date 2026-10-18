import type { Providers } from "./provider.js";
import { createGotifyProvider } from "./providers/gotify.js";
import { createSlackProvider } from "./providers/slack.js";
import { createTelegramProvider } from "./providers/telegram.js";

export const providers: Providers = new Map([
  ["telegram", createTelegramProvider()],
  ["gotify", createGotifyProvider()],
  ["slack", createSlackProvider()],
]);
