/**
 * Per-section agreement analysis via bigram Jaccard similarity.
 *
 * Pure string math — no model calls. Used by the verify phase to quantify
 * where N diverge attempts agree (confident) vs disagree (hallucination risk).
 */

export interface SectionAgreement {
  label: string;       // section header or "¶1", "¶2", etc.
  score: number;       // 0–1 average pairwise bigram Jaccard
}

export interface AgreementResult {
  overall: number;                  // mean of section scores
  sections: SectionAgreement[];     // per-section breakdown
}

// ── Internals ─────────────────────────────────────────────────────

interface Section {
  key: string;    // normalized header for matching, or positional index
  label: string;  // display label
  body: string;   // section text
}

const HEADER_RE = /^#{1,4}\s+/m;

function normalizeKey(header: string): string {
  return header.toLowerCase().replace(/[^\w\s]/g, '').trim();
}

function extractSections(text: string): Section[] {
  const hasHeaders = HEADER_RE.test(text);

  if (hasHeaders) {
    const parts = text.split(/^(#{1,4}\s+.+)$/m).filter(Boolean);
    const sections: Section[] = [];
    for (let i = 0; i < parts.length; i++) {
      const match = parts[i].match(/^#{1,4}\s+(.+)$/);
      if (match) {
        const header = match[1].trim();
        const body = (parts[i + 1] ?? '').trim();
        sections.push({ key: normalizeKey(header), label: header, body });
        i++; // skip body part
      }
    }
    return sections.length ? sections : paragraphSections(text);
  }

  return paragraphSections(text);
}

function paragraphSections(text: string): Section[] {
  return text.split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map((body, i) => ({ key: String(i), label: `¶${i + 1}`, body }));
}

function wordBigrams(text: string): Set<string> {
  const words = text.split(/\s+/).filter(Boolean);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of smaller) if (larger.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function averagePairwiseJaccard(texts: string[]): number {
  if (texts.length < 2) return 1;
  const bigramSets = texts.map(wordBigrams);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < bigramSets.length; i++) {
    for (let j = i + 1; j < bigramSets.length; j++) {
      sum += jaccard(bigramSets[i], bigramSets[j]);
      pairs++;
    }
  }
  return sum / pairs;
}

// ── Public API ────────────────────────────────────────────────────

export function computeAgreement(outputs: string[]): AgreementResult {
  if (outputs.length < 2) return { overall: 1, sections: [] };

  const allSections = outputs.map(extractSections);
  const hasHeaders = allSections.some(ss => ss.length > 0 && ss[0].key !== '0');

  if (hasHeaders) {
    // Collect all unique section keys across attempts
    const keySet = new Map<string, string>(); // key → label (first seen)
    for (const ss of allSections) {
      for (const s of ss) {
        if (!keySet.has(s.key)) keySet.set(s.key, s.label);
      }
    }

    const sections: SectionAgreement[] = [...keySet.entries()].map(([key, label]) => {
      const bodies = allSections
        .map(ss => ss.find(s => s.key === key)?.body)
        .filter((b): b is string => b != null && b.length > 0);
      // Sections present in only one attempt get score 0
      const score = bodies.length < 2 ? 0 : averagePairwiseJaccard(bodies);
      return { label, score };
    });

    const overall = sections.length
      ? sections.reduce((s, x) => s + x.score, 0) / sections.length
      : 0;

    return { overall, sections };
  }

  // Positional matching for headerless content
  const maxSections = Math.max(...allSections.map(ss => ss.length));
  const sections: SectionAgreement[] = [];

  for (let i = 0; i < maxSections; i++) {
    const bodies = allSections
      .map(ss => ss[i]?.body)
      .filter((b): b is string => b != null && b.length > 0);
    const score = bodies.length < 2 ? 0 : averagePairwiseJaccard(bodies);
    sections.push({ label: `¶${i + 1}`, score });
  }

  const overall = sections.length
    ? sections.reduce((s, x) => s + x.score, 0) / sections.length
    : 0;

  return { overall, sections };
}
