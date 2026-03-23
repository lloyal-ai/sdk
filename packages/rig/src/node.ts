/**
 * Node.js-specific exports for @lloyal-labs/rig
 *
 * These require node:fs, linkedom, @mozilla/readability, and/or
 * @lloyal-labs/lloyal.node. Import from `@lloyal-labs/rig/node`
 * only in Node.js environments.
 *
 * @packageDocumentation
 * @category Rig
 */

// Re-export everything from the safe barrel
export * from './index';

// Node-only: Reranker factory (requires @lloyal-labs/lloyal.node)
export { createReranker } from './reranker';

// Node-only: Sources (require node:fs + linkedom)
export { WebSource } from './sources/web';
export { CorpusSource } from './sources/corpus';

// Node-only: FetchPageTool (requires linkedom + @mozilla/readability)
export { FetchPageTool } from './tools/fetch-page';

// Node-only: Resource loading (requires node:fs)
export { loadResources, chunkResources } from './resources';
