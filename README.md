# kaji-quest-line

Google スプレッドシート → HTML（Playwright）→ `docs/*.jpg` → GitHub Pages → LINE プッシュ。

## GitHub Pages

- 公開 URL: https://comeva24.github.io/kaji-quest-line/
- 画像: `today.jpg` , `today_preview.jpg`

## Secrets（Repository secrets）

| Name | 説明 |
|------|------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウント JSON 全文（1行の JSON 推奨） |
| `SPREADSHEET_ID` | スプレッドシート ID |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE チャネルアクセストークン |
| `LINE_TO_USER_ID` | 配信先の userId |

任意でレンジを変える場合は、リポジトリの `.github/workflows/morning-line.yml` の `env` に `SHEETS_RANGE: ${{ secrets.SHEETS_RANGE }}` を追加し、GitHub に `SHEETS_RANGE` Secret を登録する。未設定時は `scripts/build.mjs` のデフォルト `Sheet1!A1:C10` を使う。

## スプレッドシートの形（例）

- 1行目 A1: ヘッダータイトル、B1: ヘッダーサブタイトル
- 2行目 A2: 日付ラベル（例: 今日）
- 3行目以降 A列: 本文（複数行可）

サービスアカウントのメールにシートを共有（閲覧で可）。

## ローカル

初回は `npm install` で `package-lock.json` を生成してから `npm ci` が使える。

```bash
cp .env.example .env
npm install
npx playwright install chromium
MOCK_SHEETS=1 npm run build
```

## ライセンス

用途に合わせて設定してください。
