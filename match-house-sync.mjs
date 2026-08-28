import { JWT } from "google-auth-library";

// --- Config: this script is scoped to exactly one account -> one sheet tab. ---
const META_ACCOUNT_ID = "act_2106987116376869"; // "Match House"
const SPREADSHEET_ID = "1XUPuNNkBfk08PMIhvcNMSgGUGH0J9djbXuFzjG4kwzo";
const SHEET_TAB = "Sheet1";
const GRAPH_API_BASE_URL = "https://graph.facebook.com/v21.0";
const LEAD_ACTION_TYPES = new Set(["omni_purchase", "lead"]);
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

function ukYesterdayDateString() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  const todayUtcMidnight = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")));
  const yesterdayUtcMidnight = todayUtcMidnight - 86_400_000;
  const d = new Date(yesterdayUtcMidnight);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function dateStringToSheetsSerial(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - SHEETS_EPOCH_UTC_MS) / 86_400_000);
}

async function fetchMetaInsights(dateStr) {
  const token = process.env.META_TOKEN;
  const url = new URL(`${GRAPH_API_BASE_URL}/${META_ACCOUNT_ID}/insights`);
  url.searchParams.set("fields", "spend,actions");
  url.searchParams.set("level", "account");
  url.searchParams.set("time_range", JSON.stringify({ since: dateStr, until: dateStr }));
  url.searchParams.set("access_token", token);

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Meta API error (${res.status}): ${JSON.stringify(body)}`);
  }

  const row = body.data?.[0];
  if (!row) return { spend: 0, leads: 0 };

  const spend = Number.parseFloat(row.spend ?? "0");
  const leads = (row.actions ?? [])
    .filter((a) => LEAD_ACTION_TYPES.has(a.action_type))
    .reduce((sum, a) => sum + Number.parseFloat(a.value), 0);

  return { spend, leads: Math.round(leads) };
}

async function sheetsClient() {
  const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_B64, "base64").toString("utf8"));
  const auth = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  await auth.authorize();
  return auth;
}

async function findRowForDate(auth, targetSerial) {
  const res = await auth.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_TAB}!A1:A500`,
    params: { valueRenderOption: "UNFORMATTED_VALUE" },
  });
  const values = res.data.values ?? [];
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === targetSerial) return i + 1; // 1-indexed sheet row
  }
  return null;
}

async function writeRow(auth, row, spend, leads) {
  await auth.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_TAB}!B${row}:C${row}`,
    method: "PUT",
    params: { valueInputOption: "USER_ENTERED" },
    data: { values: [[spend, leads]] },
  });
}

async function main() {
  const dateStr = ukYesterdayDateString();
  console.log(`Target date (yesterday, Europe/London): ${dateStr}`);

  const { spend, leads } = await fetchMetaInsights(dateStr);
  console.log(`Meta insights: spend=£${spend.toFixed(2)}, leads=${leads}`);

  const auth = await sheetsClient();
  const serial = dateStringToSheetsSerial(dateStr);
  const row = await findRowForDate(auth, serial);
  if (!row) {
    throw new Error(`No row found in ${SHEET_TAB}!A for ${dateStr} (serial ${serial}) — sheet may need more date rows added.`);
  }
  console.log(`Matched sheet row ${row}`);

  await writeRow(auth, row, spend, leads);
  console.log(`Wrote row ${row}: B=${spend}, C=${leads}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
