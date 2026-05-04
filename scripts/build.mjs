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
  (process.env.SHEETS_RANGE && String(process.env.SHEETS_RANGE).trim()) || "Sheet1!A1:C10";
const MOCK = process.env.MOCK_SHEETS === "1" || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

async function fetchSheetValues() {
  if (MOCK) {
    return [
      ["家事クエスト（そら）", "今日のやることだけお届け"],
      ["今日"],
      ["・朝の片付け\n・洗い物\n・夕食の下ごし"],
    ];
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

function rowsToFields(rows) {
  const title = rows[0]?.[0] ?? "家事クエスト";
  const sub = rows[0]?.[1] ?? "";
  const dateLabel = rows[1]?.[0] ?? "今日";
  const bodyRaw = rows.slice(2).map((r) => r[0]).filter(Boolean).join("\n") || "（スプレッドシートに本文を入力してください）";
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
