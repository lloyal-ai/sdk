import * as fs from "node:fs";
import * as path from "node:path";
import ignoreFactory = require("ignore");
import { loadBinary } from "@lloyal-labs/lloyal.node";
import type { Resource, Chunk } from "./types";

interface Section {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
}
const { parseMarkdown } = loadBinary() as unknown as {
  parseMarkdown(text: string): Section[];
};

/** Pattern accepted in glob inputs — tail must be `.md`, `.mdx`, or
 *  `.{md,mdx}` (with optional ordering / overlap variants). Anything else
 *  is rejected — the corpus only handles markdown. */
const ACCEPTED_GLOB_TAIL = /\.(md|mdx|\{(?:md|mdx)(?:,(?:md|mdx))*\})$/;

const GLOB_CHARS = /[*?[\]{}]/;

/** Split a path-with-glob into a `cwd` (everything up to the first glob
 *  character's nearest preceding `/`) + a `pattern` (the rest). Plain
 *  paths return `{ cwd: input, pattern: null }`. */
export function resolveCorpusInput(input: string): {
  cwd: string;
  pattern: string | null;
} {
  const m = input.match(GLOB_CHARS);
  if (!m) return { cwd: input, pattern: null };
  const idx = m.index ?? 0;
  const lastSep = input.lastIndexOf("/", idx);
  const cwd = lastSep > 0 ? input.slice(0, lastSep) : "/";
  const pattern = input.slice(lastSep + 1);
  return { cwd, pattern };
}

/**
 * Load documents into {@link Resource} objects.
 *
 * Accepts three input shapes:
 *
 * 1. **Single file** (`/path/to/foo.md`) — wrapped as one resource.
 * 2. **Directory** (`/path/to/docs`) — recursive `**\/*.{md,mdx}`. The
 *    `.gitignore` at the corpus root (if present) filters out vendored
 *    markdown (e.g. `node_modules`) the user already declared as
 *    ignored. To restrict to top-level only, pass `dir/*.md` explicitly.
 * 3. **Glob pattern** (`/path/to/docs/*.md`, `/path/to/docs/sub/**\/*.md`,
 *    etc.) — the user controls scope. The pattern's tail must end in
 *    `.md`, `.mdx`, or `.{md,mdx}` — other extensions are rejected
 *    because the corpus only handles markdown. Quote the pattern in
 *    your shell to prevent shell expansion.
 *
 * Honors `.gitignore` at the corpus root if present. No HDK-side opinions
 * about which directories to skip; just respect what's already declared.
 *
 * Resource names preserve the relative path from the corpus root so
 * nested files with the same basename don't collide.
 *
 * @category Rig
 */
export function loadResources(input: string): Resource[] {
  const { cwd, pattern: rawPattern } = resolveCorpusInput(input);
  let pattern: string;

  if (rawPattern) {
    // Glob input — validate extension, then use as-is.
    if (!ACCEPTED_GLOB_TAIL.test(rawPattern)) {
      process.stdout.write(
        `Error: only .md/.mdx files are supported. Got pattern: ${rawPattern}\n`,
      );
      process.exit(1);
    }
    pattern = rawPattern;
  } else {
    // Plain path — file or directory.
    if (!fs.existsSync(cwd)) {
      process.stdout.write(`Error: corpus not found: ${cwd}\n`);
      process.exit(1);
    }
    const stat = fs.statSync(cwd);
    if (stat.isFile()) {
      if (!/\.(md|mdx)$/.test(cwd)) {
        process.stdout.write(
          `Error: only .md/.mdx files are supported. Got: ${cwd}\n`,
        );
        process.exit(1);
      }
      return [
        { name: path.basename(cwd), content: fs.readFileSync(cwd, "utf8") },
      ];
    }
    // Directory: recursive walk. `.gitignore` is the user's declared
    // exclusion list (no HDK opinion baked in) — vendored markdown
    // already on the ignore list stays out. To restrict to top-level
    // only, the user passes `dir/*.md` explicitly.
    pattern = "**/*.{md,mdx}";
  }

  const gitignorePath = path.join(cwd, ".gitignore");
  const ig = fs.existsSync(gitignorePath)
    ? ignoreFactory().add(fs.readFileSync(gitignorePath, "utf8"))
    : null;

  const all = fs.globSync(pattern, { cwd }) as string[];
  const files = (ig ? all.filter((f) => !ig.ignores(f)) : all).sort();
  if (!files.length) {
    process.stdout.write(
      `Error: no .md(x) files matched: ${cwd}/${pattern}\n`,
    );
    process.exit(1);
  }
  return files.map((rel) => ({
    name: rel,
    content: fs.readFileSync(path.join(cwd, rel), "utf8"),
  }));
}

/** Split plain text into chunks on blank-line paragraph boundaries */
function chunkByParagraph(res: Resource): Chunk[] {
  const lines = res.content.split("\n");
  const chunks: Chunk[] = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || !lines[i].trim();
    if (blank && i > start) {
      const text = lines.slice(start, i).join("\n").trim();
      if (text) {
        chunks.push({
          resource: res.name,
          heading:
            text.slice(0, 60).replace(/\n/g, " ") +
            (text.length > 60 ? "\u2026" : ""),
          section: '',
          text,
          tokens: [],
          startLine: start + 1,
          endLine: i,
        });
      }
    }
    if (blank) start = i + 1;
  }
  return chunks;
}

/**
 * Split loaded resources into {@link Chunk} instances for reranking
 *
 * Uses native Markdown heading detection (via `parseMarkdown`) to produce
 * section-level chunks. Falls back to blank-line paragraph splitting for
 * resources with no headings (or fewer than 10 lines of content).
 *
 * @param resources - Resources to chunk (from {@link loadResources})
 * @returns Flat array of chunks across all resources, ready for {@link Reranker.tokenizeChunks}
 *
 * @category Rig
 */
/**
 * Build hierarchical section path from a heading stack.
 * Stack maps level → heading name. When a new heading at level N arrives,
 * pop everything above N and push the new one.
 */
function buildSectionPath(stack: Map<number, string>, level: number, heading: string): string {
  // Pop all levels deeper than current
  for (const k of Array.from(stack.keys())) {
    if (k >= level) stack.delete(k);
  }
  stack.set(level, heading);
  // Join all levels in order
  const parts: string[] = [];
  for (const k of Array.from(stack.keys()).sort((a, b) => a - b)) {
    parts.push(stack.get(k)!);
  }
  return parts.join(' > ');
}

export function chunkResources(resources: Resource[]): Chunk[] {
  const out: Chunk[] = [];
  for (const res of resources) {
    const sections = parseMarkdown(res.content);
    // Single section covering the whole file = no headings found -> paragraph split
    if (sections.length <= 1 && res.content.split("\n").length > 10) {
      out.push(...chunkByParagraph(res));
      continue;
    }
    const lines = res.content.split("\n");
    const headingStack = new Map<number, string>();
    for (const sec of sections) {
      const text = lines
        .slice(sec.startLine - 1, sec.endLine)
        .join("\n")
        .trim();
      if (!text) continue;
      const leaf = sec.heading || res.name;
      const section = sec.heading
        ? buildSectionPath(headingStack, sec.level, sec.heading)
        : res.name;
      out.push({
        resource: res.name,
        heading: leaf,
        section,
        text,
        tokens: [],
        startLine: sec.startLine,
        endLine: sec.endLine,
      });
    }
  }
  return out;
}
