import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const docsDir = path.join(root, "docs");
const templatePath = path.join(root, "output", "kaji-quest-line-today.html");
const avatarPath = path.join(root, "assets", "avatar.png");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "";
/** 1枚目のシート「担当カレンダー」全体の先頭ブロック（A1:I100） */
const DEFAULT_SHEETS_RANGE = "'担当カレンダー'!A1:I100";
const SHEETS_RANGE =
  (process.env.SHEETS_RANGE && String(process.env.SHEETS_RANGE).trim()) || DEFAULT_SHEETS_RANGE;
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
 * @param {unknown} rawVal
 */
function normalizeAssignee(rawVal) {
  if (rawVal === undefined || rawVal === null || String(rawVal).trim() === "") {
    return "—";
  }
  return String(rawVal).trim();
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

/** @returns {{ attr: string, label: string }} */
function getJstTimeForCard() {
  const now = new Date();
  const sv = now.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  const [datePart, timePart] = sv.split(" ");
  const attr = `${datePart}T${timePart}+09:00`;
  let label = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  label = label.replace(/^(午前|午後)/, "$1 ");
  return { attr, label };
}

/**
 * @param {string} questName
 * @param {string} assigneeDisplay 「—」は未設定表示
 */
function questListItemHtml(questName, assigneeDisplay) {
  const nameEsc = escapeHtml(questName);
  const assigneeEsc =
    assigneeDisplay === "—"
      ? `<span class="text-stone-400">未設定</span>`
      : escapeHtml(assigneeDisplay);
  return `<li class="flex items-start gap-2 rounded-lg border border-stone-100 bg-stone-50/80 px-3 py-2.5">
    <i data-lucide="circle-dot" class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true"></i>
    <div class="min-w-0">
      <p class="font-semibold leading-snug text-stone-900">${nameEsc}</p>
      <p class="text-sm text-stone-500">担当：${assigneeEsc}</p>
    </div>
  </li>`;
}

/**
 * @param {string[][]} rows
 */
function rowsToFields(rows) {
  const today = getJstToday();
  const title = rows[0]?.[0]?.toString().trim() || "家事クエスト";
  const sub = rows[0]?.[1]?.toString().trim() || "今日のやることだけお届け";
  const dateLabel = `${today.month}月${today.day}日（${today.weekdayLabel}）`;
  const datePill = "今日";

  const questHeaders = getQuestHeaders(rows);
  const matched = findTodayRow(rows, today);
  const timeMeta = getJstTimeForCard();

  if (!matched) {
    const msg = `今日（${today.month}月${today.day}日）の行が見つかりません。\nスプレッドシートの日付列（A〜B列）を確認してください。`;
    return {
      headerTitle: escapeHtml(title),
      headerSub: escapeHtml(sub),
      datePill,
      bubbleTitle: "今日のやること",
      bubbleDesc: `${dateLabel}の担当を表示できませんでした。`,
      taskBodyHtml: `<p class="text-[15px] leading-relaxed text-rose-700">${escapeHtml(msg).replace(/\n/g, "<br />")}</p>`,
      timeDatetime: timeMeta.attr,
      timeLabel: timeMeta.label,
    };
  }

  const slots = [3, 4, 5, 6, 7, 8].map((idx) => matched[idx]);
  const filled = slots.filter((v) => normalizeAssignee(v) !== "—").length;
  const bubbleTitle = `今日のやること（${filled}/6件）`;
  const bubbleDesc = sub ? escapeHtml(sub) : `${escapeHtml(dateLabel)}の夕飯・家事クエストの担当です。`;

  const dinnerRaw = normalizeAssignee(matched[3]);
  const dinnerLine =
    dinnerRaw === "—"
      ? `<span class="font-bold text-stone-500">未設定</span>`
      : `<span class="font-bold text-orange-700">${escapeHtml(dinnerRaw)}</span> さん`;

  const dinnerBlock = `<div class="flex gap-2.5">
      <span class="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-800">
        <i data-lucide="chef-hat" class="h-4 w-4" aria-hidden="true"></i>
      </span>
      <div class="min-w-0">
        <p class="text-[15px] font-bold text-amber-800">きょうの夕飯担当</p>
        <p class="mt-1 text-[15px] leading-snug text-stone-800">${dinnerLine}</p>
      </div>
    </div>`;

  const questLis = [];
  for (let i = 1; i < 6; i++) {
    const qName = questHeaders[i] ?? `項目${i + 1}`;
    const rawVal = matched[3 + i];
    questLis.push(questListItemHtml(qName, normalizeAssignee(rawVal)));
  }

  const questSection = `<div>
      <div class="mb-2 flex items-center gap-2">
        <i data-lucide="list-checks" class="h-4 w-4 text-stone-500" aria-hidden="true"></i>
        <p class="text-[15px] font-bold text-stone-700">やってほしい家事クエスト</p>
      </div>
      <ul class="space-y-2.5 text-[15px] text-stone-800">
        ${questLis.join("\n")}
      </ul>
    </div>`;

  const taskBodyHtml = `${dinnerBlock}\n${questSection}`;

  return {
    headerTitle: escapeHtml(title),
    headerSub: escapeHtml(sub),
    datePill: escapeHtml(datePill),
    bubbleTitle: escapeHtml(bubbleTitle),
    bubbleDesc,
    taskBodyHtml,
    timeDatetime: escapeHtml(timeMeta.attr),
    timeLabel: escapeHtml(timeMeta.label),
  };
}

/**
 * @param {Awaited<ReturnType<typeof rowsToFields>>} fields
 * @param {string} avatarDataUri
 */
async function renderHtml(fields, avatarDataUri) {
  let tpl = await fs.readFile(templatePath, "utf8");
  tpl = tpl.replace(/\{\{HEADER_TITLE\}\}/g, fields.headerTitle);
  tpl = tpl.replace(/\{\{HEADER_SUB\}\}/g, fields.headerSub);
  tpl = tpl.replace(/\{\{DATE_PILL\}\}/g, fields.datePill);
  tpl = tpl.replace(/\{\{BUBBLE_TITLE\}\}/g, fields.bubbleTitle);
  tpl = tpl.replace(/\{\{BUBBLE_DESC\}\}/g, fields.bubbleDesc);
  tpl = tpl.replace(/\{\{TASK_BODY_HTML\}\}/g, fields.taskBodyHtml);
  tpl = tpl.replace(/\{\{TIME_DATETIME\}\}/g, fields.timeDatetime);
  tpl = tpl.replace(/\{\{TIME_LABEL\}\}/g, fields.timeLabel);
  tpl = tpl.replace(/\{\{AVATAR_DATA_URI\}\}/g, avatarDataUri);
  return tpl;
}

async function loadAvatarDataUri() {
  const buf = await fs.readFile(avatarPath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function screenshotToJpegBuffer(html) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 640, height: 2400 });
  try {
    await page.setContent(html, { waitUntil: "networkidle", timeout: 90000 });
  } catch {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
  }
  await page.locator("#line-card").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(() => {
    if (window.lucide?.createIcons) window.lucide.createIcons();
  });
  await delay(250);
  const buf = await page.locator("#line-card").screenshot({ type: "jpeg", quality: 88 });
  await browser.close();
  return buf;
}

async function main() {
  await fs.mkdir(docsDir, { recursive: true });
  const rows = await fetchSheetValues();
  const fields = rowsToFields(rows);
  const avatarDataUri = await loadAvatarDataUri();
  const html = await renderHtml(fields, avatarDataUri);
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
