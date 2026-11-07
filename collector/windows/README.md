# TikFinity Windows収集ツール

Windows PowerShell 5.1でTikFinityの `ws://127.0.0.1:21213/` に接続し、必要なLIVEイベントをサーバーへ転送します。
`collector-config.example.json` を `collector-config.json` にコピーし、送信先・収集キー・配信ユーザー名を設定してください。
キーをGitHubやスクリーンショットへ公開しないでください。

## 更新前のバックアップ

実行中の収集ツールのPowerShell画面で **Ctrl+C** を押して停止します。収集フォルダーの一つ上で、次を実行してフォルダー全体を保存してください（例のフォルダー名は実際の名前に置き換えます）。

```powershell
$collectorFolder = Resolve-Path '.\windows'
$backupFolder = "$collectorFolder-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item -LiteralPath $collectorFolder -Destination $backupFolder -Recurse
```

更新はソースファイルだけを上書きします。既存の `collector-config.json`、`collector-roomuser.json`、`collector-pending.jsonl`、`receipt-pending.jsonl`、`delivery-failures.json` を削除・置換しないでください。未送信イベントや再送待ち時間を保持します。

## ランキング由来の来訪・推定滞在の有効化

この追加機能は初期状態では無効です。`collector-roomuser.example.json` の `enabled` と `trackStay` はともに `false` です。
収集フォルダーでPowerShellを開き、設定がまだなければコピーします。

```powershell
if (-not (Test-Path -LiteralPath '.\collector-roomuser.json')) {
    Copy-Item -LiteralPath '.\collector-roomuser.example.json' -Destination '.\collector-roomuser.json'
}
notepad .\collector-roomuser.json
```

来訪補完と推定滞在の両方を使う場合は、次の内容で保存します。

```json
{
  "enabled": true,
  "trackStay": true
}
```

来訪補完だけなら `enabled: true`、`trackStay: false` にします。両項目は必須のJSON真偽値です。`"true"`、`1`、`null` は使えません。
設定の保存先は、メイン設定の `-ConfigPath` にかかわらず **RoomUserVisits.ps1と同じフォルダー** です。

TikFinityを起動して対象LIVEに接続し、収集ツールを起動します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\TikFinityCollector.ps1
```

起動済みなら再起動は不要です。設定は約5秒ごとに再確認し、エラー修正後も自動復旧します。短時間に停止と再開を繰り返す場合は、診断に停止が反映されたのを確認してから再開してください。

**推定滞在は、ランキング上で連続して観測できた区間の合計です。** 正確な視聴時間、全入室者、ランキングから消えた人の退出を保証しません。1回だけの観測では時間を加算しません。停止・設定不正を検知すると最後の観測時刻までで区間を閉じ、再開後は新しい区間を開始します。

## 診断の確認

別のPowerShell画面を同じフォルダーで開きます。

```powershell
$status = Get-Content -LiteralPath '.\collector-status.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$status | Select-Object state, updatedAt, pending
$status.diagnostics.roomUserVisits | Format-List
```

接続中はイベントがなくても約5秒ごとにローカル診断を更新します。更新中に読み取りエラーになった場合は再実行してください。`updatedAt` が古い場合は収集プロセスの停止も確認します。

| configStatus | 意味・対処 |
| --- | --- |
| `enabled` | 来訪補完が有効。推定滞在も使う場合は `stayEnabled: true` を確認 |
| `disabled` | `enabled: false` による明示的な停止 |
| `missing` | 設定ファイルがない。上記手順で作成 |
| `read-error` | ファイルを読めない。権限・他アプリの排他ロック・同名フォルダーを確認 |
| `invalid-json` | JSONが壊れている、または空。括弧・カンマ等を修正 |
| `invalid-values` | オブジェクトでない、項目欠落、型違い。`configInvalidField` の `root` / `enabled` / `trackStay` を修正 |
| `module-missing` | RoomUserVisits.ps1がない。更新ファイルを確認 |
| `unchecked` / `unknown` | 未確認 / 旧版等で状態情報なし。起動・バージョン・次の診断受信を確認 |

`stopReason` は `disabled`、`config-missing`、`config-read-error`、`config-invalid-json`、`config-invalid-values` 等で停止理由を示します。`track-stay-disabled` は来訪補完のみ有効、空文字は両方有効です。
`configCheckedAt` / `configChangedAt` は設定の最終確認 / 状態変更時刻、`lastReceivedAt` は無効中も含むroomUser系イベントの最終受信時刻、`lastSnapshotAt` は有効中の最終処理時刻です（時刻はUnixミリ秒）。

有効でも記録が増えない場合は、`rankingFrames`、`candidates`、`queued`、`stayQueued` を時間を空けて比較します。`missingRoomId` が増える場合はLIVEの識別情報が不足しています。サーバー照合を利用する場合は `roomLookupStatus: verified` と `verifiedRoomFrames` を確認してください。`stayWriteFailures` の増加はローカル保存の問題です。`queued` / `stayQueued` はローカル送信待ちへの追加件数で、サーバー保存完了件数ではありません。

サーバー側でも次の既存ヘルスAPIから確認できます。実際の送信先ホストに置き換えてください。キーはこのURLへ付けません。

```powershell
$health = Invoke-RestMethod 'https://tiktok-live-comment-watch.onrender.com/api/health'
$health.collector | Select-Object connected, state, lastHeartbeatAt, lastEventAt
$health.collector.diagnostics.collector.roomUserVisits | Format-List
```

これは**最後にサーバーへ届いた診断**です。WebSocketは通常約30秒、HTTPは約60秒のハートビート間隔があり、送信待ち・通信断では遅れます。`connected`、`lastHeartbeatAt`、`diagnostics.collector.updatedAt` と合わせて確認してください。`lastReceivedAt` はPCがTikFinityから受信した時刻で、サーバー到着時刻ではありません。詳細な設定内容・ファイルパス・例外本文は追加診断へ送りません。

## 停止と復旧

追加機能だけを停止する場合は `collector-roomuser.json` を次の内容で保存します。

```json
{
  "enabled": false,
  "trackStay": false
}
```

約5秒後に `configStatus: disabled`、`enabled: false`、`stayEnabled: false` を確認します。通常のコメント・ギフト等の収集と、すでに保存された未送信イベントの再送は継続します。設定ファイルの欠落・読み取り失敗・不正時も追加機能だけが停止します。停止前に観測した区間は再送される場合がありますが、停止中の時間は加算しません。

設定を直して保存し、約5秒後に `configStatus: enabled` と希望する `stayEnabled` に戻ったことを確認してください。過去の送信済み来訪の重複抑制を保ち、次のランキング観測から再開します。
収集全体を停止する場合は実行画面で **Ctrl+C** を押します。再起動後は未送信キューを読み直します。

更新自体を戻す場合は収集ツールを停止し、バックアップから旧版の `TikFinityCollector.ps1`、`RoomUserVisits.ps1`、`CollectorStream.ps1` を元の場所へコピーして起動します。設定も戻す場合は現行設定を別名保存してから戻してください。**キュー・診断履歴は現行のものを保持**し、フォルダー全体を古いバックアップで上書きしないでください。
