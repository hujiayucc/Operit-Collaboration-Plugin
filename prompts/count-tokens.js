"use strict";

/**
 * count-tokens.js
 *
 * Estimates token usage for every prompt file in this directory.
 *
 * Usage:
 *   node prompts/count-tokens.js
 *   node prompts/count-tokens.js --sort=tokens   # sort by token count (default)
 *   node prompts/count-tokens.js --sort=name     # sort alphabetically
 *   node prompts/count-tokens.js --detail        # show char/word/line breakdown
 *
 * Estimation method: cl100k_base / o200k_base approximation.
 * These tokenisers share the same rough heuristics:
 *   - ASCII punctuation and whitespace each count as ~1 token.
 *   - Common English words are mostly 1 token.
 *   - CJK characters are ~1.5–2 chars per token on average; we use 1.8.
 *   - Code identifiers and long words split into subword pieces.
 *
 * The estimator below uses a character-level approach that matches
 * OpenAI's rule-of-thumb: ~4 bytes ≈ 1 token for English, ~2 chars ≈ 1 token for CJK.
 * Results are approximate (±10–15%) and useful for relative comparison.
 */

const fs = require("node:fs");
const path = require("node:path");

const DIR = __dirname;
const ARGS = process.argv.slice(2);
const SORT_MODE = (ARGS.find((a) => a.startsWith("--sort=")) || "--sort=tokens").split("=")[1];
const SHOW_DETAIL = ARGS.includes("--detail");

// ── Token estimator ──────────────────────────────────────────────────────────

const CJK_RE = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f]/g;
const ASCII_WORD_RE = /[a-zA-Z0-9_\-./]+/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Estimates token count using a character-level heuristic.
 *
 * Strategy:
 * 1. Count CJK characters → each ≈ 1/1.8 tokens  (≈0.56 tokens per char).
 * 2. Count ASCII word-like runs → each word char ≈ 1/4 tokens.
 * 3. Non-word, non-CJK, non-whitespace chars → each ≈ 1 token (punctuation, symbols).
 * 4. Whitespace sequences → each sequence ≈ 0–1 tokens (absorbed into surrounding tokens);
 *    we count newlines at ≈0.3 tokens each and other whitespace as 0.
 */
function estimateTokens(text) {
  let tokens = 0;

  // CJK ideographs: ~1.8 chars per token
  const cjkMatches = text.match(CJK_RE) || [];
  tokens += cjkMatches.length / 1.8;
  const textWithoutCjk = text.replace(CJK_RE, "");

  // ASCII words / identifiers / numbers: ~4 chars per token
  const wordMatches = textWithoutCjk.match(ASCII_WORD_RE) || [];
  const wordChars = wordMatches.reduce((n, w) => n + w.length, 0);
  tokens += wordChars / 4;

  // Newlines contribute a small overhead
  const newlines = (text.match(/\n/g) || []).length;
  tokens += newlines * 0.3;

  // Non-word, non-CJK, non-whitespace (punctuation, brackets, operators)
  const nonWordNonCjk = textWithoutCjk.replace(ASCII_WORD_RE, "").replace(WHITESPACE_RE, "");
  tokens += nonWordNonCjk.length;

  return Math.round(tokens);
}

// ── File scan ────────────────────────────────────────────────────────────────

const promptFiles = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .sort();

if (promptFiles.length === 0) {
  console.error("No .md prompt files found in", DIR);
  process.exit(1);
}

const results = promptFiles.map((file) => {
  const fullPath = path.join(DIR, file);
  const text = fs.readFileSync(fullPath, "utf8");
  const lines = text.split("\n").length;
  const words = (text.match(/\S+/g) || []).length;
  const chars = text.length;
  const tokens = estimateTokens(text);
  return { file, lines, words, chars, tokens };
});

// ── Sort ─────────────────────────────────────────────────────────────────────

if (SORT_MODE === "name") {
  results.sort((a, b) => a.file.localeCompare(b.file));
} else {
  results.sort((a, b) => b.tokens - a.tokens);
}

// ── Output ───────────────────────────────────────────────────────────────────

const MAX_FILE_LEN = Math.max(...results.map((r) => r.file.length));
const header = SHOW_DETAIL
  ? `${"File".padEnd(MAX_FILE_LEN)}  ${"Tokens".padStart(7)}  ${"Chars".padStart(7)}  ${"Words".padStart(6)}  ${"Lines".padStart(5)}`
  : `${"File".padEnd(MAX_FILE_LEN)}  ${"Tokens".padStart(7)}`;
const sep = "─".repeat(header.length);

console.log();
console.log(header);
console.log(sep);

for (const r of results) {
  const row = SHOW_DETAIL
    ? `${r.file.padEnd(MAX_FILE_LEN)}  ${String(r.tokens).padStart(7)}  ${String(r.chars).padStart(7)}  ${String(r.words).padStart(6)}  ${String(r.lines).padStart(5)}`
    : `${r.file.padEnd(MAX_FILE_LEN)}  ${String(r.tokens).padStart(7)}`;
  console.log(row);
}

console.log(sep);
const totalTokens = results.reduce((n, r) => n + r.tokens, 0);
const totalLabel = "Total".padEnd(MAX_FILE_LEN);
const totalRow = SHOW_DETAIL
  ? `${totalLabel}  ${String(totalTokens).padStart(7)}  ${"".padStart(7)}  ${"".padStart(6)}  ${"".padStart(5)}`
  : `${totalLabel}  ${String(totalTokens).padStart(7)}`;
console.log(totalRow);
console.log();

console.log("Estimation method: cl100k_base heuristic (~4 chars/token for ASCII, ~1.8 chars/token for CJK).");
console.log("Accuracy: ±10–15%. Run with --detail for per-file char/word/line breakdown.");