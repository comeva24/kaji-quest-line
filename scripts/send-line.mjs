const BASE_URL = (process.env.BASE_URL || "https://comeva24.github.io/kaji-quest-line").replace(/\/$/, "");
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const TO = process.env.LINE_TO_USER_ID || "";

const original = `${BASE_URL}/today.jpg`;
const preview = `${BASE_URL}/today_preview.jpg`;
const messages = [
  {
    type: "image",
    originalContentUrl: original,
    previewImageUrl: preview,
  },
];

async function postLineMessage(endpoint, body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${endpoint} failed: ${res.status} ${text}`);
  }
}

async function main() {
  if (!TOKEN || !TO) {
    console.error("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_TO_USER_ID");
    process.exit(1);
  }
  await postLineMessage("https://api.line.me/v2/bot/message/push", {
    to: TO,
    messages,
  });

  console.log("LINE push OK:", original);
  await postLineMessage("https://api.line.me/v2/bot/message/broadcast", {
    messages,
  });
  console.log("LINE broadcast OK:", original);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
