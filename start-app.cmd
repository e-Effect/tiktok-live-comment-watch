@echo off
cd /d "%~dp0"
set PORT=3053
start "" "http://localhost:%PORT%"
echo TikTok LIVE app is running at http://localhost:%PORT%
echo Keep this window open while using the app.
node server.js
pause
