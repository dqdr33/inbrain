/**
 * Public barrel for the inbrain/ingestion subpath.
 *
 * Skillpack publishers import from here:
 *
 *   import { IngestionSource, IngestionEvent, computeContentHash } from 'inbrain/ingestion';
 *
 * Treat this surface as a versioned public API. Adding exports is a minor
 * release; removing or breaking-changing them is a major. Pinned by
 * test/public-exports.test.ts.
 *
 * The daemon itself is intentionally NOT exported — it's inbrain-internal.
 * Publishers run their sources via either:
 *   - the test harness (inbrain/ingestion/test-harness, for unit tests)
 *   - the CLI (`inbrain ingest test`, for hot-iteration dry-run)
 *   - the production daemon (`inbrain ingest`, which composes everything)
 */

export type {
  IngestionContentType,
  IngestionEvent,
  IngestionSource,
  IngestionSourceContext,
  IngestionSourceHealth,
} from './types.ts';

export {
  INGESTION_CONTENT_TYPES,
  INGESTION_SOURCE_API_VERSION,
  IngestionEventError,
  computeContentHash,
  validateIngestionEvent,
} from './types.ts';
