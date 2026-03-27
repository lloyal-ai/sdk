/**
 * Node.js-specific exports for @lloyal-labs/rig
 *
 * These require node:fs and/or @lloyal-labs/lloyal.node.
 * Import from `@lloyal-labs/rig/node` only in Node.js environments.
 *
 * Sources (WebSource, CorpusSource) are now platform-agnostic and
 * exported from the main `@lloyal-labs/rig` entry.
 *
 * @packageDocumentation
 * @category Rig
 */

// Re-export everything from the platform-agnostic barrel
export * from './index';

// Node-only: Reranker factory (requires @lloyal-labs/lloyal.node)
export { createReranker } from './reranker';

// Node-only: Resource loading (requires node:fs)
export { loadResources, chunkResources } from './resources';
