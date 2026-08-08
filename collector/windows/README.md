# TikFinity local collector

This Windows PowerShell collector connects to TikFinity at `ws://127.0.0.1:21213/`
and forwards only compact LIVE event payloads to the Render application.

Copy `collector-config.example.json` to `collector-config.json`, set the secret key and
stream username, then start `TikFinityCollector.ps1`. The status is written to
`collector-status.json` and a small rolling log is kept in `collector.log`.
