/**
 * Node.js-specific exports for @lloyal-labs/rig
 *
 * These require node:fs and/or @lloyal-labs/lloyal.node.
 * Import from `@lloyal-labs/rig/node` only in Node.js environments.
 *
 * @packageDocumentation
 * @category Rig
 */

// Re-export everything from the platform-agnostic barrel
export * from './index';

// Node-only: Reranker factory (requires @lloyal-labs/lloyal.node)
export { createReranker } from './reranker';

// Node-only: Sources (require node:fs)
export { WebSource } from './sources/web';
export { CorpusSource } from './sources/corpus';

// Node-only: Resource loading (requires node:fs)
export { loadResources, chunkResources } from './resources';
