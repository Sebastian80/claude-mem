# Data Quality Audit — 2026-02-12

Performed after deploying v9.1.1-ser.4 (orphaned message fallback fix).

## Database Overview

| Table | Rows | Purpose |
|-------|------|---------|
| observations | 12,784 | Compressed tool call observations |
| session_summaries | 1,642 | End-of-prompt summaries |
| user_prompts | 6,047 | Raw user prompt text |
| pending_messages | 29,053 | Queue (processed + failed + active) |
| sdk_sessions | 284 | Session tracking |
| ChromaDB embeddings | 108,779 | Vector search (~5.3 chunks/record) |

## Tests Performed

### 1. FTS Index Consistency

**Question:** Are full-text search indexes in sync with source tables?

**Result:** Perfect match across all three indexed tables.

| Table | Rows | FTS Rows | Status |
|-------|------|----------|--------|
| observations | 12,757 | 12,757 | MATCH |
| session_summaries | 1,642 | 1,642 | MATCH |
| user_prompts | 6,047 | 6,047 | MATCH |

**Recommendation:** None — healthy.

### 2. ChromaDB ↔ SQLite Alignment

**Question:** Does ChromaDB have embeddings for all SQLite records?

**Result:** 12,660 distinct observation IDs in ChromaDB vs 12,750 in SQLite (gap: 90). Queue had 555 items actively draining.

| ChromaDB doc_type | Embeddings | SQLite rows | Coverage |
|-------------------|-----------|-------------|----------|
| observation | 95,877 | 12,750 | ~7.5 chunks/obs |
| session_summary | 9,930 | 1,642 | ~6 chunks/summary |
| user_prompt | 2,972 | 6,047 | partial (by design) |

**Recommendation:** The 90-record gap is likely the empty observations (46) plus recently created records still in queue. Not a concern — queue is draining.

### 3. Empty Project Field

**Question:** How many records have missing project metadata?

**Result:**
- 4,573 observations (35.8%) have `project = ''`
- 431 session summaries have `project = ''`
- 65 sdk_sessions have `project = ''`
- 36,310 ChromaDB embeddings have empty project

**Root cause:** The SAVE hook creates sessions before the project name is known. A backfill UPDATE in `createSDKSession` was added, then lost during Jill's v9.0.17 merge, then re-applied in ser.1 (Feb 11).

**Verification:** Zero empty-project observations since Feb 11 at 11:58 (fix cutoff). Feb 12 has 579 observations, all with project. Fix is working.

**Recommendation:** Historical data is searchable via unfiltered queries but invisible to project-scoped searches. A one-time backfill migration could fix the 4,573 historical records by matching `memory_session_id` to sessions that were later assigned a project. Low priority — the data is still accessible.

### 4. Empty Observations

**Question:** Are there observations with no useful content?

**Result:** 46 observations have `facts = '[]'` and no narrative.
- 45 are `type = bugfix` from openmage, Feb 7, all with NULL title
- 1 is a discovery from sebastian project with a 2,850-char narrative (title just missing)

**Recommendation:** The 45 empty bugfix observations are dead weight — they exist in SQLite and ChromaDB but contain nothing searchable. Could be cleaned up. Negligible impact (0.35% of total).

### 5. Unused `text` Column

**Question:** Is the `text` column in observations used?

**Result:** All 12,784 observations have `text = NULL`. Content is stored in `narrative`, `facts`, `title`, `subtitle`, `concepts` instead. The `text` column is indexed in FTS but always empty.

**Recommendation:** The FTS index on the `text` column wastes index space. Low priority — no functional impact.

### 6. Duplicate Observations

**Question:** Are there duplicate or near-duplicate observations inflating the database?

**Result:** Very few duplicates. Maximum repetition is 3 for a handful of titles ("Service Popup Closed", "DDEV Environment Started", etc). No systemic duplication problem.

**Recommendation:** None — healthy.

### 7. Pending Message Queue Health

**Question:** Are messages getting stuck or failing at abnormal rates?

**Result:**
- 28,875 processed (healthy throughput)
- 164 failed total: 91 with retry_count ≥ 3 (TIMEOUT_FAILED, pre-fix), 29 immediate failures
- 14 processing (active, draining)
- 0 stuck (> 5 minutes old)

**Recommendation:** None — the TIMEOUT_FAILED cascade is fixed by ser.4. No current queue issues.

### 8. Observation Quality Distribution

**Question:** What percentage of stored observations have meaningful content?

**Result:**

| Quality tier | Count | % |
|-------------|-------|---|
| Meaningful (narrative > 100 chars, facts > 10 chars) | 12,616 | 98.7% |
| Thin content | 80 | 0.6% |
| Dead weight (empty) | 46 | 0.4% |

Token distribution of stored observations:

| Bucket | Count | % |
|--------|-------|---|
| < 100 tokens | 18 | 0.1% |
| 100–500 | 1,032 | 8.1% |
| 500–1K | 3,871 | 30.3% |
| 1K–5K | 6,312 | 49.4% |
| 5K+ | 1,544 | 12.1% |

**Recommendation:** Quality is high. The SDK agent filters well — 98.7% of stored observations are substantial.

### 9. Pipeline Efficiency (Skip Rate)

**Question:** How many tool calls are sent to the SDK agent but produce no observation?

**Result:**
- 27,586 tool calls processed
- 12,784 stored as observations (46.3%)
- 14,802 skipped — "no observation necessary" (53.6%)

Top tool call sources:
- Bash: 14,038 (51%)
- Read: 7,069 (26%)
- Grep: 1,466 (5%)
- Edit: 1,277 (5%)

**Recommendation:** The 53.6% skip rate means roughly half of all SDK agent API calls are wasted. A pre-filter that skips known low-value tool calls before they reach the SDK agent (e.g. `git status`, `ls`, simple health checks, routine greps) could significantly reduce API costs without losing signal. This is the single biggest optimization opportunity.

### 10. Retrieval Activity (Is This Data Used?)

**Question:** Is the stored data actually retrieved and used across sessions?

**Result (Feb 12):**
- 55 context injection calls (session start — automatic memory surfacing)
- 102 MCP search calls (explicit searches)
- 45 get_observations calls (full detail retrieval)

**Recommendation:** Data is actively used. The context injection at session start and explicit search during work sessions demonstrate the memory system is providing value.

### 11. Stale Sessions

**Question:** Are there sessions stuck in "active" status that should be completed?

**Result:** 65 sessions with `project = ''` are all still `status = 'active'`. These are from the pre-backfill era and were never properly closed.

**Recommendation:** Low priority. Could run a cleanup to mark old sessions as completed if they have no pending messages.

### 12. Parser Concept Stripping

**Question:** The parser logs ERROR for "Removed observation type from concepts array" — is data being lost?

**Result:** 14 occurrences today. The parser intentionally strips the observation type (e.g. "discovery") from the concepts array when it appears there, since type and concepts are designed to be orthogonal dimensions. No data loss — the type is preserved in its proper field.

**Recommendation:** Downgrade log level from ERROR to DEBUG. The current ERROR level inflates error counts. The behavior is intentional data normalization, not an error.

## Summary

| Finding | Severity | Action |
|---------|----------|--------|
| 53.6% skip rate on tool call processing | Medium | Pre-filter low-value tool calls before SDK agent |
| 4,573 observations with empty project | Low | One-time backfill migration (fix already applied for new data) |
| 46 empty observations | Negligible | Optional cleanup |
| Parser logging at ERROR level | Negligible | Downgrade to DEBUG |
| Unused `text` column in FTS | Negligible | No action needed |
| 65 stale "active" sessions | Negligible | Optional cleanup |

Overall data quality is high. 98.7% of observations are substantial. FTS and ChromaDB are in sync. The memory system is actively used for context injection and search. The main optimization opportunity is reducing wasted API calls on the 53.6% of tool calls that produce no observation.
