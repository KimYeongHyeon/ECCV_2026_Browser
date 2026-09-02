# Source adapters

Each conference owns one or more adapters that turn an official, snapshotted source into `data/source/records.jsonl`.

An adapter must:

1. cache the raw response under `data/snapshots/` with retrieval time and URL;
2. preserve the official source identifier and URL;
3. emit the normalized record contract in `data/records.schema.json`;
4. be idempotent and report additions, updates, removals, and parse failures;
5. never infer nationality or identity from a person's name.

Affiliation-based Korean discovery is allowed only when a public source explicitly identifies an institution or country. Keep the evidence URL on every affiliation.
