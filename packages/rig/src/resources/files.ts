import * as fs from "node:fs";
import * as path from "node:path";
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

/**
 * Load documents from a directory (or single file) into {@link Resource} objects
 *
 * If `dir` is a file path, returns a single-element array. If it is a
 * directory, reads all `.md` files within it. Exits the process with an
 * error message if the path does not exist or contains no Markdown files.
 *
 * @param dir - Absolute path to a directory of `.md` files or a single file
 * @returns Array of loaded resources with file name and content
 *
 * @category Rig
 */
export function loadResources(dir: string): Resource[] {
  if (!fs.existsSync(dir)) {
    process.stdout.write(`Error: corpus not found: ${dir}\n`);
    process.exit(1);
  }
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    return [
      { name: path.basename(dir), content: fs.readFileSync(dir, "utf8") },
    ];
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mdx") || f.endsWith(".mdx"));
  if (!files.length) {
    process.stdout.write(`Error: no .md(x) files in: ${dir}\n`);
    process.exit(1);
  }
  return files.map((f) => ({
    name: f,
    content: fs.readFileSync(path.join(dir, f), "utf8"),
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
    for (const sec of sections) {
      const text = lines
        .slice(sec.startLine - 1, sec.endLine)
        .join("\n")
        .trim();
      if (!text) continue;
      out.push({
        resource: res.name,
        heading: sec.heading || res.name,
        text,
        tokens: [],
        startLine: sec.startLine,
        endLine: sec.endLine,
      });
    }
  }
  return out;
}
