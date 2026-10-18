# Held combined release, October 17, 2026

Public-build support and typed events have been combined locally. This record
is verification evidence, not a publication or deployment record.

Validated: 132 Node tests.

The merge preserves public-key consent and inert-without-key behavior,
stable event IDs, typed event helpers and opt-in performance sampling.
JavaScript now defers performance listeners until consent; Android health
summaries carry the same deduplication IDs as other events.

Physical-device and live-service validation is not implied by these checks.
Publishing, tags, marketplace submission and deployments remain held pending
owner approval. Older README test counts describe their earlier branch runs;
this file records the combined candidate.

Remote config wave: 140 JavaScript tests passed, including eight config lifecycle/cache/multi-player/consent cases. ESM and regenerated CommonJS are both covered by the suite. Version 0.5.1 is a held local candidate, not published.

Config identifier compatibility audit: 9 focused Node config tests passed; the CommonJS distribution was rebuilt.
Config property keys reject constructor/prototype, including nested JSON properties.
Experiment keys and variant labels may use those words as string values, matching
the server contract. Regression coverage distinguishes those cases. Publishing remains held.

Player Reports follow-up: full Node suite rerun during local release preparation passes 153 tests. Includes immutable prepared images, stable retries, session changes, upload credentials and bounded screenshot capture. The earlier connected SDK/API/worker and real-browser capture checks are separate recorded evidence; live storage and device integration remain unverified. Version 0.5.1 remains held.
