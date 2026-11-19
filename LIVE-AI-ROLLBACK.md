# LIVE AI assist release - 2026-11-19

## Before this change

- Production commit: `e05d57e8e3ec4fe654b9bee83e493d4fd8f38e42`.
- Production deploy: `dep-dbv1v5mi0phs73c54pug`.
- Local rollback branch: `rollback/before-live-ai-20261119`.
- Source archive: `../viewer-before-live-ai-20261119.zip`.
- Work was isolated in `feature/live-ai-assist-20261119`.

This release changes no database schema and deletes or migrates no listener,
gift, visit, stamp, or receipt records. The daily AI analysis feature remains.

## Fast rollback

1. For layout only, Settings > Display > Screen layout > Custom (previous).
   Previous panel visibility, positions and sizes remain in browser storage.
2. For AI only, turn off the switch in the AI supplement header. This clears
   pending AI work and prevents late answers from being published. Other
   streams continue unchanged. The feed remains available until restart.
3. For all AI, set `LIVE_AI_DISABLED=true` in Render and deploy. Do not remove
   unrelated environment variables or restore an old database snapshot.
4. For code rollback, create a normal revert commit for this release (or use
   Render's previous live deploy artifact after checking current availability).
   Preserve new production records and inspect Render auto-deploy after rollback.

## AI data and limits

- OpenAI receives only sanitized comment text, per-batch ordinal numbers, and
  official law text when applicable. No viewer IDs, nicknames, stamps, receipt
  records, database connection strings, or admin credentials are sent.
- Basic emails, phone numbers, URLs, handles and API-key-like strings are masked.
  This is not a guarantee of removal of every kind of personal information.
- `store:false`; no AI response database table. Latest 60 notes per session in
  memory. Existing comment retention and records are unchanged.
- Admin authentication is required for both AI activation and feed reads.
- Queue maximum 40 globally / 16 per session, 6 comments per request, one request
  at a time, 25-second timeout, and 60-second API backoff for 401/403/429.
- 600 API calls in a rolling 24-hour window, 180 in an hour, across all sessions.
  Counters are process-local and reset on server restart. These are request
  safeguards, not a provider billing hard cap. No credit auto-reload is enabled
  by this release.
- Viewer activation expires after two minutes without authenticated viewer
  polling. Closing the browser cannot leave AI billing active indefinitely.
- Unchanged viewer polls return metadata only, not the full 60-note history.
- Old/initial comments are not backfilled. Repeated identical text is suppressed
  for two minutes. Overflow or API failure skips AI only, never original events.
- Pi digit questions use decimal.js for up to 1000 decimal places, explaining
  the convention. Recognized Japanese law article references fetch current
  e-Gov XML from an allowlist. Other unverified numeric/current/high-stakes
  answers must be labelled as requiring verification.
- The AI never sends TikTok replies or changes stamps, printing, or records.

## Secret handling

The newly issued OpenAI key is in the explicitly approved ignored `.env` file
in the sibling `viewer-rank-gift60-20261116` worktree, not in this worktree.
Production must use Render's secret environment variable `OPENAI_API_KEY`.
Never commit or log its contents. `.env` is excluded from Git and Docker builds.
