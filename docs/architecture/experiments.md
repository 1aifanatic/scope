# Experiments

Experiments are the canonical aggregate for deliberately composed benchmark
requests. A standalone request remains a permanent first-class workflow and
does not imply an Experiment. Every explicitly composed Experiment, including
one with a single request, uses the model described here.

## Aggregate model

An `ExperimentDocument` in `experiments` owns:

- stable `experimentId` and immutable `projectId`;
- bounded user metadata;
- `storageProfileVersion: "cosmos-mongo-2mb-v1"`;
- a monotonic `stateVersion`;
- the current immutable revision identity and fingerprints; and
- the only dispatchable execution, embedded as `execution`.

The revision records `experimentRevisionId`, `revisionNumber`, `memberCount`,
`membershipFingerprint`, and `definitionFingerprint`. PR A creates revision 1.
Changing membership belongs to the later membership-mutation contribution.

An execution records `experimentExecutionId`, attempt number, execution
version, the exact request/run vector, its fingerprint, compact handler
progress, blockers, timestamps, and supersession state. Archived executions
are immutable documents in `experiment-executions`.

Each vector entry is a bounded, non-recursive `ExperimentRequestState`:

```ts
interface ExperimentRequestState {
  requestId: string;
  runId: string;
  dependencies: ExperimentDependencyProjection[];
  blockers: ExperimentBlocker[];
}
```

Unknown API, queue, and persistence values are parsed before use. Raw chunk
documents are private to the shared Experiment storage modules.

## Fixed payload storage

Scope targets the universal Cosmos DB for MongoDB 2 MB document limit and does
not depend on 16 MB support. The `cosmos-mongo-2mb-v1` profile uses:

| Limit | Value |
| --- | ---: |
| Cosmos hard document limit | 2 MiB |
| Current root and bucket target | 256 KiB |
| Maximum encoded request entry | 4 KiB |
| Metadata reserve | target / 16 |
| Planning load factor | 0.8 |

The complete request vector is stored solely as
`FixedPayload<ExperimentRequestState>`. If the worst-case encoded root fits the
target, the vector is inline. Otherwise it is assigned to deterministic fixed
buckets.

Bucket assignment hashes the UTF-8 bytes of
`experiment-request-bucket:v1\0${requestId}` with SHA-256, interprets all 32
bytes as an unsigned big-endian integer, and applies modulo `bucketCount`.
`assignmentVersion` is `sha256-mod-v1`.

Layout selection starts at
`ceil(entryCount / maxEntriesPerBucket)`, recomputes the full distribution for
each ascending bucket count, and accepts the first count satisfying entry and
BSON budgets. If no bounded layout is safe, publication fails before the root
is finalized.

Chunk IDs are derived from the canonical JSON tuple:

```json
["sha256-v1", "projectId", "experimentId", "kind", "ownerId", 1, 0]
```

The SHA-256 digest is encoded as unpadded base64url with the `ec_v1_` prefix.
Every unhashed tuple field is stored and compare-and-swapped; a mismatched tuple
is an invariant failure. Chunk reads are point lookups by `_id`. Request entry,
dependency, blocker, payload, and wildcard indexes are intentionally absent.

The representation and bucket count are immutable within a published
execution. A new execution or future revision may independently choose inline
or chunked storage without in-place rebalancing.

## Creation and publication

`POST /api/v1/experiments?projectId=...` accepts either:

- `mode: "empty"` with no requests; or
- `mode: "compose"` with one or more complete request definitions.

The API generates the Experiment, revision, execution, request, and run IDs
before writing. It inserts the requests, prepares all vector chunks, writes the
pending root idempotently, verifies the complete payload set, and then
compare-and-swaps final publication. An empty Experiment is visible but not
dispatchable.

Requests created through this path carry recovery markers and `experimentId`.
An interrupted finalization can be repaired using the original exact run IDs.
A historical request that only carries an `experimentId` and has no parent
document remains correlation-only: clients may display the link, but the
API coordinator never reconstructs or triggers a new Experiment from it.

Ordinary `POST /api/v1/requests`, `scope run submit`, and `/runs/new` remain
supported. They never infer an Experiment.

## Processing and rollover

`run.handlerStatus` is authoritative. The API coordinator projects only the
named dependencies required by an Experiment handler for each exact
`{requestId, runId}` pair. Queue messages carry:

```json
{
  "type": "<registered experiment-handler selector>",
  "projectId": "...",
  "experimentId": "...",
  "experimentExecutionId": "...",
  "handlerId": "...",
  "handlerVersion": 1,
  "claimToken": "...",
  "executionVersion": 1
}
```

Claims and completions compare-and-swap the project, Experiment, execution,
execution version, handler version, and current state. Stale messages are
discarded. Workers must cooperatively recheck supersession before expensive
work and before publication.

When an exact run ID changes, or processing is manually retried, rollover:

1. claims the current root transition and makes it non-dispatchable;
2. freezes the old fixed payload;
3. archives the old execution and prepares its deterministic successor;
4. marks the successor prepared; and
5. publishes the new embedded execution with a final root compare-and-swap.

Unchanged request/run pairs preserve their dependency projections. Changed
pairs are reseeded from authoritative run state. Zero matched rows are
classified as stale work, bounded same-identity contention, or an invariant
failure rather than treated as success. Polling repairs missing projections,
vector drift, dropped retry notifications, and interrupted rollovers.

## Runtime ownership

The API owns `ExperimentCoordinator`, including projection, rollover,
readiness, retry, publication repair, and Experiment-handler dispatch policy.
Its poller is the durable recovery path and queue notifications are
optimizations, not correctness requirements.

The scheduler continues to own coding-agent and per-run handler dispatch. For
Experiment handlers it only applies exact claim/completion messages through
the shared `ExperimentStore` CAS primitives. Storage layout, routing,
fingerprinting, and state transitions remain reusable typed modules under
`packages/shared/src/experiments`; they contain no workflow policy.

The three collections have deliberately narrow ownership:

- `experiments` contains bounded current roots and the only dispatchable
  execution;
- `experiment-executions` contains immutable archived execution manifests;
- `experiment-chunks` contains private fixed-payload buckets addressed by
  deterministic `_id`.

Only repair/admin indexes are permitted on roots and archived manifests.
Chunks use point lookup by `_id`; entries, request IDs, dependencies, blockers,
payloads, and wildcard paths are never indexed.

## Public API

The Experiment API is project-scoped:

- `POST /api/v1/experiments`
- `GET /api/v1/experiments`
- `GET /api/v1/experiments/:id`
- `GET /api/v1/experiments/:id/executions`
- `GET /api/v1/experiments/:id/executions/:experimentExecutionId`
- `POST /api/v1/experiments/:id/retry`

Responses expose public readiness, blockers, handler progress, supersession,
and the current report pointer. Queue names, claim tokens, chunk identities,
and other scheduler internals are not public. Lists use stable cursors.

## Compatibility

The run-submission operation itself is not deprecated. Only composition inputs
that overlap Experiment creation are deprecated, under the shared
`legacy-request-composition` identifier. The API emits `Deprecation` and a
successor `Link` only when those inputs are present; there is no Sunset date.
CLI warnings and the Portal notice follow the same conditional rule.

The following successor-stack capabilities are intentionally deferred:

- PR B: built-in Experiment readout;
- PR C: existing-run membership mutation and later revisions;
- PR D: Experiment report templates;
- PR E: lifecycle cascade.

GEPA restacking is also outside PR A.
