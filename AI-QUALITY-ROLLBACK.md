# AI quality settings - 2026-11-19

## Before this release

- Live commit: `69355169699c993d114643ee262c289575dbaba0`.
- Live deploy: `dep-dbv8bbmq1p3s7385habg`.
- Backup branch: `rollback/before-ai-quality-20261119`.
- Source archive: `../viewer-before-ai-quality-20261119.zip`.

No database migrations or changes to listener, comment, stamp, gift, receipt,
or phone-counter records. Existing feed notes and custom layout settings stay.
The existing OpenAI key is reused, never committed, copied, or displayed.

## Switches and rollback

Settings > AI supplements > AI quality:

| Mode | Model | Reasoning | Output token ceiling | Timeout |
| --- | --- | --- | --- | --- |
| Fast (initial/previous behavior) | gpt-6-luna | none | 1800 | 25s |
| Balanced | gpt-6.1-terra | low | 3200 | 40s |
| Smart | gpt-6.2-sol | medium | 6000 | 60s |

- Select Fast to return to the exact previous request profile. The existing
  LIVE_AI_MODEL override continues to apply to Fast only.
- Selection is kept in this browser's local storage under
  `tiktok-live-ai-quality-v1` and applied when selecting/reopening a stream.
- The server validates the enum, scopes quality by session, separates mixed
  queues by profile and cancels pending old-profile work on explicit changes.
- Each AI note retains the mode that generated it. Exact calculations have no
  model attribution and remain free of AI calls in all three modes.
- Existing 600-call/24h and 180-call/hour process-local limits, authentication,
  masking, bounded queues and two-minute viewer lease remain unchanged.
- Balanced and Smart can consume substantially more credit, including reasoning
  tokens. Request-count limits are NOT dollar spending caps. No automatic credit
  reload or paid service is enabled by this release.
- Full rollback: revert this release's code or deploy the pre-release commit.
  Do not restore an old database snapshot or delete new listener records.

Model IDs, supported reasoning settings and relative token prices were checked
against the official OpenAI model documentation on 2026-11-19. All three models
were visible to the existing API key before implementation.
