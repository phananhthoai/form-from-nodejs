import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";

const app = express();
app.use(express.json());

// ===== ENV =====
const CHATWOOT_BASE = process.env.CHATWOOT_BASE || "https://chatwoot.hellking.dev";
const ACCOUNT_ID    = process.env.ACCOUNT_ID || "1";
const INBOX_ID      = process.env.INBOX_ID || "2"; // có thể để trống nếu chỉ lưu contact
const API_TOKEN     = process.env.CW_API_TOKEN;   // bắt buộc
const ALLOW_ORIGIN  = process.env.ALLOW_ORIGIN || "https://bachuchientruong.online";
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";

// SMTP
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;
const FROM_NAME  = process.env.FROM_NAME  || "Digital Service";

if (!API_TOKEN) { console.error("Missing CW_API_TOKEN"); process.exit(1); }
app.use(cors({ origin: ALLOW_ORIGIN, credentials: false }));

// Mailer
const mailer = (SMTP_USER && SMTP_PASS) ? nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

// Helper gọi Chatwoot API
async function cw(path, method, body) {
  const res = await fetch(`${CHATWOOT_BASE}/api/v1/accounts/${ACCOUNT_ID}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "api_access_token": API_TOKEN,
      "Authorization": `Token token=${API_TOKEN}`, // fallback nếu ingress kén "_"
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json; try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

// Lấy email contact từ conversation
async function getContactEmailByConversation(convId) {
  const conv = await cw(`/conversations/${convId}`, "GET");
  const tryEmail =
      conv?.meta?.sender?.email ||
      conv?.meta?.contact?.email ||
      conv?.contact?.email;
  if (tryEmail) return tryEmail;

  const contactId =
      conv?.meta?.sender?.id ||
      conv?.meta?.contact?.id ||
      conv?.contact?.id;
  if (contactId) {
    const contact = await cw(`/contacts/${contactId}`, "GET");
    return contact?.email || null;
  }
  return null;
}

app.post("/api/leads", async (req, res) => {
  try {
    const { name, email, phone, plan, note } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: "name & email required" });

    // 1) Tạo/ghi Contact
    const c = await cw(`/contacts`, "POST", {
      name, email, phone_number: phone,
      custom_attributes: { plan: plan || "Free", source: "web-form", note: note || "" }
    });
    const contact = c?.payload?.contact || c;
    const contact_id = contact.id;

    // 2) (tuỳ chọn) Tạo conversation + thả message để agent thấy lead
    let convId = null;
    if (INBOX_ID) {
      try {
        const conv = await cw(`/conversations`, "POST",
          { inbox_id: Number(INBOX_ID), contact_id, status: "open" }
        );
        convId = conv.id;
      } catch {
        const conv = await cw(`/conversations`, "POST",
          { inbox_id: Number(INBOX_ID), source_id: contact_id, status: "open" }
        );
        convId = conv.id;
      }
      await cw(`/conversations/${convId}/messages`, "POST", {
        content: `Lead: ${name} | ${email} | ${phone || ""} | ${plan || ""}\n${note || ""}`,
        message_type: "incoming"
      });
    }

    res.json({ ok: true, contact_id, conversation_id: convId });
  } catch (e) {
    console.error("LEAD_ERR", e.message);
    res.status(500).send(e.message);
  }
});

// Webhook: agent reply -> gửi mail cho khách
app.post("/api/chatwoot/webhook", async (req, res) => {
  try {
    if (WEBHOOK_TOKEN && req.headers["x-chatwoot-token"] !== WEBHOOK_TOKEN) return res.sendStatus(401);

    const event = req.body?.event || req.body?.name;
    const msg   = req.body?.data?.message || req.body?.message;

    // chỉ xử lý khi agent trả lời (message_type=1) và không private
    if (event === "message.created" && msg && msg.message_type === 1 && !msg.private) {
      if (!mailer) { console.warn("SMTP not configured; skip email"); return res.sendStatus(200); }

      const toEmail = await getContactEmailByConversation(msg.conversation_id);
      if (!toEmail) { console.warn("No contact email; skip"); return res.sendStatus(200); }

      await mailer.sendMail({
        from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to: toEmail,
        subject: "Phản hồi từ Digital Service",
        text: msg.content || "",
        html: `<p>${(msg.content || "").replace(/\n/g,"<br>")}</p>`
      });
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK_ERR", e.message);
    // vẫn 200 để Chatwoot không retry dồn dập
    res.sendStatus(200);
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Lead API listening on :" + PORT));

