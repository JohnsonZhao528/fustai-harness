// Single reader for brand constants. All build scripts and desktop code must
// resolve brand values through this module instead of hardcoding strings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const brandDir = path.dirname(fileURLToPath(import.meta.url));
const brandJsonPath = path.join(brandDir, "brand.json");

const REQUIRED_KEYS = [
  "productName",
  "productNameShort",
  "company",
  "cliName",
  "npmScope",
  "pkgName",
  "appId",
  "homepage",
  "supportEmail",
  "updateFeed",
  "envHome",
  "envHomeCompat",
  "defaultHomeDir",
  "telemetryEnabled",
  "protocol",
];

/**
 * Parse `brand/brand.json` and verify every required key is present.
 * @returns {Record<string, string | boolean>} frozen brand constants
 * @throws {Error} when brand.json is missing a required key
 */
export function loadBrand() {
  const raw = JSON.parse(readFileSync(brandJsonPath, "utf8"));
  const missing = REQUIRED_KEYS.filter((k) => !(k in raw));
  if (missing.length > 0) {
    throw new Error(`brand/brand.json missing required keys: ${missing.join(", ")}`);
  }
  return Object.freeze(raw);
}

export { brandJsonPath };
