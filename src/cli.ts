#!/usr/bin/env bun
/**
 * diskly CLI entry point.
 *
 *   diskly                → launches the interactive TUI (default).
 *   diskly --version | -v → prints the version and exits.
 *   diskly --help    | -h → prints the usage and exits.
 *
 * The TUI is the only sub-app for now; future non-interactive commands
 * (e.g. `diskly scan /path`, `diskly duplicates /path`) can be added here.
 */

import { runApp } from "./tui/app.ts";

const VERSION = "1.0.0";

function printHelp(): void {
  const out =
    `diskly ${VERSION}\n` +
    `\n` +
    `Usage:\n` +
    `  diskly [options]\n` +
    `\n` +
    `Options:\n` +
    `  -v, --version   print the version and exit\n` +
    `  -h, --help      print this help message and exit\n` +
    `\n` +
    `Run with no options to launch the interactive TUI.\n`;
  process.stdout.write(out);
}

const argv = process.argv.slice(2);

if (argv.includes("-v") || argv.includes("--version")) {
  process.stdout.write(`diskly ${VERSION}\n`);
  process.exit(0);
}

if (argv.includes("-h") || argv.includes("--help") || argv.includes("help")) {
  printHelp();
  process.exit(0);
}

if (argv.length > 0) {
  // Pass-through for future subcommands. Today everything routes to the TUI
  // and the TUI simply ignores extra arguments.
  process.stderr.write(`diskly: unknown argument(s): ${argv.join(" ")}\n`);
  process.stderr.write(`Run "diskly --help" for usage.\n`);
  process.exit(2);
}

process.on("uncaughtException", (e) => {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  process.stderr.write(`❌ Unexpected error: ${e?.stack ?? e}\n`);
  process.exit(1);
});

await runApp();
