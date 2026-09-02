# Normalized record contract

The full machine-readable contract is `data/records.schema.json`. The following fields form the durable integration boundary.

## Identity and content

- `id`: stable upstream-derived identifier, namespaced when sources can collide.
- `type`: `paper`, `poster`, or `workshop`. Poster/oral/spotlight normally belong in presentation fields on a paper.
- `title`, `abstract`, `authors`.
- `group`, `category`, `categoryTags`, `areaTags`, `domainTags`.
- `searchAliases`: translated topic/institution aliases used by Unicode lexical search.

## People and institutions

- `authorAffiliations[]`: `author`, `institution`, optional stable `institutionId`, optional ISO 3166-1 alpha-2 `countryCode`, and mandatory `sourceUrl`.

Affiliations are evidence, not nationality. A Korean-targeted view may mean “publicly affiliated with a Korean institution”; it must not silently claim that an author is Korean.

## Schedule

- `presentationType`, `presentationLabels`, `session`, `roomName`.
- `startTime`, `endTime`: timezone-aware ISO 8601 strings when possible.
- Preserve the source timezone in the snapshot; convert display values with the configured timezone.

## Links and assets

- `sourceType`, `sourceUrl`, `sourceCheckedAt` are required provenance.
- `pageUrl`, `openreviewUrl`, `projectPageUrl`, `pdfUrl`.
- local asset fields and explicit availability status/reason.

## Semantic extensions

- map coordinates and cluster fields are derived artifacts, never official labels unless explicitly marked.
- reviewed concepts and references are separate versioned artifacts so they do not block the base browser.
