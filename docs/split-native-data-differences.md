# Native data differences during split TUI verification

The immutable visual reference is the published
`@ephemeral-ai/mayfly@0.1.4-rc.2`, source commit
`f148e7045cc22a66e62c0cd5203f8eeca1368081`, running Harness `0.2.1-rc.2`.
The split candidate uses the installed official Harness `0.2.2-alpha.2`.
The comparison below comes from actual native Session events and persisted
projection values after the same isolated one-turn workflow. It does not infer
behavior from branch descriptions, a hand-written projection, or a screenshot.

See [split-parity-validation.md](./split-parity-validation.md) for the capture
identity, fixture isolation, and refusal to replace frozen reference grids.

## Evidence and reproduction

The initial expanded `panels` case submitted
`Say one line about this isolated replay.` to the deterministic model endpoint,
then opened the passive command surfaces. Both sides used the native `standard`
preset, the same clock, English, reduced motion, and disabled title generation.
The native Session storage and projection cache were retained in the isolated
artifact roots. Reading those files after process exit changes no runtime state.

The recorded run identifiers are:

| Runtime | Run under the verifier's `.artifacts/` directory |
| --- | --- |
| Published reference | `split-parity-verified/published-reference/runs/2d860772-254a-4c65-ad89-37fa03fa05dd` |
| Split candidate | `split-expanded-v2/panels/runs/3632e40a-4d0c-44cc-8daa-f13b7b2031d1` |

Each run contains native `sessions/**/session.v4.jsonl.zstd` and
`storages/session_projcache/sessions/*.json`. The local evidence directory
`native-data-trace/` contains extracted `*-snapshot.json`,
`*-request-summary.json`, and `*-system.txt` files. The snapshot summaries retain
the original source paths. These artifacts are diagnostic output, not shipped
fixtures or a replacement for the published reference.

The System event at sequence 7 contains the actual admitted system prompt.
`request/header` at sequence 12 contains the effective request configuration,
adapter-default markers, and tool schemas. `request/context` at sequence 13
contains the admitted context window. Projection cache sequence cursors differ
because rc.2 records its local command invocations as native Session events;
the initial model request is the same semantic checkpoint on both sides.

## Findings

| Native fact | Published rc.2 | Initial split candidate | Interpretation and required behavior |
| --- | --- | --- | --- |
| `request/context.contextWindow` | `1000000` | `1048576` | Official provider metadata changed upstream. Preserve the native value. A shared binary formatter consequently renders different text. |
| `contextPressure.contextWindow` | `1000000` | `1048576` | Confirms the panel receives the actual native projection, rather than a guessed catalog capacity. |
| `request/header.config.reasoningEffort` | `high` | `high` | Effective request behavior agrees. Restoring the reference footer on reopening is a frontend adaptation, while a first mount keeps the reference's default label. |
| `request/header.adapterDefaults.reasoningEffort` | `true` | `true` | Both requests inherited the adapter's default. Displaying the effective level must not convert it into an explicit model selection. |
| `modelSelection` state version | `2` | `3` | The new native fold deliberately omits an adapter-defaulted effort from `lastUsed`. An absent selection field no longer means the effective request lacks reasoning. |
| `modelSelection.lastUsed` | Flash with `reasoningEffort: high` | Flash without an effort field | Resolve effective display through native model metadata, or use the admitted request header when showing historical request behavior. Preserve the default/explicit distinction in controls. |
| `contextBreakdown.systemTokens` | `747` | `1438` | Includes both ordinary upstream guidance changes and an unintended Web-specific prompt contribution in the split Host. It is not a renderer rounding bug. |
| Actual system prompt length | `2971` characters | `5735` characters | Native `system/message` text confirms the changed input behind the heuristic token count. |
| `contextBreakdown.toolsTokens` | `5406` | `7790` | Native tool declarations differ across the versions/compositions. These are real schemas, not TUI content; never substitute the old count. |
| `contextBreakdown.messageTokens` | `5073` | `5116` | These are current native composition facts. Identical provider response text alone does not imply identical runtime context or request composition. |

The captured system texts have these SHA-256 digests:

```text
reference 026076278845df6ce09f9bad1c8210fe93604100f3c5f2fe3e16cecd77407c03
candidate e1596df801a90c0c33972e22c4d7f055dced86e5f75463b0320bbd7545c2f6c3
```

## Model window and default effort

The installed official `dsh-llm-deepseek` implementation declares
`OFFICIAL_CONTEXT_WINDOW = 1048576` for both official models. The rc.2 adapter
declared `DEFAULT_CONTEXT_WINDOW = 1e6` for those same entries. The candidate
adapter still has a generic `1e6` fallback, but its official catalog entries
override that fallback; reading the fallback constant alone gives the wrong
answer. The native request event and projection above confirm which value was
actually used.

The new `dsh-agent` implementation makes the effort distinction explicit:
`selectionOfHeader` drops `config.reasoningEffort` when
`adapterDefaults.reasoningEffort === true`. Its `modelSelection` projection is
version 3. The native DeepSeek model descriptor still exposes
`reasoning.defaultEffort`, which resolves to `high` for this configuration.
Therefore this is not a missing official API. The frontend can render the
effective level using the exact selected route's descriptor while preserving
the native selection as the authoritative write state. An already admitted
request's level is also available in public `request/header` events; no private
Agent access or second Session fold is needed to verify the claim.

The reference has a further presentation distinction. Its first mount of a new
Session shows the provider-default route without `High`; reopening that same
Session shows `High`. Native events prove that both displays concern the same
request header, and its persisted version-2 projection already contains
`lastUsed.reasoningEffort: high`. The reference footer caches its projection per
Session and refreshes that cache only through the projection change callback;
reopening reads a fresh snapshot. The difference is therefore a reference
mount-lifecycle display behavior, not a difference in admitted requests or a
missing native API.

The split frontend preserves that behavior with one mount-local provenance
flag: a newly attached Session with no recorded request leaves the default
effort suffix absent, while attaching an already used Session may recover the
effective request level from its header or exact Host catalog. Explicit native
effort selections update immediately, pending routes do not inherit another
request's effort, and every other projection remains live. The flag never
changes native selection state or turns a default into an explicit write.

## System prompt ownership

Two additions are ordinary upstream guidance: the delegation paragraph now
explains that waiting should end the turn, and the native
`deliverable-file-references` plugin provides file/image presentation guidance.
Those additions belong to the current Harness and should remain visible in its
native token composition.

The split Host also inherited `harness-dev-context` from `dsh-web-app`. That
plugin registers `harness:source` and `app:web-surface` sections and runtime
contexts. The latter tells the model that the person is using the DeepSeek
Harness Web GUI and gives instructions for rebuilding that GUI. A person using
the standalone Remote TUI is not using that surface. Retaining those paragraphs
is a split composition defect, even though their token count is native.

The narrow composition correction is to disable the official
`harness-dev-context` plugin row in the Mayfly Host patch. It removes its own
sections and contexts through ordinary Cordis composition while retaining the
native Web Host transport, authentication, file routes, services, and Remote
catalog. `web-runtime.surfaceContext` alone does not control the separately
registered plugin's sections. The corrected build needs a fresh native prompt
capture to prove that the Web-specific paragraphs are absent; resuming an old
Session is insufficient because admitted prompts are durable history.

The fresh `wave20` candidate at
`885c5fa4b2c7251bd978796d35c9a85e22002c50` verifies the correction. Its panels run
`split-wave20/panels/runs/76cf93da-f2da-4aa0-8921-54659d74ff41` records a new
sequence-7 system message with 4,404 characters, SHA-256
`4731039c0af1f140ab8ff8e176e86408bde1cb01132fd4a6bf1bf8c92bb712df`.
The actual admitted text contains neither the Web GUI instructions nor the
Harness checkout development paragraph. Its native `systemTokens` is 1,105;
the remaining delta from rc.2 is retained as upstream request data.

## Tool schema differences

The native request contains 27 tools in the reference and 32 in the initial
candidate. The candidate adds `list_subagent_models`, `plugin_manager`, and the
four `schedule_*` tools; `exit_plan_mode` is absent. Shared tool descriptions or
schemas also changed for `ask_user_question`, `present`, and `subagent`.
Upstream version and Host/preset composition both contribute to this delta, so
the total must not be attributed to one cause without checking the owning
native registrations. None of these counts should be copied into a frontend
fixture as fabricated projection data.

## Verification consequences

Raw captures must retain these differences and the immutable reference must
remain unchanged. Renderer equivalence for a data-bearing panel requires equal
native input facts. A separate controlled comparison may configure identical
provider model descriptors and native prompt/tool composition on both products,
provided those inputs enter through documented native configuration and the
new reference capture has its own provenance. It must retain the unmodified
default-composition results as evidence of actual product behavior.

Known official API limitations must remain explicitly labelled in their
command surfaces. The default-effort adaptation above is implementable with
existing native APIs and does not qualify for such a limitation. The observed
`/skills` metadata annotation is a separate limitation and must not be deleted
to make a screenshot compare pass.
