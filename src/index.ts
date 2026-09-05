#!/usr/bin/env bun
import { runApp } from "./tui/app.ts";

process.on("uncaughtException", (e) => {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  console.error("❌ Unexpected error:", e);
  process.exit(1);
});

await runApp();
