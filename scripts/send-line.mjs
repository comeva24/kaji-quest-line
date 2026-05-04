const BASE_URL = (process.env.BASE_URL || "https://comeva24.github.io/kaji-quest-line").replace(/\/$/, "");
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const TO = process.env.LINE_TO_USER_ID || "";

const original = `${BASE_URL}/today.jpg`;
const preview = `${BASE_URL}/today_preview.jpg`;

async function main() {
  if (!TOKEN || !TO) {
    console.error("Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_TO_USER_ID");
    process.exit(1);
  }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      to: TO,
      messages: [
        {
          type: "image",
          originalContentUrl: original,
          previewImageUrl: preview,
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(res.status, text);
    process.exit(1);
  }
  console.log("LINE push OK:", original);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
