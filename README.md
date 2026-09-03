# Conference Atlas Template

Reusable, backend-free conference paper/workshop browser. **Drop in a conference config, a metadata CSV, and optional PDFs — `npm run build` produces the full browsing site**: paper list, semantic map, search, trends, author analytics, references, and an in-browser PDF viewer. Extracted from the ICML Atlas 2026 codebase; used as-is by KDD Atlas 2026.

No databases, no API keys, no Python, no packages to install. The build uses only Node.js built-ins (Node ≥ 18) plus a bundled Rust→WebAssembly extractor for PDF text.

## What you provide

Everything lives under three paths. The first build processes them; later builds warm-start (unchanged inputs are never re-processed).

### 1. `config/conference.json` — conference identity (required)

```json
{
  "slug": "icml-2026",
  "name": "ICML 2026",
  "atlas_title": "ICML Atlas 2026",
  "year": 2026,
  "locale": "en",
  "timezone": "Asia/Seoul",
  "repository": "KimYeongHyeon/ICML_2026_Browser",
  "official_url": "https://icml.cc/",
  "public_note": "Unofficial browser built from cited public sources."
}
```

| Field | Required | Purpose |
|---|---|---|
| `slug` | yes | Internal identifier (lowercase-with-dashes) |
| `name` | yes | Human-readable conference name (aria labels) |
| `atlas_title` | yes | Site `<title>` and header `<h1>` (set by `npm run build`) |
| `year` | yes | Conference year shown in analysis labels |
| `locale` | yes | `<html lang>` value (`en`, `ko`, …) |
| `timezone` | yes | IANA timezone for schedule display (e.g. `Asia/Seoul`) |
| `repository` | yes | `owner/repo` used for artifact provenance |
| `official_url` | yes | Official conference site (linked in the header) |
| `public_note` | no | Disclaimer text |

### 2. `data/source/records.csv` — one row per paper/workshop (required)

This is the minimal metadata the site needs. Only `title` is strictly required — everything else improves the experience. Columns (semicolon `;` separates lists):

| Column | Required | Fills |
|---|---|---|
| `id` | auto | Stable record id. Generated from `pdf_file` or slugified title when omitted |
| `title` | **yes** | Paper list, map, search |
| `abstract` | recommended | Semantic map clustering, trends, study trails, search quality. If empty, the build extracts it from the PDF |
| `authors` | recommended | Author directory, collaboration map. Semicolon-separated: `Alice Chen; Byeongho Park` |
| `type` | auto | `paper` (default), `poster`, or `workshop` |
| `group` | auto | Session grouping (e.g. `Main Conference`, `Workshop`) |
| `category` | auto | Filter chip + map color. Defaults to first keyword or `Other` |
| `keywords` | recommended | Category/tag filters, cluster labels. Semicolon-separated |
| `pdf_file` | recommended | `data/pdfs/` filename for this record (see below) |
| `page_url` | no | Official page linked from the detail panel |
| `doi` | no | Renders a https://doi.org link |
| `session`, `room`, `start_time`, `end_time` | no | Schedule display (times in the source timezone) |
| `presentation_type` | no | `Oral`, `Poster`, `Spotlight` — filter pills |
| `decision` | no | Acceptance decision text |
| `search_aliases` | no | Extra search terms (e.g. Korean aliases): `긴 문맥 언어모델` |

Do not put private data (emails, reviewer identities) in this file — the build refuses to publish email-like strings.

### 3. `data/pdfs/*.pdf` — paper PDFs (optional but recommended)

Name each file `<recordId>.pdf` (the `id` or `pdf_file` column). The build:

- copies it to `docs/pdfs/` so the site's built-in PDF viewer serves it;
- marks the record as `Downloaded` with a "Preview PDF" action;
- **extracts the abstract** when the CSV row has none (best-effort, first-page heuristic);
- **extracts the references** (bibliography) and turns them into the References view: citation communities, bridge pairs, shared foundations, and per-paper citation overlap.

PDFs without a matching row become new records automatically (title/abstract best-effort from the PDF), so a bare folder of PDFs can bootstrap a corpus. Extraction runs inside a bundled Rust→WebAssembly module (deterministic, no subprocess); PDFs with exotic font encodings may extract sparsely — the record still works with whatever metadata you provided, and failures are reported, never fatal. Keep total PDF size reasonable: everything under `docs/` is published to GitHub Pages.

### 4. `data/source/references.jsonl` — override extracted references (optional)

One JSON object per line for full control over the References view:

```json
{"recordId": "demo-llm-1", "references": [{"title": "Attention Is All You Need", "year": "2017"}]}
```

Rows here are merged over PDF-extracted references for the same `recordId`.

## Quickstart

```bash
npm run build      # ingest CSV + arXiv metadata, semantic pipeline, all artifacts
# (PDFs in data/pdfs are detected automatically on rebuild; add --local-pdfs to
#  wire them into the in-browser viewer for local preview — deployed sites
#  link arXiv/official PDFs instead to stay under the Pages size limit)
npm run verify     # validate artifact contracts and fingerprints
npm run preview    # serve the site at http://localhost:8000/
```

From template to live site:

1. Create a repository from this GitHub template (Pages deploy workflow included — it publishes `docs/` on every push to `main`).
2. Edit `config/conference.json`.
3. Replace `data/source/records.csv` with your rows; drop PDFs into `data/pdfs/`.
4. `npm run build && npm run verify`, commit, push. GitHub Actions deploys the site.

## Warm start (incremental builds)

| Input state | What happens |
|---|---|
| Unchanged PDF | Reuses its extraction cache (`.cache/atlas/pdf/<sha256>.json`) — never re-parsed |
| Unchanged corpus text | Reuses cached semantic artifacts (vectors/clusters/positions) |
| Unchanged config + records + PDFs | Keeps the previous `generatedAt`, so published fingerprints stay stable and the rebuild is nearly a no-op |
| Any change | Only the affected stages re-run; `npm run build -- --force` rebuilds from scratch |

Commit `.cache/` nowhere — it is machine-local and gitignored.

## What the build produces (`docs/site/data/`)

| Artifact | Feeds |
|---|---|
| `conference_index.manifest.json` + `conference_startup.json` + `shards/*.json` | Paper/workshop lists with incremental loading |
| `conference_map.json` | Semantic map: TF-IDF vectors, cosine kNN, deterministic k-means clusters, PCA layout |
| `conference_search_embeddings.json` | Dense map-search index. Ships as an in-browser hashed lexical index — no downloads, works offline. Import SPECTER2 vectors to upgrade query matching |
| `conference_trends.json` | Trend cards per cluster (summary, keywords, representative papers) |
| `conference_study_features.json` | Study trails, compare candidates, topic lenses, outliers |
| `concepts/conference_concepts.json` | Auto first-pass research concepts (reviewed artifacts can replace it — same schema) |
| `analysis/conference_people_topics.json` | Author directory, collaboration map, topic trends — fingerprint-pinned to the index |
| `references/manifest.json`, `insights.json`, `records/*.json` | Citation-overlap analysis from extracted bibliographies |

The first pass runs entirely locally and deterministically: field-weighted TF-IDF (titles count more than abstracts) + cosine kNN + seeded k-means refined by kNN majority voting + power-iteration PCA. Map search is dense out of the box: documents and queries are embedded in the browser with the same hashed lexical vectorizer, so search works offline with no model download. Importing SPECTER2 vectors replaces the doc index and the query side upgrades automatically — no code changes:

```bash
node scripts/import_search_embeddings.mjs --input specter2_vectors.json
# {"model": {"id": "benchoi93/specter2-base-onnx-web"}, "records": [{"id": "...", "vector": [...]}, ...]}
```

## Stable boundary

- `config/conference.json` — conference identity, locale, timezone, repository, official URL.
- `data/records.schema.json` — normalized public record contract (JSONL details in `data/source/records.example.jsonl`).
- `data/source/records.csv` — source-independent metadata consumed by the static build.
- `adapters/` — conference-specific official-source collectors (Whova, OpenReview, ACM, CVF, virtual sites). The adapter is the only piece that should know about upstream platforms.
- `scripts/build.mjs` — deterministic records+PDFs to static-artifact build.
- `docs/` — GitHub Pages application.

## Data policy

- Preserve source URLs and retrieval timestamps.
- Snapshot raw upstream responses outside the published site.
- Represent missing assets explicitly; do not drop otherwise valid records.
- Do not infer nationality, ethnicity, gender, or identity from names.
- For Korean-targeted views, use public affiliation/country evidence and retain the evidence URL.
- Keep KST display separate from the source timezone value.
- The build refuses to publish email addresses or private identity data.

See [the project summary](PROJECT_SUMMARY.md), [the normalized contract](docs/NORMALIZED_RECORD_CONTRACT.md), and [the inventory checklist](docs/DATA_INVENTORY_TEMPLATE.md).
