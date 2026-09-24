/**
 * Pure parsers for `pocketshell usage --json` — NDJSON rows.
 *
 * LIFTED INTO @pocketshell/core (src/usageParsers.ts) so the browser
 * transport parses a host's usage answer identically; this module is now a
 * re-export so the main process's importers keep one import path.
 */
export { parseUsageNdjson } from '@pocketshell/core';
export type { UsageRow } from '@pocketshell/core';
