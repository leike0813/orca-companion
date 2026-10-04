# Graph basis performance evidence

Generated: 2026-10-04T11:24:14.836Z

Command: `node artifacts/graph-basis/benchmark.mjs --run` (exit 0)

Environment: Node v24.12.0, platform linux/x64; schema 17; build revision not captured.

Latency is measured from a real key written to the mounted production TuiApp stdin until Ink emits its next changed frame. Each viewport records 100 composer-input and 100 cached-version-navigation observations; large-body cases also record 100 cached body-page navigation observations. These are application input responses, not service/helper timings. Viewports are 120×40, 80×24, and 50×40. Cold first-page service read, complete metadata scan, scan RSS delta, and first 64 KiB body read are separate measurements.

| Dataset | Viewport | Input samples | App input p95 (ms) | Cached version navigation p95 (ms) | Cached body navigation p95 (ms) | Cold first page (ms) | Full scan (ms) | RSS delta (bytes) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000-versions | 120×40 | 100 | 25.452 | 23.419 | — | 1.935 | 30.797 | 1376256 |
| 1000-versions | 80×24 | 100 | 21.806 | 12.627 | — | 1.935 | 30.797 | 1376256 |
| 1000-versions | 50×40 | 100 | 14.59 | 18.704 | — | 1.935 | 30.797 | 1376256 |
| 10000-versions | 120×40 | 100 | 22.55 | 18.728 | — | 1.048 | 268.225 | 11927552 |
| 10000-versions | 80×24 | 100 | 19.598 | 13.751 | — | 1.048 | 268.225 | 11927552 |
| 10000-versions | 50×40 | 100 | 15.326 | 24.914 | — | 1.048 | 268.225 | 11927552 |
| 100000-versions | 120×40 | 100 | 22.19 | 17.391 | — | 0.766 | 2222.673 | 81887232 |
| 100000-versions | 80×24 | 100 | 20.69 | 13.762 | — | 0.766 | 2222.673 | 81887232 |
| 100000-versions | 50×40 | 100 | 13.06 | 18.115 | — | 0.766 | 2222.673 | 81887232 |
| 1-MiB-body | 120×40 | 100 | 22.489 | 19.577 | 16.479 | 0.597 | 24.962 | 229376 |
| 1-MiB-body | 80×24 | 100 | 16.366 | 15.149 | 12.626 | 0.597 | 24.962 | 229376 |
| 1-MiB-body | 50×40 | 100 | 14.707 | 20.336 | 16.325 | 0.597 | 24.962 | 229376 |
| 5-MiB-body | 120×40 | 100 | 30.134 | 20.643 | 19.422 | 0.787 | 36.38 | 0 |
| 5-MiB-body | 80×24 | 100 | 21.28 | 15.896 | 13.69 | 0.787 | 36.38 | 0 |
| 5-MiB-body | 50×40 | 100 | 17.437 | 20.212 | 14.332 | 0.787 | 36.38 | 0 |

## Body and scan details

- **1000-versions:** 1000 versions; 50 pages; full scan 30.797 ms; RSS 113491968 → 114868224 bytes (+1376256); body 0 bytes; first body range not applicable ms.
- **10000-versions:** 10000 versions; 500 pages; full scan 268.225 ms; RSS 394493952 → 406421504 bytes (+11927552); body 0 bytes; first body range not applicable ms.
- **100000-versions:** 100000 versions; 5000 pages; full scan 2222.673 ms; RSS 534499328 → 616386560 bytes (+81887232); body 0 bytes; first body range not applicable ms.
- **1-MiB-body:** 1000 versions; 50 pages; full scan 24.962 ms; RSS 684740608 → 684969984 bytes (+229376); body 1048576 bytes; first body range 3.65 ms.
- **5-MiB-body:** 1000 versions; 50 pages; full scan 36.38 ms; RSS 767651840 → 767651840 bytes (+0); body 5242880 bytes; first body range 3.491 ms.

## Limits

- Version rows are synthetic history records inserted into a temporary database after production schema migration and production v1 graph creation; this isolates directory scaling from 100,000 CAS transactions.
- Large body fixtures are valid normalized ImplementationPlan JSON, accepted by the production parser and padded through the plan title to exactly 1 or 5 MiB in the schema-17 initial-plan column.
- Input latency includes terminal event handling, production TuiApp state update, Ink rendering, and the next changed frame. It excludes terminal hardware flush and human-visible display scanout.
- RSS is process-wide and allocator/GC sensitive; the before/after delta is descriptive and may include unrelated runtime allocations.
- The report records no claim of isolated CPU unless no competing benchmark workload was active during the released slot.
