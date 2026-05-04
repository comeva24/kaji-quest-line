import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const docsDir = path.join(root, "docs");
const templatePath = path.join(root, "templates", "card.html");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "";
const SHEETS_RANGE =
  (process.env.SHEETS_RANGE && String(process.env.SHEETS_RANGE).trim()) ||
  "'担当カレンダー'!A1:I100";
const MOCK = process.env.MOCK_SHEETS === "1" || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

/** @typedef {{ month: number, day: number, weekdayLabel: string }} JstToday */

const DEFAULT_QUEST_HEADERS = ["夕飯", "洗濯たたむ", "風呂掃除", "食器洗い", "掃除機", "ゴミまとめ"];

/**
 * JST の「今日」の月・日・曜（短い表記）
 * @returns {JstToday}
 */
function getJstToday() {
  const d = new Date();
  const month = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric" }).format(d),
  );
  const day = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", day: "numeric" }).format(d),
  );
  const weekdayLabel = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(d);
  return { month, day, weekdayLabel };
}

/**
 * セル値から整数を抽出（「5」「5月」などに対応）
 * @param {unknown} v
 * @returns {number | null}
 */
function parseCellNumber(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * モック用：今日の日付行を含むサンプル表
 * @param {JstToday} today
 * @returns {string[][]}
 */
function mockSheetRows(today) {
  const header = ["月", "日", "曜", ...DEFAULT_QUEST_HEADERS];
  const otherDay = today.day === 1 ? 2 : today.day - 1;
  const otherMonth = today.month;
  return [
    ["家事クエスト（モック）", "今日の担当だけお届け"],
    header,
    [otherMonth, otherDay, "月", "A", "B", "C", "D", "E", "F"],
    [today.month, today.day, "火", "太郎", "花子", "", "次郎", "三郎", "四郎"],
    [today.month, today.day + 1 > 28 ? 1 : today.day + 1, "水", "x", "y", "z", "a", "b", "c"],
  ];
}

async function fetchSheetValues() {
  if (MOCK) {
    return mockSheetRows(getJstToday());
  }
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEETS_RANGE,
  });
  return res.data.values || [];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * D〜I 列のクエスト名（ヘッダー行が欠ける場合はデフォルト）
 * @param {string[][]} rows
 */
function getQuestHeaders(rows) {
  const h = rows[1];
  if (!h || h.length < 9) {
    return [...DEFAULT_QUEST_HEADERS];
  }
  const slice = h.slice(3, 9).map((cell) => String(cell ?? "").trim());
  return slice.map((name, i) => name || DEFAULT_QUEST_HEADERS[i] || `項目${i + 1}`);
}

/**
 * A列=月・B列=日が JST 今日と一致する行を探す
 * @param {string[][]} rows
 * @param {JstToday} today
 * @returns {string[] | null}
 */
function findTodayRow(rows, today) {
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const m = parseCellNumber(row[0]);
    const d = parseCellNumber(row[1]);
    if (m === today.month && d === today.day) {
      return row;
    }
  }
  return null;
}

/**
 * @param {string[][]} rows
 */
function rowsToFields(rows) {
  const today = getJstToday();
  const title = rows[0]?.[0]?.toString().trim() || "家事クエスト";
  const sub = rows[0]?.[1]?.toString().trim() || "";
  const dateLabel = `${today.month}月${today.day}日（${today.weekdayLabel}）`;

  const questHeaders = getQuestHeaders(rows);
  const matched = findTodayRow(rows, today);

  let bodyRaw;
  if (!matched) {
    bodyRaw = `今日（${today.month}月${today.day}日）の行が見つかりません。\nスプレッドシートの日付列を確認してください。`;
  } else {
    const values = [];
    for (let i = 0; i < 6; i++) {
      const name = questHeaders[i] ?? `項目${i + 1}`;
      const rawVal = matched[3 + i];
      const val =
        rawVal === undefined || rawVal === null || String(rawVal).trim() === ""
          ? "—"
          : String(rawVal).trim();
      values.push(`・${name}：${val}`);
    }
    bodyRaw = values.join("\n");
  }

  const bodyHtml = escapeHtml(bodyRaw).replace(/\n/g, "<br />");
  return { title, sub, dateLabel, bodyHtml };
}

async function renderHtml(fields) {
  let tpl = await fs.readFile(templatePath, "utf8");
  tpl = tpl.replace("{{HEADER_TITLE}}", escapeHtml(fields.title));
  tpl = tpl.replace("{{HEADER_SUB}}", escapeHtml(fields.sub));
  tpl = tpl.replace("{{DATE_LABEL}}", escapeHtml(fields.dateLabel));
  tpl = tpl.replace("{{BODY_HTML}}", fields.bodyHtml);
  return tpl;
}

async function screenshotToJpegBuffer(html) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 632, height: 1200 });
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts?.ready);
  const card = page.locator(".shell");
  await card.waitFor({ state: "visible" });
  const buf = await card.screenshot({ type: "jpeg", quality: 88 });
  await browser.close();
  return buf;
}

async function main() {
  await fs.mkdir(docsDir, { recursive: true });
  const rows = await fetchSheetValues();
  const fields = rowsToFields(rows);
  const html = await renderHtml(fields);
  const raw = await screenshotToJpegBuffer(html);

  const full = await sharp(raw)
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();

  const preview = await sharp(raw)
    .resize(240, 240, { fit: "cover" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  await fs.writeFile(path.join(docsDir, "today.jpg"), full);
  await fs.writeFile(path.join(docsDir, "today_preview.jpg"), preview);
  console.log("Wrote docs/today.jpg and docs/today_preview.jpg");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
