# TikTok LIVE コメント・ギフト計測

複数のTikTok LIVEをサーバー側で監視し、コメント、入室履歴、推定滞在時間、フォロー、ハートミー、ギフト履歴、ギフト別ランキングを表示するWebアプリです。ブラウザを閉じても、サーバーが稼働している間は集計を続けます。

## 起動

```powershell
npm.cmd install
npm.cmd start
```

ブラウザで `http://localhost:3030` を開きます。

Windowsでは `start-app.cmd` を開いても起動できます。

もし npm のキャッシュで権限エラーが出る場合は、次を使ってください。

```powershell
npm.cmd install --cache .\.npm-cache
```

## 契約前

環境変数を設定しなければ、現在の `tiktok-live-connector` 接続と配信内メモリ集計で動作します。画面と操作方法は契約後も変わりません。

## 契約後の設定

RenderのEnvironmentへ次を追加します。

| 名前 | 内容 |
| --- | --- |
| `TIKTOOLS_API_KEY` | Tik.toolsで発行されたAPIキー |
| `TIKTOOLS_MODE` | `direct`（推奨）または`relayed` |
| `DATABASE_URL` | Render PostgreSQLのInternal Database URL |
| `LIVECUE_ENDPOINT` | LiveCueの`/api/events` URL |
| `LIVECUE_CHANNEL_ID` | LiveCueのチャンネルID |
| `LIVECUE_ADMIN_TOKEN` | LiveCueの管理または取り込みトークン |

`TIKTOOLS_API_KEY`を設定するとTik.toolsへ自動で切り替わります。`DATABASE_URL`を設定するとイベントを永続保存し、本日・7日・30日・全期間のギフト別ランキング、ライバーごとの累計来訪回数、サーバー再起動後の監視復元が有効になります。同じLIVEの途中で再入室や再接続があっても、来訪回数は1回として集計します。

LiveCueの3項目を設定すると、同じLIVE接続からコメント・ギフト・いいね・フォロー・シェア・入室・購読イベントをLiveCueへ送ります。LiveCue側で別のTikTok接続は不要です。

## 使い方

1. TikTok IDを入力します。
2. `追加`を押します。
3. ギフト別ランキングで、バラなどのギフトと集計期間を選びます。
4. `CSV出力`から取得済みコメントとギフトを保存できます。

## 注意

- TikTok公式の通常APIには、LIVEコメントを安定して取得する公開APIがありません。
- APIキー未設定時は`tiktok-live-connector`、設定後は`@tiktool/live`を使用します。
- Tik.toolsもTikTok公式APIではないため、TikTok側の変更による停止可能性は残ります。
- 視聴時間は、アプリで計測を始めてからの経過時間を表示します。
- ユーザー別の滞在時間は、入室イベントが取れた場合だけ推定値として表示されます。正確な視聴者ごとの滞在時間を保証するものではありません。
