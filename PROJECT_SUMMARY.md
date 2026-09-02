# Conference Atlas project summary

## Purpose

Conference Atlas turns a conference config, a metadata CSV, and optional PDFs into a static study browser. The browser supports scanning first and deeper reading second: searchable accepted records, source/asset links with an in-browser PDF viewer, semantic neighborhoods, trend cards, author collaboration, and citation overlap. The first build processes every input; later builds warm-start from caches.

## Architecture

```text
config/conference.json ┐
data/source/records.csv ─┬─> npm run build ──> docs/site/data artifacts ──> GitHub Pages browser
data/pdfs/*.pdf (Rust→wasm extractor) ┘
```

There is no backend or database. Vanilla browser modules load a small startup payload, then full type shards and advanced artifacts in the background. The build validates every artifact contract and pins cross-artifact fingerprints.

## Core data flow

1. `npm run build` loads the conference config and `records.csv` (or JSONL).
2. PDFs in `data/pdfs/` are matched by record id; a Rust→WebAssembly module extracts text, abstracts, and references (cached by content hash; unchanged PDFs are never re-parsed).
3. Missing abstracts are filled from PDF extraction; PDFs without rows become new records.
4. The semantic pipeline (TF-IDF → cosine kNN → seeded k-means → PCA) produces map positions, clusters, trends, and study features — deterministic and cached by corpus fingerprint.
5. Auto first-pass concepts feed the people-analytics artifact, which is fingerprint-pinned to the index manifest.
6. Reference extraction powers citation communities, bridge pairs, and shared foundations.
7. `npm run verify` checks every contract; the Pages workflow deploys `docs/` on push.

## Important modules

- `docs/site/app.js`: application orchestration and lazy loading.
- `docs/site/browse.js`, `records.js`: filtering, Unicode search, and record presentation.
- `docs/site/map-*.js`: semantic graph surfaces.
- `docs/site/topics-dashboard.mjs`: concept exploration.
- `docs/site/people-*.mjs`: author/collaboration analysis.
- `docs/site/references.js`: citation-overlap surface.
- `scripts/build.mjs`: records+PDFs to static artifacts, warm-start orchestration.
- `scripts/lib/pdf.mjs` + `rust/pdf-extract/`: PDF text extraction (wasm fast path, JS fallback).
- `scripts/verify.mjs`: artifact contract verification.

## Build and verification

```bash
npm run build      # ingest + semantic pipeline + all artifacts
npm run verify     # artifact contracts and fingerprint checks
npm test           # unit tests
npm run preview    # local site at http://localhost:8000/
```

The release gate is a successful build plus `npm run verify`; the Pages deploy workflow runs both before publishing. Advanced tabs always show either valid artifacts or an explicit unavailable state.

## Known extension points

- official source adapters (`adapters/`);
- SPECTER2 embedding import for dense query-side search (`scripts/import_search_embeddings.mjs`);
- human-reviewed concept artifact (replaces the auto first pass, same schema);
- affiliation-aware institution views;
- Korean UI copy and topic aliases.

The template intentionally does not generalize source collection prematurely. Each conference's publication platform and access constraints belong in its adapter and inventory.
