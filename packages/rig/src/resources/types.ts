/**
 * @deprecated `Resource` and `Chunk` now live in
 * `@lloyal-labs/lloyal-agents` (RFC §6.3 — abstract chunking types
 * moved to agents to mirror the `Source` / `Tool` pattern: abstract
 * types in agents, concrete chunking factories in rig). This module
 * re-exports them so existing rig internal callers keep working
 * during the Phase 3-6 refactor window; new code should import
 * directly from `@lloyal-labs/lloyal-agents`.
 *
 * @packageDocumentation
 * @category Rig
 */

export type { Resource, Chunk } from '@lloyal-labs/lloyal-agents';
