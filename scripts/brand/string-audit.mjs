// Brand string audit (§7.2). Scans user-visible surfaces for leftover
// product-self-reference strings ("DeepSeek Harness") and reports standalone
// provider mentions ("DeepSeek") as informational counts.
//
// Usage:
//   node scripts/brand/string-audit.mjs            # gate: exit 1 on residue
//   node scripts/brand/string-audit.mjs --report   # baseline report only
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Directories whose product-self-reference count must be zero. */
const GATE_SURFACES = [
  "apps/desktop",
  "apps/web",
  "packages/client",
  "packages/host",
  "apps/cli",
];

/** Always skipped: frozen vendor copy, build output, VCS, deliverable docs. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "lib", "dist", "out", "build",
  "coverage", "snapshots", "交付", ".agents",
]);

/** Whitelisted file names: upstream attribution must stay (plan §7.2). */
const WHITELIST_RE = /(^|[\\/])(LICENSE|THIRD_PARTY_NOTICES|COPYING)([.-]|$)/i;

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json",
  ".yml", ".yaml", ".html", ".css", ".svg", ".md", ".txt", ".toml",
  ".manifest", ".bat", ".ps1", ".sh",
]);

/** Product-self-reference residues: forbidden in gate surfaces after codemod. */
// DSH_HOME is intentionally kept as the compat env var (brand.json envHomeCompat).
const RESIDUE_RE = /DeepSeek[ _-]?Harness|dsh-otel-collector|download\.deepseek\.com/gi;

/** Provider mentions: kept legal (DeepSeek remains a configurable provider). */
const MENTION_RE = /DeepSeek/gi;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && TEXT_EXT.has(path.extname(entry)) && st.size < 2_000_000) yield full;
  }
}

const residues = [];
const mentions = new Map();
let filesScanned = 0;

for (const surface of GATE_SURFACES) {
  const abs = path.join(ROOT, surface);
  try { statSync(abs); } catch { console.error(`missing surface: ${surface}`); continue; }
  for (const file of walk(abs)) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    if (WHITELIST_RE.test(rel)) continue;
    filesScanned++;
    const text = readFileSync(file, "utf8");
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo++;
      RESIDUE_RE.lastIndex = 0;
      if (RESIDUE_RE.test(line)) {
        RESIDUE_RE.lastIndex = 0;
        for (const m of line.matchAll(RESIDUE_RE)) residues.push(`${rel}:${lineNo}: ${m[0]}`);
      }
      const n = line.match(MENTION_RE)?.length ?? 0;
      if (n > 0) mentions.set(rel, (mentions.get(rel) ?? 0) + n);
    }
  }
}

const totalMentions = [...mentions.values()].reduce((a, b) => a + b, 0);
console.log(`scanned ${filesScanned} files across ${GATE_SURFACES.length} surfaces`);
console.log(`provider mentions (informational, DeepSeek stays configurable): ${totalMentions} in ${mentions.size} files`);
console.log(`product-self-reference residues: ${residues.length}`);

if (residues.length > 0) {
  const byFile = new Map();
  for (const r of residues) {
    const f = r.slice(0, r.indexOf(":"));
    byFile.set(f, (byFile.get(f) ?? 0) + 1);
  }
  console.log("\ntop residue files:");
  for (const [f, c] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${c}\t${f}`);
  }
}

if (residues.length > 0 && !process.argv.includes("--report")) process.exit(1);
