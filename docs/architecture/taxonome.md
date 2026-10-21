# Taxonome: isolated taxonomy evaluation spike

Taxonome is a **standalone, draft experimental slice**, not the production
Observation model or a dependency on the Experiment stack. It evaluates two
behaviors from ATIF v1.7: Skipped Invocation (an Ax typed program through the
GitHub Copilot SDK) and Timeout (pure reviewed TypeScript). No Scope API, Judge,
database, Redis, queue, or token manager is required. Production integration,
the remaining taxonomy, narrative readout generation, and generated-code
execution are deliberately excluded.

The spike starts at `microsoft/scope:main` commit
`2101bd0d61c877caadb5c60d03056c67a0b08296`. It does not depend on #1206.
Technical evidence is for review, not authorization to merge or exit Phase 1.

## Build and run

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter taxonomy-evaluation build
pnpm --filter taxonome build
node apps/taxonome/dist/index.js run \
  packages/taxonomy-evaluation/fixtures/timeout.atif.json \
  --context packages/taxonomy-evaluation/fixtures/minimal-context.json \
  --elements beh-timeout
```

This deterministic example needs no token. The built CLI is also callable as
`pnpm -s taxonome ...` during development (preserving caller-relative paths); use the direct `node` entry point
when the entire process stdout must be JSON (pnpm prints its own banners).
Diagnostics/help go to stderr; evaluation failures have explicit JSON error
states and a nonzero exit status.

For prompt or mixed execution, set `COPILOT_GITHUB_TOKEN` in the process
environment. The CLI passes it explicitly as SDK `gitHubToken` and sets
`useLoggedInUser: false`; there is no GH_TOKEN or logged-in-account fallback.
Never put a token in a command-line flag or file. Use the same ledger file for
every run, eval, optimization, and replay in an experiment:

```bash
node apps/taxonome/dist/index.js eval \
  --cases packages/taxonomy-evaluation/fixtures/inputs.jsonl \
  --gold packages/taxonomy-evaluation/fixtures/gold.json \
  --split heldout --samples 2 --ledger /absolute/path/calls.jsonl
node apps/taxonome/dist/index.js optimize \
  --cases packages/taxonomy-evaluation/fixtures/inputs.jsonl \
  --gold packages/taxonomy-evaluation/fixtures/gold.json \
  --max-metric-calls 48 --output /absolute/path/optimized.json \
  --ledger /absolute/path/calls.jsonl
node apps/taxonome/dist/index.js eval \
  --cases packages/taxonomy-evaluation/fixtures/inputs.jsonl \
  --gold packages/taxonomy-evaluation/fixtures/gold.json \
  --split heldout --samples 2 --artifact /absolute/path/optimized.json \
  --ledger /absolute/path/calls.jsonl
```

`--model` defaults to pinned `gpt-5.6-sol-fast`; comparisons and saved artifacts
must use the same model. Pinning an ID is not a promise of a fixed hosted model
revision. Ax is pinned to 25.3.2, SDK to 1.0.1, bundled runtime to 1.0.63.
The SDK does not expose temperature/seed control for inference. The optimizer
seed controls its search, not hosted-model determinism.

The shared ledger durably reserves before submission. Its immutable maximum
is 500; failed and crash-interrupted reservations still count. Separate
instances/processes share exclusive filesystem locking and cannot reset a
ledger. A lock left by a crashed process fails closed and needs explicit
reconciliation, not automatic deletion. This is a per-experiment safety guard,
not an authorization system against a user intentionally choosing another
file. Keep the experiment ledger outside the checkout.

Ax repair retries are zero and each program evaluation has one step. A thin
typed `AxGen` subclass enforces these limits even when Ax BootstrapFewShot
supplies its own retry override. A custom Ax prompt template preserves the
immutable schema/trust wrapper for student and bootstrap-teacher execution;
GEPA reflection uses its own typed program, without observation formatting.
SDK error hooks request abort/no retries; model-failure events trigger abort.
Unexpected multiple model-attempt events are charged and stop that transport;
reconcile them before another experiment. SDK internals do not expose a
pre-attempt hook or guarantees about infrastructure retries; retain the event
ledger rather than claiming invisible service attempts were measured.

## API and deterministic authoring

The root entry point does **not import Ax or the SDK**. Prompt execution is
explicitly opt-in through `taxonomy-evaluation/copilot`.

```typescript
import { evaluate, evaluateElement, type DeterministicDefinition } from "taxonomy-evaluation";

const input = {
  atif: trajectory,
  context: { completeness: "complete", sources: [], timeout_policy: { threshold_ms: 1000 } },
};
const results = await evaluate(input, ["beh-timeout"]);

const definition: DeterministicDefinition = {
  id: "beh-timeout",
  kind: "deterministic",
  evaluate(input) {
    // An example authoring seam; the shipped detector uses structured call evidence.
    return { state: "indeterminate", reason: "This example has no timing detector." };
  },
};
const result = await evaluateElement(definition, input);
```

Single and mixed evaluation use the same API and validators. Definitions do not
contain executable source strings. Runtime execution does not import gold or
Vitest. Inputs are cloned before freezing; original ATIF fields, step IDs,
ordering, metrics, timing extensions, and call identities are preserved.

Co-located tests use the same ATIF/context case packet and assertion helpers
as model evals:

```typescript
import { expect, it } from "vitest";
import { evaluate } from "taxonomy-evaluation";
import { assertObservation } from "taxonomy-evaluation/cases";

it("explicit timeout", async () => {
  const [result] = await evaluate(input, ["beh-timeout"]);
  expect(assertObservation(result.result, expected)).toEqual([]);
});
```

Only the two registered identities are included; a generalized taxonomy
registration/store/export system is not part of this spike.

## Input and evidence contract

`run <atif>` accepts a local file or HTTP(S) ATIF JSON and a separate explicit
`--context` JSON. Files/downloads are bounded to 2 MiB. HTTP acquisition has
three bounded transient attempts, 10-second attempt deadlines, three
redirects, no HTTPS downgrade, and no token forwarding. Embedded URLs are
never fetched. Errors do not echo URL queries. ATIF v1.7 with text messages is
the supported slice; unsupported versions/shapes fail explicitly.

Evaluator context requires `completeness` (`complete`, `partial`, `unknown`)
and the supplied typed `sources` array (which may be empty). Optional
`applicability` explicitly excludes an element. Run/scenario/profile metadata
is optional for evaluation; it is required at the readout boundary. For
Skipped Invocation, the task must be available in recorded user turns or
explicit `scenario.task`. Source availability alone is not discovery.

Timeout reads namespaced evidence in `tool_calls[].extra`:

| Field | Meaning |
|---|---|
| `outcome` | `timeout`, `completed`, `error`, `abandoned`, or `pending` |
| `duration_ms` | Reliable measured duration, not a prose estimate |
| `started_at`, `ended_at` | ISO timestamps; contradictory/reversed timings are unknown |
| `progress_interrupted` | Explicit evidence that delay interrupted progress |
| `source_id` | Optional reference to a supplied typed source |

These are explicit supplemental evidence fields, not claims that every ATIF
producer exports them. Existing ATIF timings elsewhere are retained but not
guessed or silently normalized into this policy. An explicit timeout proves
an occurrence without a universal cutoff. Otherwise, duration at/above
`timeout_policy.threshold_ms` plus interruption/abandonment/pending evidence
proves a policy-bounded delay occurrence. Slow completion alone is not a
timeout. Missing/contradictory timing remains indeterminate; complete no-call
evidence is a negative. A proven timeout can survive partial evidence about
other calls because its existence is already established. Skipped Invocation
needs post-discovery run completeness to establish non-use.

## Structured contract and field review

Schema revision: `taxonome.observation.v1`. Category remains definition
metadata, derived by consumers. Confidence is rejected, not just omitted by
convention. The original schema-declared hypothesis is simplified, not a
mandatory second Boolean implementation:

The SDK does not expose native JSON-Schema constrained decoding here. Ax
declares/parses JSON in the prompt and the shared Zod schema validates it;
invalid results are explicit errors, never repaired by a second element call.

| Field | Producer and concrete consumer | Decision / simpler alternative |
|---|---|---|
| `schema_version` | Engine; artifact/replay compatibility | Keep in envelope, not each occurrence |
| `element_id` | Engine; report grouping | Keep; label/category are derivable definition metadata |
| `implementation` | Engine; review/provenance and zero-call accounting | Keep outside semantic result |
| `state` | Engine/detector; coverage denominators | Keep: completed absence must differ from unknown, excluded, and execution failure |
| `observed` | Detector; behavior frequency | Keep only for completed assessment; no null fake verdict |
| `occurrences[]` | Detector; repeated/source frequencies | Required nonempty only for positives; negatives omit it |
| `source {id,label,surface_id}` | Supplied context copied by detector; source grouping/display | Keep together per occurrence; known surfaces only; generic Timeout may omit it |
| `extension_point` | Skipped detector; exact unused artifact/tool | Keep for skipped invocation; a source can contain references |
| `discovery_turn` | Skipped detector; discovery ordering/drilldown | Keep; also serves as the turn reference, avoiding duplicate related-turn arrays |
| `related_turns`, `tool_call_id` | Timeout detector; call-level drilldown | Keep for Timeout; no fabricated extension/discovery fields |
| `reason` / `error` | Detector/executor; explain unassessed/failure | Conditional only; no generic success prose to scrape |
| `confidence`, output `category_id`, result `surface_id` | No necessary readout consumer | Remove/reject |
| `expected_invocation` | Can be reconstructed from explicit scenario/reference context | Omit from this narrow slice; no tested consumer needs generated advice |

For example, a completed negative is just
`{"state":"completed","observed":false}`. An unknown is
`{"state":"indeterminate","reason":"Post-discovery evidence is partial."}`.
Both avoid invented occurrence metadata.

## Cases, optimization, and readout

`fixtures/inputs.jsonl` and `gold.json` are separate: ordinary evaluation never
receives its expected output. Ax bootstrap requires labeled training examples
as supervised seed demonstrations, excluding the current query. The task
program strips output fields from its actual forward input. Validation and
heldout labels stay exclusively in the metric. Each row records a family, originating run, split, and
provenance. Loading rejects family/run leakage between train, validation and
heldout. Synthetic edges are clearly labeled. The reviewed haiku ATIF
reconstruction preserves the exact user/agent messages and token metrics
asserted by the committed post-processor WebSocket HAR test; it is a narrow
format/negative reference, not a sampled production benchmark. Broader
real-run generalization is not established by this packet.

Fixed assertions check state/polarity, cardinality, expected source/turn/call
identity and extension-point names. External schemas reject invented sources,
turns, call/source mismatches, duplicate occurrences, and forbidden metadata.
Unit tests additionally cover boundary timings, repeated sources, immutability,
timestamp shifts, unknown evidence, no-token execution, and CLI stdout/stderr.

The real Ax convenience optimizer is used, with bounded bootstrap plus GEPA,
not a renamed hand-written prompt search. Only training data may become
demonstrations; validation drives selection; heldout is never passed to the
optimizer. The complete Ax serialization, including demos/components and
statistics, is retained and restored with `applyOptimization`. Contract/model
hash mismatches fail instead of replaying against a changed baseline.
`maxMetricCalls` is not an all-in limit; student, teacher, retry, and replay
submissions all share the durable ledger.

Known Skipped Invocation preconditions are enforced before inference:
explicitly excluded assessments are inapplicable, and incomplete/unknown run
completeness or missing task evidence is indeterminate. These preflights make
zero calls and are reported separately from eligible prompt predictions.
Every eligible prompt evaluation makes exactly one SDK request. Explicit
Timeout positives are not blocked by the complete-run requirement.
Preflight-only cases remain in the functional regression/final packets but
are excluded from prompt optimization, which cannot improve an authoritative
metadata decision.

The SDK cannot apply Ax's temperature/token-limit hints. The adapter emits a
diagnostic and records `sdk-managed` sampling/low reasoning rather than
claiming these hints were applied. Ax optimization statistics are retained
verbatim, but their zero/default resource estimates are not actual usage;
the SDK event ledger is the usage authority.

`readout <results.json> --markdown preview.md` consumes an explicit array of
`{context:{run_id,scenario,profile},results:[...]}`. It produces deterministic
JSON plus optional Markdown: behavior and behavior/source frequencies,
distinct-run versus occurrence counts, total/assessed/unknown/excluded/error
coverage, and stable evidence drilldowns. Missing assessments count unknown;
duplicate runs/assessments fail rather than double-counting. This is not a
scorecard, fix list, narrative model call, or production readout v2.

## Recorded spike findings (2026-10-21)

**Recommendation: retain the simplified structured occurrence model for the
next review, and prefer the revised baseline prompt over the learned-demo
artifact for this packet.** This is not a production-model decision or phase
exit. A run-level Boolean cannot preserve the tested behavior/source frequency
and per-call drilldowns; adding confidence or repeated category metadata did
not solve a concrete consumer need.

All raw evidence is in
[`packages/taxonomy-evaluation/evidence/`](../../packages/taxonomy-evaluation/evidence/).
`manifest.json` records hashes, settings, per-phase usage, and the full
cumulative ledger. Model evals are distinct from the offline tests.

After the experiment was frozen, the implementation received a
behavior-preserving readability pass under the repository's code-readability
guidance. It renamed local variables, separated logical phases, documented
public and non-obvious contracts, and simplified control flow without changing
prompt text, schemas, fixtures, gold facts, recorded outputs, or the 256-call
ledger. The manifest preserves the evidence-generating source fingerprints and
records the later readability source revision separately; no model evidence
was regenerated for that source-only change.

| Experiment | Case result | Actual SDK requests | Interpretation |
|---|---:|---:|---|
| Original neutral-ID baseline, 18 cases twice | 33/36 | 36 | Two relevance/inapplicability confusions and one false certainty with unknown completeness |
| Original complete-artifact replay | 35/36 | 36 | Unknown-completeness mistake remained; preserved, not relabeled |
| Revised baseline, same regression packet twice | 36/36 | 30 | Six known metadata preflights; eight additional deterministic Timeout assertions also passed |
| Revised complete-artifact regression replay | 36/36 | 30 | Same assertions and preflight rules, no accuracy gain |
| Fresh final packet baseline, 6 cases twice | 12/12 | 10 | Two preflights plus two additional deterministic Timeout assertions |
| Fresh final packet complete-artifact replay | 12/12 | 10 | Candidate was fixed before either final comparison; no subsequent tuning |
| Actual opaque-ID renaming replay | 3/3 | 3 | Same gold source/turn facts after run/session ID changes |

The first packet became development/regression evidence once its validation
failures informed the wrapper/precondition revision. The separate final
packet was frozen at `dd19789a92f18254842ff1cafe3c912b563ce9ac`, is disjoint by
family/origin, and was never supplied to the optimizer. Six-row/two-repeat
synthetic results are functional evidence, not a statistical production
accuracy estimate. One negative format case reconstructs a reviewed repository
HAR fixture; these results do not establish broad real-run generalization.

The correction was **not an optimizer-only accuracy claim**: authoritative
completeness/exclusion belongs in the shared runtime. Eligible complete-run
prompts still decide task relevance/discovery/non-use. An irrelevant reference
is a completed negative, not an excluded assessment. No semantic gold facts
were weakened. Earlier contract artifacts remain archived; the current loader
deliberately rejects their old contract hash.

### What the real Ax experiment established

The pinned convenience API actually runs BootstrapFewShot followed by GEPA.
Both experiments used `maxMetricCalls: 48`, with one cumulative 500-call guard
covering student, bootstrap-teacher, reflection/proposal, and replay requests.
The first optimization used **50** real requests; the revised one used **49**
(44 student, 5 teacher), while its metric trace contains 47 entries.
This demonstrates why a metric budget is not an all-in call budget.

The revised selected artifact contains unchanged task-description/instruction
components, **three learned traces from two distinct training inputs**, and
five labeled training examples. All components, repeated traces, statistics,
and supervised examples are preserved exactly, then restored with
`applyOptimization` through the normal CLI. Repetition in Ax's cumulative
trace collection is not silently deduplicated. No validation/final examples
became demonstrations. With learned demos present, the pinned Ax replay renders
those three traces; the five supervised seeds remain serialized provenance,
not five additional replay demonstrations.
Ax's serialized `totalRounds: 30` is library metadata,
not evidence of 30 paid proposals; actual requests and metric traces are the
authoritative experiment record.

On the fresh final packet, mean input tokens/request rose from **691.8** to
**1790.8** with demonstrations, with no observed accuracy improvement. SDK
round-trip median was 1615ms baseline versus 1096ms replay in these sequential
samples. This was not a controlled cache/latency experiment; do not infer a
throughput advantage or causal speedup.

### Readout fitness and budget

The generated [`readout-preview.md`](../../packages/taxonomy-evaluation/evidence/readout-preview.md)
uses an actual restored mixed result plus a separate deterministic run, with
explicit matching scenario/profile context. Timeout occurs in **2 distinct
runs / 4 occurrences**. `account/query` contributes **2 runs / 3 occurrences**,
not 3 runs; `authctl` contributes 1 run / 1 occurrence. The unexecuted Skipped
Invocation assessment in the second run is counted unknown/missing, not
negative. JSON and Markdown come from the same deterministic consumer, without
another inference call or prose scraping.

The frozen all-in ledger ends at **256/500 requests** with 244 unused slots,
256 completion records, one observed model attempt per request, and usage
available for every request. Totals: **369886 input tokens**, **12161 output
tokens**, and an SDK cost-multiplier sum of 256. Dollar cost is unknown, not
zero. The two early proof calls (including the coordinator's) are included.
There are no unresolved reservations or observed transport failures; preserved
functional model mistakes are shown separately above. Tuning stopped because
the required technical evidence was complete, not because the budget ran out.

### Reproduce the review

Offline verification (no credentials/inference):

```bash
pnpm --filter taxonomy-evaluation build
pnpm --filter taxonome build
pnpm exec vitest run packages/taxonomy-evaluation/src apps/taxonome/src --reporter=default
pnpm --filter static-prompt-evals exec vitest run --config adapter/vitest.config.ts --reporter=default
node apps/taxonome/dist/index.js readout \
  packages/taxonomy-evaluation/evidence/readout-input.json \
  --markdown /tmp/taxonome-preview.md
```

Recorded final verification: **61 tests / 10 files** for the standalone slice,
**32 tests / 6 files** for the existing static-eval TypeScript suite; both
standalone builds/type checks and static-eval type checking passed. The latter
requires `pnpm --filter 'static-prompt-evals^...' build` first. License-header,
manifest coverage, and regenerated notice checks passed. The test suite also
restores the complete learned artifact offline and checks training-only
provenance and actual preview counts.

For a separately authorized live review, use the earlier `eval` commands
with `fixtures/final-inputs.jsonl`, `fixtures/final-gold.json`, and
`evidence/optimized.v2.ax.json`, an explicit token, and an external review
ledger. Do not modify the committed evidence ledger or treat a new file as
permission to reset the overnight budget.

## Production impact and limits

This package is not wired into Judge, API, Portal, or post-processing. If a
later accepted design adopts these findings, #1206 would need an explicit
occurrence-capable result union rather than one Boolean/criterion row per
run. Judge would host the core without changing its DAG/attempt protection;
persistence/export/UI would need conditional unassessed states, multiple
typed-source occurrences, stable ATIF references, schema versions and
compatibility for historical results. Readout consumers would derive category
and grouping metadata, never scrape prose or infer omitted findings.

Native Ax Flex-style executable-code optimization is not assumed. The required
Timeout implementation is reviewed TypeScript. No generated code is executed:
there is no approved credential-free/network-free isolated runner in this
spike, and `node:vm` is not one. Optional code optimization is not a gate.
