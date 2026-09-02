# Conference data inventory checklist

Complete this document before writing a full collector.

## 1. Conference facts

- official name, edition, dates, venue, city/country;
- configured timezone and source timezone;
- official site, program, registration, travel/visa, code of conduct;
- proceedings identifiers and expected publication dates.

## 2. Record populations

- accepted main-track papers by track;
- presentation types and schedule sessions;
- workshops and accepted workshop submissions;
- tutorials, keynotes, panels, competitions, and special days;
- withdrawn, rejected, duplicate, and late-added record rules.

## 3. Per-record fields

- stable IDs, title, abstract, authors, public affiliations;
- track, decision, presentation, day/time/room;
- official page, proceedings, review, PDF, poster, slide, project, code;
- source URL, retrieved time, raw snapshot hash, parse status.

## 4. Source matrix

For every upstream source record:

- authority and exact URL/API endpoint;
- authentication, robots, rate limit, pagination, and terms constraints;
- fields supplied and precedence over other sources;
- cache/snapshot policy;
- fallback when blocked or incomplete;
- change-detection strategy.

## 5. Audience localization

- Korean UI strings and search/topic aliases;
- KST schedule display;
- Korean institution matching from explicit affiliation evidence;
- Seoul/venue travel, visa, local transport, and community information;
- wording that distinguishes affiliation from nationality.

## 6. Derived artifacts

- title/abstract quality gate;
- embedding model, fingerprint, projection, clustering, neighbors;
- reviewed concepts and coverage threshold;
- author identity-resolution rule;
- reference extraction coverage and limitations.

## 7. Release gates

- adapter fixture test and snapshot provenance audit;
- normalized schema and duplicate-ID validation;
- build contract verification;
- browser QA for load, Korean/English search, filtering, details, links, mobile;
- explicit coverage counts and known gaps published with the snapshot.
