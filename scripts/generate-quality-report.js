#!/usr/bin/env node
/**
 * Generate quality-reports/quality-metrics.json from the current codebase.
 *
 * Usage: node scripts/generate-quality-report.js
 *
 * Scans src/ for common quality signals and writes a timestamped report.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");
const OUT_DIR = path.join(ROOT, "quality-reports");
const OUT_FILE = path.join(OUT_DIR, "quality-metrics.json");

const THRESHOLDS = {
  max_function_lines: 30,
  max_long_functions: 3,
  max_missing_docs: 5,
  max_hardcoded_secrets: 0,
  max_todo_count: 10,
  max_empty_catches: 0,
};

function collectJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...collectJsFiles(full));
    } else if (entry.isFile() && /\.(js|mjs|ts)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function analyzeFile(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const lines = src.split("\n");

  let longFunctions = 0;
  let missingDocs = 0;
  let hardcodedSecrets = 0;
  let todoCount = 0;
  let emptyCatches = 0;

  // Simple function-length heuristic: count lines between function/handler start and closing brace
  let inFunc = false;
  let funcStart = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Count TODOs
    if (/\bTODO\b/i.test(line)) todoCount++;

    // Count empty catches
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) emptyCatches++;

    // Hardcoded secret patterns (API keys in string literals)
    if (/(sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|dsk-[A-Za-z0-9_-]{20,})/.test(line)) {
      hardcodedSecrets++;
    }

    // Simple function detection
    if (/^(export\s+)?(async\s+)?function\s+\w+/.test(line.trim()) || /handler:\s*async/.test(line)) {
      if (!inFunc) {
        inFunc = true;
        funcStart = i;
        braceDepth = 0;
      }
    }

    if (inFunc) {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0 && i > funcStart) {
        const funcLines = i - funcStart + 1;
        if (funcLines > THRESHOLDS.max_function_lines) longFunctions++;
        // Check if function had a JSDoc comment above it
        if (funcStart > 0 && !lines[funcStart - 1].trim().startsWith("*") && !lines[funcStart - 1].trim().startsWith("/**")) {
          missingDocs++;
        }
        inFunc = false;
      }
    }
  }

  return { longFunctions, missingDocs, hardcodedSecrets, todoCount, emptyCatches };
}

// Main
const files = collectJsFiles(SRC_DIR);
const totals = { long_functions: 0, missing_docs: 0, hardcoded_secrets: 0, todo_count: 0, empty_catches: 0 };

for (const f of files) {
  const r = analyzeFile(f);
  totals.long_functions += r.longFunctions;
  totals.missing_docs += r.missingDocs;
  totals.hardcoded_secrets += r.hardcodedSecrets;
  totals.todo_count += r.todoCount;
  totals.empty_catches += r.emptyCatches;
}

const pass =
  totals.long_functions <= THRESHOLDS.max_long_functions &&
  totals.missing_docs <= THRESHOLDS.max_missing_docs &&
  totals.hardcoded_secrets <= THRESHOLDS.max_hardcoded_secrets &&
  totals.todo_count <= THRESHOLDS.max_todo_count &&
  totals.empty_catches <= THRESHOLDS.max_empty_catches;

const report = {
  timestamp: new Date().toISOString(),
  pass,
  files_checked: files.length,
  metrics: totals,
  thresholds: THRESHOLDS,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + "\n");

console.log(`Quality report written to ${OUT_FILE}`);
console.log(`  Pass: ${pass}`);
console.log(`  Files checked: ${files.length}`);
console.log(`  Metrics:`, JSON.stringify(totals));

if (!pass) {
  console.error("Quality check FAILED — see report for details.");
  process.exit(1);
}
