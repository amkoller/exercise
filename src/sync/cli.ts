/** Argument parsing for `npm run sync` (AI-641). Pure: scripts/sync.ts does the I/O. */
import type { SyncProvider } from "./runner.js";

export interface SyncArgs {
  source: SyncProvider | "all";
  /** `refetch-streams` (AI-861): reingest Garmin rides stored without streams; `--source garmin` only. */
  mode: "full" | "incremental" | "refetch-streams";
  /** `--limit n`: with --refetch-streams, the most rides to reingest. */
  limit?: number;
  recomputeAll: boolean;
  reseedPelotonToken: boolean;
  help: boolean;
}

export const SYNC_USAGE = `Usage: npm run sync -- --source garmin|peloton|all --full|--incremental [options]
       npm run sync -- --source garmin --refetch-streams [--limit n]

  --source <s>             garmin, peloton or all (required)
  --full                   backfill the whole history (resumes where the last run stopped)
  --incremental            fetch what is new since the last success
  --refetch-streams        download the FIT again for every Garmin ride stored without streams
                           and reingest it, oldest first (needs --source garmin)
  --limit <n>              with --refetch-streams, reingest at most n rides
  --recompute-all          after the sync, recompute every ride's TSS and the daily load
  --reseed-peloton-token   store PELOTON_REFRESH_TOKEN as the Peloton credential first (reconnect)
  --help                   print this help

Exactly one of --full, --incremental and --refetch-streams is required. Env comes from .env.local; see docs/ride-sync.md.`;

export class SyncUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${SYNC_USAGE}`);
    this.name = "SyncUsageError";
  }
}

const SOURCES = ["garmin", "peloton", "all"] as const;

/** Parses argv (without node and the script path). `--help` wins over every other check. */
export function parseSyncArgs(argv: readonly string[]): SyncArgs {
  let source: string | null = null;
  let full = false;
  let incremental = false;
  let refetch = false;
  let limit: string | null = null;
  let recomputeAll = false;
  let reseedPelotonToken = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--full") full = true;
    else if (arg === "--incremental") incremental = true;
    else if (arg === "--refetch-streams") refetch = true;
    else if (arg === "--recompute-all") recomputeAll = true;
    else if (arg === "--reseed-peloton-token") reseedPelotonToken = true;
    else if (arg === "--source" || arg.startsWith("--source=")) {
      if (source !== null) throw new SyncUsageError("--source given more than once");
      const value = arg === "--source" ? argv[++i] : arg.slice("--source=".length);
      if (value === undefined || value.startsWith("--")) throw new SyncUsageError("--source needs a value");
      source = value;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      if (limit !== null) throw new SyncUsageError("--limit given more than once");
      const value = arg === "--limit" ? argv[++i] : arg.slice("--limit=".length);
      if (value === undefined || value.startsWith("--")) throw new SyncUsageError("--limit needs a value");
      limit = value;
    } else throw new SyncUsageError(`unknown argument: ${arg}`);
  }

  if (help) return { source: "all", mode: "incremental", recomputeAll, reseedPelotonToken, help: true };
  if (source === null) throw new SyncUsageError("--source is required");
  if (!(SOURCES as readonly string[]).includes(source)) {
    throw new SyncUsageError(`--source must be garmin, peloton or all, not ${source}`);
  }
  if (Number(full) + Number(incremental) + Number(refetch) !== 1) {
    throw new SyncUsageError("give exactly one of --full, --incremental and --refetch-streams");
  }
  if (refetch && source !== "garmin") throw new SyncUsageError("--refetch-streams needs --source garmin");
  if (refetch && recomputeAll) {
    throw new SyncUsageError("--refetch-streams does not take --recompute-all; run --source peloton --incremental --recompute-all after it");
  }
  if (limit !== null && !refetch) throw new SyncUsageError("--limit needs --refetch-streams");
  if (limit !== null && !/^[1-9]\d*$/.test(limit)) throw new SyncUsageError(`--limit must be a positive integer, not ${limit}`);
  if (reseedPelotonToken && source === "garmin") {
    throw new SyncUsageError("--reseed-peloton-token needs --source peloton or all");
  }
  return {
    source: source as SyncArgs["source"],
    mode: refetch ? "refetch-streams" : full ? "full" : "incremental",
    ...(limit !== null ? { limit: Number(limit) } : {}),
    recomputeAll,
    reseedPelotonToken,
    help: false,
  };
}

/** The adapters a parsed `--source` runs. */
export function providersOf(source: SyncArgs["source"]): SyncProvider[] {
  return source === "all" ? ["garmin", "peloton"] : [source];
}

/** The `--refetch-streams` summary lines (AI-861): the counts, the error with what is left, the notes. */
export function formatRefetchResult(r: {
  candidates: number;
  refetched: number;
  failed: number;
  remaining: number;
  done: boolean;
  error: string | null;
  notes: readonly string[];
}): string[] {
  const lines = [`garmin refetch: candidates ${r.candidates}, refetched ${r.refetched}, failed ${r.failed}, done ${r.done}`];
  if (r.error !== null) lines.push(`garmin refetch stopped: ${r.error}; ${r.remaining} rides left, rerun to resume`);
  else if (r.remaining > 0) lines.push(`garmin refetch: ${r.remaining} rides left, rerun to continue`);
  for (const n of r.notes) lines.push(`  ${n}`);
  return lines;
}
