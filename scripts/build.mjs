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
const soraDir = path.join(root, "assets", "sora");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "";
/** 1枚目のシート「担当カレンダー」全体の先頭ブロック（A1:I100） */
const DEFAULT_SHEETS_RANGE = "'担当カレンダー'!A1:I100";
const SPECIAL_SHEET_RANGE = "'特別クエスト'!A1:E500";
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
 * JST の今日を YYYY-MM-DD（特別クエストの日付列と突き合わせ用）
 * @returns {string}
 */
function getJstIsoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
 * Spreadsheet の日付セルを YYYY-MM-DD に寄せる
 * @param {unknown} val
 * @returns {string | null}
 */
function normalizeQuestDateCell(val) {
  if (val === undefined || val === null || val === "") return null;
  if (typeof val === "number" && Number.isFinite(val)) {
    const excelEpochUtc = Date.UTC(1899, 11, 30);
    const utcMs = Math.round(excelEpochUtc + val * 86400000);
    const d = new Date(utcMs);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
  const s = String(val).trim();
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const y = iso[1];
    const mo = iso[2].padStart(2, "0");
    const da = iso[3].padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
  const md = s.match(/^(\d{1,2})\/(\d{1,2})/);
  if (md) {
    const y = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
    }).format(new Date());
    const mo = md[1].padStart(2, "0");
    const da = md[2].padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }
  return null;
}

/**
 * @param {unknown} rawVal
 */
function isAssigneeVacant(rawVal) {
  if (rawVal === undefined || rawVal === null) return true;
  const s = String(rawVal).trim();
  if (s === "") return true;
  if (s === "—" || s === "-" || s === "ー") return true;
  return false;
}

/**
 * 完了フラグが明示的に FALSE とみなせるときのみ true（それ以外は表示しない）
 * @param {unknown} rawVal
 */
function isIncompleteFlag(rawVal) {
  if (rawVal === undefined || rawVal === null) return false;
  if (typeof rawVal === "boolean") return rawVal === false;
  const s = String(rawVal).trim().toUpperCase();
  return s === "FALSE" || s === "0" || s === "×" || s === "✗";
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
    [today.month, today.day, "火", "太郎", "花子", "", "次郎", "", "四郎"],
    [today.month, today.day + 1 > 28 ? 1 : today.day + 1, "水", "x", "y", "z", "a", "b", "c"],
  ];
}

/**
 * @param {JstToday} today
 */
function mockSpecialQuestRows(today) {
  const ymd = getJstIsoDate();
  return [
    ["日付", "クエストタイトル", "ポイント", "担当者", "完了"],
    [ymd, "キッチンの深い掃除", "30", "", "FALSE"],
    [ymd, "完了済みの特別クエスト", "10", "花子", "TRUE"],
    ["2099-01-01", "未来のクエスト", "5", "", "FALSE"],
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

/**
 * 「特別クエスト」シート。存在しない／取得失敗時は空配列。
 * @returns {Promise<string[][]>}
 */
async function fetchSpecialQuestValues() {
  if (MOCK) {
    return mockSpecialQuestRows(getJstToday());
  }
  if (!SPREADSHEET_ID) {
    return [];
  }
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SPECIAL_SHEET_RANGE,
    });
    return res.data.values || [];
  } catch {
    return [];
  }
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

/**
 * @param {string[][]} specialRows
 * @param {string} todayYmd
 * @returns {{ title: string, points: string }[]}
 */
function filterTodayIncompleteSpecialQuests(specialRows, todayYmd) {
  /** @type {{ title: string, points: string }[]} */
  const out = [];
  for (let i = 0; i < specialRows.length; i++) {
    const row = specialRows[i];
    if (!row || row.length < 2) continue;
    const rowDate = normalizeQuestDateCell(row[0]);
    if (!rowDate || rowDate !== todayYmd) continue;
    if (!isIncompleteFlag(row[4])) continue;
    const title = String(row[1] ?? "").trim();
    if (!title) continue;
    const points = row[2] !== undefined && row[2] !== null ? String(row[2]).trim() : "";
    out.push({ title, points });
  }
  return out;
}

/**
 * E〜I 列で担当が空の家事名
 * @param {string[]} matched
 * @param {string[]} questHeaders
 */
function getVacantChoreLabels(matched, questHeaders) {
  /** @type {string[]} */
  const labels = [];
  for (let col = 4; col <= 8; col++) {
    if (isAssigneeVacant(matched[col])) {
      const name = questHeaders[col - 3] ?? `項目${col - 2}`;
      labels.push(name);
    }
  }
  return labels;
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
 * @param {string} title
 * @param {string} pointsDisplay
 */
function specialQuestItemHtml(title, pointsDisplay) {
  const titleEsc = escapeHtml(title);
  const pts =
    pointsDisplay !== ""
      ? `<span class="shrink-0 rounded-md bg-violet-100 px-2 py-0.5 text-sm font-bold text-violet-800">${escapeHtml(pointsDisplay)} pt</span>`
      : "";
  return `<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-100 bg-violet-50/70 px-3 py-2.5">
    <span class="min-w-0 flex-1 font-semibold leading-snug text-stone-900">${titleEsc}</span>
    ${pts}
  </li>`;
}

/**
 * @param {string[]} vacantLabels
 */
function emergencySectionHtml(vacantLabels) {
  const items = vacantLabels
    .map(
      (label) =>
        `<li class="flex items-start gap-2 text-[15px] font-semibold leading-snug text-rose-900">
      <i data-lucide="alarm-clock" class="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true"></i>
      <span>${escapeHtml(label)}</span>
    </li>`,
    )
    .join("\n");
  return `<div class="rounded-xl border-2 border-rose-400 bg-gradient-to-br from-rose-50 to-amber-50/40 p-3.5 shadow-sm ring-1 ring-rose-200/80">
    <p class="mb-2 flex flex-wrap items-center gap-2 text-[16px] font-extrabold leading-snug text-rose-800">
      <span aria-hidden="true">🚨</span>
      担当者がいません！誰かお願い<span aria-hidden="true">🐾</span>
    </p>
    <ul class="space-y-1.5">${items}</ul>
  </div>`;
}

/**
 * @param {{
 *   dinnerLineInnerHtml: string
 *   specials: { title: string, points: string }[]
 *   vacantLabels: string[]
 * }} parts
 */
function buildTaskBodyHtml(parts) {
  const dinnerInline =
    `<img src="__DINNER_SORA_URI__" alt="" width="64" height="64" class="h-14 w-14 shrink-0 object-contain drop-shadow-sm" decoding="async" />`;

  const dinnerBlock = `<div class="flex gap-3 rounded-xl border border-amber-100 bg-amber-50/75 px-3 py-2.5">
      ${dinnerInline}
      <div class="min-w-0 flex-1 pt-0.5">
        <p class="text-[15px] font-bold text-amber-800">きょうの夕飯担当</p>
        <p class="mt-1 text-[15px] leading-snug text-stone-800">${parts.dinnerLineInnerHtml}</p>
      </div>
    </div>`;

  let html = dinnerBlock;

  if (parts.specials.length > 0) {
    const lis = parts.specials.map((q) =>
      specialQuestItemHtml(q.title, q.points),
    );
    html += `\n<div>
      <div class="mb-2 flex items-center gap-2">
        <i data-lucide="sparkles" class="h-4 w-4 text-violet-500" aria-hidden="true"></i>
        <p class="text-[15px] font-bold text-stone-700">今日の家事クエスト（特別）</p>
      </div>
      <ul class="space-y-2">
        ${lis.join("\n")}
      </ul>
    </div>`;
  }

  if (parts.vacantLabels.length > 0) {
    html += `\n${emergencySectionHtml(parts.vacantLabels)}`;
  }

  return html;
}

/**
 * @param {string[][]} calendarRows
 * @param {string[][]} specialRows
 */
function rowsToFields(calendarRows, specialRows) {
  const today = getJstToday();
  const todayYmd = getJstIsoDate();
  const title = calendarRows[0]?.[0]?.toString().trim() || "家事クエスト";
  const sub = calendarRows[0]?.[1]?.toString().trim() || "今日のやることだけお届け";
  const dateLabel = `${today.month}月${today.day}日（${today.weekdayLabel}）`;
  const datePill = "今日";

  const questHeaders = getQuestHeaders(calendarRows);
  const matched = findTodayRow(calendarRows, today);
  const timeMeta = getJstTimeForCard();

  const specials = filterTodayIncompleteSpecialQuests(specialRows, todayYmd);

  if (!matched) {
    const msg = `今日（${today.month}月${today.day}日）の行が見つかりません。\nスプレッドシートの日付列（A〜B列）を確認してください。`;
    return {
      headerTitle: escapeHtml(title),
      headerSub: escapeHtml(sub),
      datePill: escapeHtml(datePill),
      bubbleTitle: escapeHtml("今日のやること"),
      bubbleDesc: escapeHtml(`${dateLabel}の担当を表示できませんでした。`),
      taskBodyHtml: `<p class="text-[15px] leading-relaxed text-rose-700">${escapeHtml(msg).replace(/\n/g, "<br />")}</p>`,
      footerNoteHtml: escapeHtml(
        "※カレンダーに今日の行がないときは、このカードとは別にお知らせする想定です。",
      ),
      timeDatetime: escapeHtml(timeMeta.attr),
      timeLabel: escapeHtml(timeMeta.label),
      soraMainFile: specials.length ? "sora7.png" : "sora1.png",
      useDinnerSora: false,
    };
  }

  const dinnerRaw = normalizeAssignee(matched[3]);
  const dinnerLineInnerHtml =
    dinnerRaw === "—"
      ? `<span class="font-bold text-stone-500">未設定</span>`
      : `<span class="font-bold text-orange-700">${escapeHtml(dinnerRaw)}</span> さん`;

  const vacantLabels = getVacantChoreLabels(matched, questHeaders);

  const taskBodyHtml = buildTaskBodyHtml({
    dinnerLineInnerHtml,
    specials,
    vacantLabels,
  });

  const bubbleTitle = "今日のやること";
  const bubbleDesc = `${dateLabel}｜夕飯担当・特別クエスト・募集枠`;

  /** @type {string} */
  let soraMainFile = "sora1.png";
  if (vacantLabels.length > 0) soraMainFile = "sora12.png";
  else if (specials.length > 0) soraMainFile = "sora7.png";

  return {
    headerTitle: escapeHtml(title),
    headerSub: escapeHtml(sub),
    datePill: escapeHtml(datePill),
    bubbleTitle: escapeHtml(bubbleTitle),
    bubbleDesc: escapeHtml(bubbleDesc),
    taskBodyHtml,
    footerNoteHtml: escapeHtml(
      "※緊急募集は担当が空いている家事です。夕飯は必ず確認してくださいね。",
    ),
    timeDatetime: escapeHtml(timeMeta.attr),
    timeLabel: escapeHtml(timeMeta.label),
    soraMainFile,
    useDinnerSora: true,
  };
}

/**
 * @param {Awaited<ReturnType<typeof rowsToFields>>} fields
 */
async function renderHtml(fields, avatarDataUri, dinnerSoraUri) {
  let tpl = await fs.readFile(templatePath, "utf8");
  let body = fields.taskBodyHtml;
  if (fields.useDinnerSora && dinnerSoraUri) {
    body = body.replace(/__DINNER_SORA_URI__/g, dinnerSoraUri);
  } else {
    body = body.replace(/__DINNER_SORA_URI__/g, "");
    body = body.replace(/<img[^>]*src=""[^>]*>/g, "");
  }

  tpl = tpl.replace(/\{\{HEADER_TITLE\}\}/g, fields.headerTitle);
  tpl = tpl.replace(/\{\{HEADER_SUB\}\}/g, fields.headerSub);
  tpl = tpl.replace(/\{\{DATE_PILL\}\}/g, fields.datePill);
  tpl = tpl.replace(/\{\{BUBBLE_TITLE\}\}/g, fields.bubbleTitle);
  tpl = tpl.replace(/\{\{BUBBLE_DESC\}\}/g, fields.bubbleDesc);
  tpl = tpl.replace(/\{\{TASK_BODY_HTML\}\}/g, body);
  tpl = tpl.replace(/\{\{TIME_DATETIME\}\}/g, fields.timeDatetime);
  tpl = tpl.replace(/\{\{TIME_LABEL\}\}/g, fields.timeLabel);
  tpl = tpl.replace(/\{\{AVATAR_DATA_URI\}\}/g, avatarDataUri);
  tpl = tpl.replace(/\{\{FOOTER_NOTE_HTML\}\}/g, fields.footerNoteHtml || "");
  return tpl;
}

/**
 * @param {string} fileName
 */
async function loadSoraDataUri(fileName) {
  const p = path.join(soraDir, fileName);
  const buf = await fs.readFile(p);
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
  const [calendarRows, specialRows] = await Promise.all([
    fetchSheetValues(),
    fetchSpecialQuestValues(),
  ]);
  const fields = rowsToFields(calendarRows, specialRows);
  const avatarDataUri = await loadSoraDataUri(fields.soraMainFile);
  const dinnerSoraUri = fields.useDinnerSora ? await loadSoraDataUri("sora3.png") : "";
  const html = await renderHtml(fields, avatarDataUri, dinnerSoraUri);
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
