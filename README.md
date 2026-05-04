# kaji-quest-line

Google スプレッドシート → HTML（Playwright）→ `docs/*.jpg` → GitHub Pages → LINE プッシュ。

## GitHub Pages

- 公開 URL: https://comeva24.github.io/kaji-quest-line/
- 画像: `today.jpg` , `today_preview.jpg`

## Secrets（Repository secrets）

| Name | 説明 |
|------|------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウント JSON 全文（1行の JSON 推奨） |
| `SPREADSHEET_ID` | スプレッドシート ID（例: `1B8M8gRxq8njy3lYztdnG38jGqSE0_ich`） |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE チャネルアクセストークン |
| `LINE_TO_USER_ID` | 配信先の userId |
| `SHEETS_RANGE`（任意） | 読み取りレンジの A1 記法。未設定時は `scripts/build.mjs` のデフォルト `'担当カレンダー'!A1:I100` を使用。**Secret に古いレンジを登録していると、その値がデフォルトより優先**されるため、シート名を変えたら Secret を削除するか正しいレンジに更新してください。 |

## スプレッドシートの形（シート名: `担当カレンダー`、ブックの 1 枚目）

スクリプトは **JST の当日** に一致する行を探し、その日の **D〜I 列（クエスト担当）** をカード本文にします。

- **1行目**: 結合セル可。**A1** をカードのヘッダータイトルに使用。**B1** があればヘッダーサブタイトルに使用。
- **2行目（ヘッダー）**: **A2〜I2** = `月` / `日` / `曜` / `夕飯` / `洗濯たたむ` / `風呂掃除` / `食器洗い` / `掃除機` / `ゴミまとめ`（D〜I はカードに表示するラベル）
- **3行目以降（データ）**:
  - **A 列** = 月、**B 列** = 日（JST 今日の月日と一致する行を検索）
  - **C 列** = 曜（表示には利用しないがシート上で確認用として使用可）
  - **D〜I 列** = 各クエストの担当者名（空欄は「—」と表示）

サービスアカウントのメールにシートを共有（閲覧で可）。

## ローカル

初回は `npm install` で `package-lock.json` を生成してから `npm ci` が使える。

`.env` に `GOOGLE_SERVICE_ACCOUNT_JSON` と `SPREADSHEET_ID` を設定すると実シートを読みます。未設定または `MOCK_SHEETS=1` のときはモックデータで画像を生成します。

PowerShell の例（実シート）:

```powershell
$env:MOCK_SHEETS="0"
$env:SPREADSHEET_ID="1B8M8gRxq8njy3lYztdnG38jGqSE0_ich"
$env:GOOGLE_SERVICE_ACCOUNT_JSON = Get-Content -Raw .\service-account.json
npm run build
```

モックで確認:

```bash
cp .env.example .env
npm install
npx playwright install chromium
MOCK_SHEETS=1 npm run build
```

## ライセンス

用途に合わせて設定してください。
