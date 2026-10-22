# S1: SQLite in a utility process

**Result: pass.** `node:sqlite` is the database for `chord-data` (ARCHITECTURE.md §2). better-sqlite3 stays an unused fallback.

Run on 2026-10-22, Windows 11 x64, Electron 45.0.0 (Node 24.22.0), with `spikes/s1-sqlite/`:

| Check | Result |
|---|---|
| `node:sqlite` loads in `utilityProcess` | yes |
| SQLite version | 3.53.4 |
| FTS5 compiled in | yes |
| `STRICT` tables | yes |
| WAL journal | yes |
| Insert 50,000 rows (one transaction) | 370 ms |
| FTS5 prefix query, bm25-ranked, `LIMIT 20`, over 50k rows | 1.8–6.1 ms |

The slowest queries were single broad prefixes (`ch*`) that match about 1 in 20 rows. The command bar therefore queries history only from the second character on, and ranks by frecency before bm25 if p95 drifts above 5 ms with real data.

**Still to confirm:** the same run on macOS and Linux. It becomes a CI test when `chord-data` lands in M1.1.
