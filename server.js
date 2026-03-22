/*
 * ════════════════════════════════════════════════════════════════
 *   CLIMAS v3 — PRODUCTION SERVER  (updated)
 *
 *   npm install express mongoose bcryptjs jsonwebtoken
 *               socket.io cors nodemailer web-push axios
 *               africastalking dotenv
 *
 *   WHAT'S IN HERE:
 *   ✔  User register / login / JWT auth
 *   ✔  Paystack subscription (v2 Basic/Pro + v3 Basic/Pro)
 *   ✔  Device MAC-bound token system
 *   ✔  Token generation + email delivery
 *   ✔  Live readings via WebSocket
 *   ✔  PWA push notifications (web-push / VAPID)
 *   ✔  Africa's Talking — SMS alarm alert to user's phone
 *   ✔  Africa's Talking — Voice call to emergency contact (Pro)
 *   ✔  Server-side 8-second alarm timer → auto call trigger
 *   ✔  OpenWeather fetched server-side per user's city (v3 Pro)
 *   ✔  Alert logging + history
 *   ✔  Pre-order intake + email (POST /v1/order)
 *   ✔  Contact form + email (POST /v1/contact)
 *   ✔  Admin routes — list orders & contacts
 *
 *   .env template at the bottom of this file
 * ════════════════════════════════════════════════════════════════
 */

require("dotenv").config();
const express     = require("express");
const http        = require("http");
const mongoose    = require("mongoose");
const bcrypt      = require("bcryptjs");
const jwt         = require("jsonwebtoken");
const cors        = require("cors");
const nodemailer  = require("nodemailer");
const webpush     = require("web-push");
const axios       = require("axios");
const crypto      = require("crypto");
const { Server }  = require("socket.io");
const os          = require("os");

// Africa's Talking
const AfricasTalking = require("africastalking");
const AT = AfricasTalking({
  apiKey:   process.env.AT_API_KEY   || "sandbox_key",
  username: process.env.AT_USERNAME  || "sandbox",
});
const atSMS   = AT.SMS;
const atVoice = AT.VOICE;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for AT voice callbacks

/* ── VAPID ─────────────────────────────────────────── */
const VAPID = {
  pub:  process.env.VAPID_PUBLIC  || "",
  priv: process.env.VAPID_PRIVATE || "",
};
if (VAPID.pub && VAPID.priv) {
  webpush.setVapidDetails("mailto:" + (process.env.MAIL_USER || "admin@climas.com"), VAPID.pub, VAPID.priv);
} else {
  const keys = webpush.generateVAPIDKeys();
  VAPID.pub  = keys.publicKey;
  VAPID.priv = keys.privateKey;
  webpush.setVapidDetails("mailto:admin@climas.com", VAPID.pub, VAPID.priv);
  console.log("\n[VAPID] Keys generated — add to .env to persist:");
  console.log("  VAPID_PUBLIC="  + VAPID.pub);
  console.log("  VAPID_PRIVATE=" + VAPID.priv + "\n");
}

/* ── MongoDB ────────────────────────────────────────── */
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/climasv3")
  .then(() => console.log("[DB] MongoDB connected"))
  .catch(e  => console.log("[DB] MongoDB error:", e.message, "— running without DB"));

/* ══════════════════════════════════════════════════════
 *  SCHEMAS
 * ══════════════════════════════════════════════════════ */

const UserSchema = new mongoose.Schema({
  name:               String,
  email:              { type: String, unique: true, lowercase: true, trim: true },
  passwordHash:       String,
  plan:               { type: String, enum: ["none","basic","pro"], default: "none" },
  deviceModel:        { type: String, enum: ["v2","v3","none"], default: "none" },
  paystackSubId:      String,
  subExpiresAt:       Date,
  // Alert contacts
  phone:              String,   // their own number — receives SMS on alarm
  emergencyContact:   String,   // someone else's number — receives voice call (Pro)
  // OpenWeather (v3 Pro)
  city:               { type: String, default: "Kumasi" },
  // Push subscriptions
  pushSubs:           [Object],
  createdAt:          { type: Date, default: Date.now },
});
const User = mongoose.model("User", UserSchema);

const DeviceSchema = new mongoose.Schema({
  deviceId:   { type: String, unique: true },      // CLM-AABBCCDDEEFF (MAC)
  token:      { type: String, unique: true, sparse: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  name:       { type: String, default: "My Home" },
  plan:       String,
  active:     { type: Boolean, default: false },
  lastSeen:   Date,
  bound:      { type: Boolean, default: false },
});
const Device = mongoose.model("Device", DeviceSchema);

const ReadingSchema = new mongoose.Schema({
  deviceId:   String,
  temp:       Number,
  humidity:   Number,
  gas:        Number,
  alarm:      Boolean,
  mqEnabled:  Boolean,
  weather:    Object,   // { temp, humidity, description, city } — v3 Pro only
  ts:         { type: Date, default: Date.now },
});
ReadingSchema.index({ deviceId: 1, ts: -1 });
const Reading = mongoose.model("Reading", ReadingSchema);

const AlertSchema = new mongoose.Schema({
  deviceId:    String,
  userId:      mongoose.Schema.Types.ObjectId,
  gasLevel:    Number,
  smsSent:     { type: Boolean, default: false },
  callMade:    { type: Boolean, default: false },
  ts:          { type: Date, default: Date.now },
});
const Alert = mongoose.model("Alert", AlertSchema);

const OrderSchema = new mongoose.Schema({
  ref:          { type: String, unique: true },
  product:      String,
  productName:  String,
  qty:          { type: Number, default: 1 },
  name:         String,
  email:        String,
  phone:        String,
  address:      String,
  notes:        String,
  status:       { type: String, enum: ["pending","building","shipped","delivered"], default: "pending" },
  createdAt:    { type: Date, default: Date.now },
});
const Order = mongoose.model("Order", OrderSchema);

const ContactSchema = new mongoose.Schema({
  name:      String,
  email:     String,
  subject:   String,
  message:   String,
  read:      { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const Contact = mongoose.model("Contact", ContactSchema);

/* ══════════════════════════════════════════════════════
 *  IN-MEMORY STATE
 * ══════════════════════════════════════════════════════ */

// alarmTimers: deviceId → { startMs: Number, callMade: Boolean, alertId: String }
// Tracks how long each device has been in alarm state
const alarmTimers = new Map();

// weatherCache: userId → { data: Object, fetchedAt: Number }
// Refresh every 10 minutes — don't hammer OpenWeather
const weatherCache = new Map();
const WEATHER_TTL  = 10 * 60 * 1000; // 10 minutes

/* ══════════════════════════════════════════════════════
 *  HELPERS
 * ══════════════════════════════════════════════════════ */
const JWT_SECRET = process.env.JWT_SECRET || "climas_dev_secret_change_in_prod";

function signJWT(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: "No token" });
  try {
    req.userId = jwt.verify(h.split(" ")[1], JWT_SECRET).userId;
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
}

function generateActivationToken() {
  const h = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `CLM-${h.slice(0,4)}-${h.slice(4,8)}-${h.slice(8,12)}`;
}

/* ── Mailer ─────────────────────────────────────────── */
const mailer = process.env.MAIL_USER ? nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
}) : null;

/* ── Web Push to user ───────────────────────────────── */
async function pushToUser(userId, title, body, data = {}) {
  try {
    const user = await User.findById(userId);
    if (!user?.pushSubs?.length) return;
    const payload = JSON.stringify({ title, body, ...data });
    for (const sub of user.pushSubs) {
      webpush.sendNotification(sub, payload).catch(() => {});
    }
  } catch {}
}

/* ── Africa's Talking — SMS ─────────────────────────── */
async function sendAlarmSMS(user, gasLevel) {
  if (!user.phone) return;
  if (!process.env.AT_API_KEY || process.env.AT_API_KEY === "sandbox_key") {
    console.log(`[AT SMS] Would send to ${user.phone}: Gas alarm — level ${gasLevel}`);
    return;
  }
  try {
    await atSMS.send({
      to:      [user.phone.startsWith("+") ? user.phone : "+233" + user.phone.replace(/^0/, "")],
      message: `⚠️ CLIMAS ALERT: Dangerous gas detected at your home! Gas level: ${gasLevel}. Check immediately and ventilate the area. - CLIMAS Safety`,
      from:    process.env.AT_SENDER_ID || "CLIMAS",
    });
    console.log(`[AT SMS] ✓ Alarm SMS sent to ${user.phone}`);
  } catch (e) {
    console.error("[AT SMS] Error:", e.message);
  }
}

/* ── Africa's Talking — Voice Call ─────────────────── */
async function placeEmergencyCall(user, deviceId) {
  if (!user.emergencyContact) {
    console.log(`[AT CALL] No emergency contact set for user ${user.email}`);
    return false;
  }
  if (!process.env.AT_VIRTUAL_NUMBER || !process.env.AT_API_KEY || process.env.AT_API_KEY === "sandbox_key") {
    console.log(`[AT CALL] Would call ${user.emergencyContact} (AT not configured)`);
    return false;
  }
  try {
    const to = user.emergencyContact.startsWith("+")
      ? user.emergencyContact
      : "+233" + user.emergencyContact.replace(/^0/, "");

    await atVoice.call({
      callFrom: process.env.AT_VIRTUAL_NUMBER,
      callTo:   [to],
    });
    console.log(`[AT CALL] ✓ Emergency call placed to ${to} for device ${deviceId}`);
    return true;
  } catch (e) {
    console.error("[AT CALL] Error:", e.message);
    return false;
  }
}

/* ── OpenWeather fetch ──────────────────────────────── */
async function getWeather(user) {
  if (!process.env.OWM_KEY) return null;
  if (user.deviceModel !== "v3" || user.plan !== "pro") return null;

  const cached = weatherCache.get(user._id.toString());
  if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL) return cached.data;

  try {
    const city = user.city || "Kumasi";
    const r = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)},GH&appid=${process.env.OWM_KEY}&units=metric`
    );
    const d = r.data;
    const weather = {
      city:        d.name,
      temp:        Math.round(d.main.temp),
      feelsLike:   Math.round(d.main.feels_like),
      humidity:    d.main.humidity,
      description: d.weather[0].description,
      icon:        d.weather[0].main, // e.g. "Clouds", "Rain"
    };
    weatherCache.set(user._id.toString(), { data: weather, fetchedAt: Date.now() });
    return weather;
  } catch (e) {
    console.error("[OWM] Error:", e.message);
    return null;
  }
}

/* ── Token email ────────────────────────────────────── */
async function sendTokenEmail(email, name, token, plan, deviceModel) {
  if (!mailer) { console.log("[MAIL] No mailer — token:", token); return; }
  await mailer.sendMail({
    from:    `"CLIMAS" <${process.env.MAIL_USER}>`,
    to:      email,
    subject: "Your CLIMAS Device Activation Token",
    html: `
      <div style="font-family:monospace;background:#07090d;color:#eef0f6;padding:40px;border-radius:12px;max-width:500px;margin:0 auto">
        <h2 style="color:#0ea5e9;margin-bottom:4px;letter-spacing:2px">CLIMAS</h2>
        <p style="color:#475569;margin-bottom:24px;font-size:.85rem">Device Activation — ${(deviceModel||"v2").toUpperCase()}</p>
        <p style="color:#94a3b8;margin-bottom:8px">Hi ${name}, your <strong style="color:#eef0f6">${plan.toUpperCase()}</strong> subscription is confirmed.</p>
        <p style="color:#94a3b8;margin-bottom:16px">Enter this token in your device's setup portal to activate it:</p>
        <div style="background:#0c1a2e;border:1px solid rgba(14,165,233,.3);border-radius:8px;padding:20px;text-align:center;font-size:1.4rem;letter-spacing:4px;color:#0ea5e9;margin-bottom:16px">
          ${token}
        </div>
        <ol style="color:#94a3b8;line-height:2;padding-left:18px;font-size:.85rem">
          <li>Power on your CLIMAS device</li>
          <li>Connect your phone to the <strong style="color:#eef0f6">CLIMAS-SETUP</strong> WiFi</li>
          <li>A browser page will open — enter your home WiFi name, password and this token</li>
          <li>Your device connects and starts monitoring immediately</li>
        </ol>
        <div style="margin-top:18px;padding:12px;background:#0c1a2e;border-radius:8px;font-size:.75rem;color:#475569">
          This token is locked to your device hardware on first use.<br>
          Need help? Reply to this email.
        </div>
      </div>
    `
  });
}

/* ── Order email ────────────────────────────────────── */
async function sendOrderEmail(order) {
  if (!mailer) { console.log("[MAIL] No mailer — order:", order.ref); return; }

  await mailer.sendMail({
    from:    `"CLIMAS Orders" <${process.env.MAIL_USER}>`,
    to:      process.env.MAIL_USER,
    subject: `[NEW PRE-ORDER] ${order.ref} — ${order.productName} × ${order.qty}`,
    html: `
      <div style="font-family:monospace;background:#07090d;color:#eef0f6;padding:32px;border-radius:12px;max-width:500px;margin:0 auto">
        <h2 style="color:#0ea5e9;margin-bottom:4px;letter-spacing:2px">NEW PRE-ORDER</h2>
        <p style="color:#475569;margin-bottom:24px;font-size:.85rem">${new Date().toLocaleString()}</p>
        <table style="width:100%;border-collapse:collapse;font-size:.88rem">
          <tr><td style="color:#64748b;padding:6px 0">Ref</td><td style="color:#0ea5e9;font-weight:700">${order.ref}</td></tr>
          <tr><td style="color:#64748b;padding:6px 0">Product</td><td style="color:#eef0f6">${order.productName} × ${order.qty}</td></tr>
          <tr><td style="color:#64748b;padding:6px 0">Name</td><td style="color:#eef0f6">${order.name}</td></tr>
          <tr><td style="color:#64748b;padding:6px 0">Email</td><td style="color:#eef0f6">${order.email}</td></tr>
          <tr><td style="color:#64748b;padding:6px 0">Phone</td><td style="color:#eef0f6">${order.phone}</td></tr>
          <tr><td style="color:#64748b;padding:6px 0">Address</td><td style="color:#eef0f6">${order.address}</td></tr>
          ${order.notes ? `<tr><td style="color:#64748b;padding:6px 0">Notes</td><td style="color:#eef0f6">${order.notes}</td></tr>` : ""}
        </table>
        <div style="margin-top:20px;padding:14px;background:#0c1a2e;border-radius:8px;font-size:.8rem;color:#475569">
          Device is FREE. Contact customer to arrange delivery.<br>
          Allow 5 working days to build and deliver.
        </div>
      </div>
    `
  });

  await mailer.sendMail({
    from:    `"CLIMAS" <${process.env.MAIL_USER}>`,
    to:      order.email,
    subject: `Your CLIMAS Pre-order is Confirmed — ${order.ref}`,
    html: `
      <div style="font-family:monospace;background:#07090d;color:#eef0f6;padding:40px;border-radius:12px;max-width:500px;margin:0 auto">
        <h2 style="color:#0ea5e9;margin-bottom:4px;letter-spacing:2px">CLIMAS</h2>
        <p style="color:#475569;margin-bottom:24px;font-size:.85rem">Pre-order Confirmed</p>
        <p style="color:#94a3b8;margin-bottom:18px">Hi ${order.name.split(" ")[0]}, thank you for pre-ordering <strong style="color:#eef0f6">${order.productName}</strong>! 🎉</p>
        <div style="background:#0c1a2e;border:1px solid rgba(14,165,233,.3);border-radius:8px;padding:20px;margin-bottom:20px">
          <div style="color:#475569;font-size:.72rem;letter-spacing:2px;margin-bottom:8px">YOUR ORDER REFERENCE</div>
          <div style="font-size:1.3rem;letter-spacing:3px;color:#0ea5e9;font-weight:700">${order.ref}</div>
        </div>
        <ol style="color:#94a3b8;line-height:2;padding-left:18px;font-size:.88rem">
          <li>We will contact you within 24 hours to confirm delivery details</li>
          <li>Your device will be built and delivered within <strong style="color:#eef0f6">5 working days</strong></li>
          <li>Your activation token will be emailed when your device ships</li>
        </ol>
      </div>
    `
  });
}

async function sendContactEmail(msg) {
  if (!mailer) { console.log("[MAIL] No mailer — contact:", msg.email); return; }
  await mailer.sendMail({
    from:    `"CLIMAS Contact" <${process.env.MAIL_USER}>`,
    to:      process.env.MAIL_USER,
    subject: `[CONTACT] ${msg.subject} — ${msg.name}`,
    html: `<div style="font-family:monospace;background:#07090d;color:#eef0f6;padding:32px;border-radius:12px;max-width:500px;margin:0 auto"><h2 style="color:#0ea5e9;margin-bottom:4px">CONTACT</h2><p style="color:#475569">${new Date().toLocaleString()}</p><p style="color:#eef0f6">From: ${msg.name} &lt;${msg.email}&gt;</p><p style="color:#eef0f6">Subject: ${msg.subject}</p><div style="background:#0c1a2e;padding:14px;border-radius:8px;color:#94a3b8;margin-top:10px">${msg.message.replace(/\n/g,"<br>")}</div></div>`,
    replyTo: msg.email,
  });
}

/* ══════════════════════════════════════════════════════
 *  AUTH ROUTES
 * ══════════════════════════════════════════════════════ */

app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "All fields required" });
    if (await User.findOne({ email }))
      return res.status(409).json({ error: "Email already registered" });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, passwordHash });
    res.json({ token: signJWT(user._id), user: { name, email, plan: "none", deviceModel: "none" } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      return res.status(401).json({ error: "Invalid email or password" });
    res.json({
      token: signJWT(user._id),
      user: {
        name:             user.name,
        email,
        plan:             user.plan,
        deviceModel:      user.deviceModel || "none",
        phone:            user.phone || "",
        emergencyContact: user.emergencyContact || "",
        city:             user.city || "Kumasi",
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select("-passwordHash -pushSubs");
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

// Update profile — name, phone, emergencyContact, city
app.patch("/auth/me", authMiddleware, async (req, res) => {
  const { name, phone, emergencyContact, city, deviceModel } = req.body;
  const update = {};
  if (name)             update.name             = name;
  if (phone)            update.phone            = phone;
  if (emergencyContact) update.emergencyContact = emergencyContact;
  if (city)             update.city             = city;
  if (deviceModel)      update.deviceModel      = deviceModel;
  await User.findByIdAndUpdate(req.userId, update);
  // Clear weather cache so next reading fetches fresh data for new city
  if (city) weatherCache.delete(req.userId.toString());
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════
 *  DEVICE ROUTES — called by ESP8266
 * ══════════════════════════════════════════════════════ */

// Called on boot + every 6h
app.post("/v1/verify", async (req, res) => {
  try {
    const { token, device_id } = req.body;
    if (!token || !device_id)
      return res.json({ active: false, reason: "missing_fields" });

    const device = await Device.findOne({ token });
    if (!device) return res.json({ active: false, reason: "invalid_token" });
    if (!device.active) return res.json({ active: false, reason: "subscription_inactive" });

    // First use — bind token to this device MAC forever
    if (!device.bound) {
      device.deviceId = device_id;
      device.bound    = true;
      await device.save();
    } else if (device.deviceId !== device_id) {
      return res.json({ active: false, reason: "device_mismatch" });
    }

    const user = await User.findById(device.userId);
    if (!user || user.plan === "none")
      return res.json({ active: false, reason: "no_subscription" });

    device.lastSeen = new Date();
    await device.save();

    res.json({
      active:       true,
      plan:         user.plan,
      device_model: user.deviceModel || "v2",
      call_enabled: user.plan === "pro",
    });
  } catch (e) { res.json({ active: false, reason: "server_error" }); }
});

// Ingest sensor reading — core route
app.post("/v1/reading", async (req, res) => {
  try {
    const deviceId = req.headers["x-device-id"];
    const token    = req.headers["x-token"];
    const device   = await Device.findOne({ deviceId, token, active: true });
    if (!device) return res.status(403).json({ error: "Unauthorized" });

    const { temp, humidity, gas, alarm, mq_enabled } = req.body;

    // Fetch user for alerts + weather
    const user = await User.findById(device.userId);

    // Fetch weather if v3 + Pro
    const weather = await getWeather(user);

    // Save reading
    const reading = await Reading.create({
      deviceId,
      temp,
      humidity,
      gas,
      alarm,
      mqEnabled: mq_enabled,
      weather:   weather || null,
    });

    // Push live reading to dashboard via WebSocket
    io.to(`device:${deviceId}`).emit("reading", {
      temp, humidity, gas, alarm, mqEnabled: mq_enabled,
      weather: weather || null,
      ts: reading.ts.toISOString(),
    });

    // ── Alarm handling ──────────────────────────────
    if (alarm) {
      const now     = Date.now();
      const DEDUP   = 5 * 60 * 1000;  // only create one alert per 5 minutes
      const CALL_MS = 8000;           // trigger call after 8 seconds of continuous alarm

      let timer = alarmTimers.get(deviceId);

      if (!timer) {
        // First alarm reading — start timer, check if we need to create a new alert
        timer = { startMs: now, callMade: false, alertId: null };
        alarmTimers.set(deviceId, timer);

        // Create alert (dedup: not if there's one in the last 5 min)
        const recentAlert = await Alert.findOne({ deviceId }).sort({ ts: -1 });
        if (!recentAlert || (now - recentAlert.ts.getTime()) > DEDUP) {
          const alert = await Alert.create({ deviceId, userId: device.userId, gasLevel: gas });
          timer.alertId = alert._id.toString();

          // Web push notification
          await pushToUser(device.userId,
            "🚨 GAS ALARM — CLIMAS",
            `Dangerous gas detected: ${gas}. Check your home immediately.`,
            { alarm: true, gas }
          );

          // SMS to user's own phone
          if (user?.phone) {
            sendAlarmSMS(user, gas).then(async () => {
              await Alert.findByIdAndUpdate(alert._id, { smsSent: true });
            }).catch(() => {});
          }

          console.log(`\n🚨 [ALARM] Device ${deviceId} — gas ${gas} — alert created`);
        }
      }

      // Check if alarm has been active for >= 8 seconds → place call (Pro only)
      if (!timer.callMade && user?.plan === "pro" && (now - timer.startMs) >= CALL_MS) {
        timer.callMade = true;
        const called = await placeEmergencyCall(user, deviceId);
        if (called && timer.alertId) {
          await Alert.findByIdAndUpdate(timer.alertId, { callMade: true });
          io.to(`device:${deviceId}`).emit("call_triggered", { ts: new Date().toISOString() });
          await pushToUser(device.userId,
            "📞 Emergency Call Placed",
            "CLIMAS called your emergency contact.",
            { callMade: true }
          );
        }
      }

    } else {
      // Alarm cleared — reset timer
      if (alarmTimers.has(deviceId)) {
        console.log(`[ALARM] Device ${deviceId} — alarm cleared`);
        alarmTimers.delete(deviceId);
      }
    }

    device.lastSeen = new Date();
    await device.save();
    res.json({ ok: true, weather: weather || null });

  } catch (e) {
    console.error("[READING]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Africa's Talking voice callback ───────────────── */
// AT calls this URL when the emergency contact picks up
app.post("/v1/voice-callback", (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman" playBeep="false">
    This is an automated safety alert from CLIMAS.
    A dangerous gas leak has been detected at your home.
    Please check immediately and ensure the area is ventilated.
    I repeat — a gas leak has been detected. Please check immediately.
  </Say>
  <Pause duration="1"/>
  <Say voice="woman">This message was sent automatically by CLIMAS smart home safety.</Say>
</Response>`;
  res.set("Content-Type", "text/xml");
  res.send(xml);
});

/* ══════════════════════════════════════════════════════
 *  DASHBOARD API
 * ══════════════════════════════════════════════════════ */
app.get("/api/devices", authMiddleware, async (req, res) => {
  res.json(await Device.find({ userId: req.userId }));
});

app.patch("/api/devices/:id", authMiddleware, async (req, res) => {
  await Device.updateOne({ deviceId: req.params.id, userId: req.userId }, { name: req.body.name });
  res.json({ ok: true });
});

app.get("/api/devices/:id/latest", authMiddleware, async (req, res) => {
  res.json(await Reading.findOne({ deviceId: req.params.id }).sort({ ts: -1 }) || {});
});

app.get("/api/devices/:id/history", authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const data  = await Reading.find({ deviceId: req.params.id })
    .sort({ ts: -1 }).limit(limit).select("temp humidity gas alarm ts");
  res.json(data.reverse());
});

app.get("/api/alerts", authMiddleware, async (req, res) => {
  res.json(await Alert.find({ userId: req.userId }).sort({ ts: -1 }).limit(30));
});

/* ══════════════════════════════════════════════════════
 *  PUSH SUBSCRIPTION
 * ══════════════════════════════════════════════════════ */
app.get("/api/vapid-key", (req, res) => res.json({ key: VAPID.pub }));

app.post("/api/subscribe", authMiddleware, async (req, res) => {
  const sub  = req.body;
  const user = await User.findById(req.userId);
  if (!user.pushSubs) user.pushSubs = [];
  const exists = user.pushSubs.find(s => s.endpoint === sub.endpoint);
  if (!exists) { user.pushSubs.push(sub); await user.save(); }
  res.json({ ok: true });
});

app.post("/api/unsubscribe", authMiddleware, async (req, res) => {
  await User.findByIdAndUpdate(req.userId,
    { $pull: { pushSubs: { endpoint: req.body.endpoint } } });
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════
 *  PAYSTACK BILLING
 *
 *  Four plans on your Paystack dashboard:
 *  v2 Basic: GHS 18/mo   PAYSTACK_V2_BASIC_PLAN=PLN_xxx
 *  v2 Pro:   GHS 38/mo   PAYSTACK_V2_PRO_PLAN=PLN_xxx
 *  v3 Basic: GHS 28/mo   PAYSTACK_V3_BASIC_PLAN=PLN_xxx
 *  v3 Pro:   GHS 48/mo   PAYSTACK_V3_PRO_PLAN=PLN_xxx
 * ══════════════════════════════════════════════════════ */
const PS = process.env.PAYSTACK_SECRET_KEY || "";

// Billing amounts in pesewas (GHS × 100)
const PLAN_AMOUNTS = {
  v2_basic: 1800,
  v2_pro:   3800,
  v3_basic: 2800,
  v3_pro:   4800,
};

app.post("/billing/initialize", authMiddleware, async (req, res) => {
  try {
    const { plan, deviceModel } = req.body;  // plan = "basic"|"pro", deviceModel = "v2"|"v3"
    const key  = `${deviceModel || "v2"}_${plan}`;
    const planId = {
      v2_basic: process.env.PAYSTACK_V2_BASIC_PLAN,
      v2_pro:   process.env.PAYSTACK_V2_PRO_PLAN,
      v3_basic: process.env.PAYSTACK_V3_BASIC_PLAN,
      v3_pro:   process.env.PAYSTACK_V3_PRO_PLAN,
    }[key];

    if (!planId) return res.status(400).json({ error: "Invalid plan/model combination" });
    const user = await User.findById(req.userId);

    const r = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email:        user.email,
        amount:       PLAN_AMOUNTS[key],
        currency:     "GHS",
        plan:         planId,
        metadata:     { userId: req.userId.toString(), plan, deviceModel: deviceModel || "v2" },
        callback_url: `${process.env.SITE_URL || "http://localhost:3000"}/billing/callback`,
      },
      { headers: { Authorization: `Bearer ${PS}` } }
    );
    res.json({ url: r.data.data.authorization_url });
  } catch (e) {
    console.error("[PAYSTACK] Init error:", e.response?.data || e.message);
    res.status(500).json({ error: "Payment initialization failed" });
  }
});

app.get("/billing/callback", async (req, res) => {
  const { reference } = req.query;
  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PS}` } }
    );
    const data = verify.data.data;
    if (data.status !== "success") return res.redirect("/?payment=failed");

    const { userId, plan, deviceModel } = data.metadata;
    const token   = generateActivationToken();
    const expires = new Date(); expires.setMonth(expires.getMonth() + 1);

    await User.findByIdAndUpdate(userId, {
      plan,
      deviceModel: deviceModel || "v2",
      subExpiresAt: expires,
    });
    await Device.create({ token, userId, plan, active: true });

    const user = await User.findById(userId);
    await sendTokenEmail(user.email, user.name, token, plan, deviceModel);
    console.log(`[PAYSTACK] ✓ ${plan} (${deviceModel}) for ${user.email} — token: ${token}`);
    res.redirect(`/?payment=success&plan=${plan}&model=${deviceModel}`);
  } catch (e) {
    console.error("[PAYSTACK] Callback error:", e.message);
    res.redirect("/?payment=error");
  }
});

app.post("/billing/webhook", async (req, res) => {
  const hash = crypto.createHmac("sha512", PS)
    .update(JSON.stringify(req.body)).digest("hex");
  if (hash !== req.headers["x-paystack-signature"]) return res.status(400).send("Invalid");

  const { event, data } = req.body;
  console.log("[PAYSTACK WEBHOOK]", event);

  if (event === "subscription.create" || event === "invoice.payment_success") {
    const user = await User.findOne({ email: data.customer.email });
    if (user) {
      const expires = new Date(); expires.setMonth(expires.getMonth() + 1);
      await User.findByIdAndUpdate(user._id, { subExpiresAt: expires });
      await Device.updateMany({ userId: user._id }, { active: true });
    }
  }
  if (event === "subscription.disable" || event === "subscription.not_renew") {
    const user = await User.findOne({ email: data.customer.email });
    if (user) {
      await User.findByIdAndUpdate(user._id, { plan: "none" });
      await Device.updateMany({ userId: user._id }, { active: false });
    }
  }
  res.sendStatus(200);
});

/* ══════════════════════════════════════════════════════
 *  ORDER ROUTE  POST /v1/order
 * ══════════════════════════════════════════════════════ */
app.post("/v1/order", async (req, res) => {
  try {
    const { ref, product, product_name, qty, name, email, phone, address, notes } = req.body;
    if (!ref || !product || !name || !email || !phone || !address)
      return res.status(400).json({ error: "Missing required fields" });
    if (await Order.findOne({ ref }))
      return res.status(409).json({ error: "Duplicate order ref" });

    const order = await Order.create({
      ref, product, productName: product_name || product,
      qty: qty || 1, name, email: email.toLowerCase().trim(),
      phone, address, notes: notes || "",
    });
    console.log(`[ORDER] ✓ ${order.ref} — ${order.productName} × ${order.qty} — ${order.name}`);
    sendOrderEmail(order).catch(e => console.error("[ORDER MAIL]", e.message));
    res.json({ ok: true, ref: order.ref });
  } catch (e) {
    console.error("[ORDER]", e.message);
    res.status(500).json({ error: "Order failed — please email us directly" });
  }
});

/* ══════════════════════════════════════════════════════
 *  CONTACT ROUTE  POST /v1/contact
 * ══════════════════════════════════════════════════════ */
app.post("/v1/contact", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !subject || !message)
      return res.status(400).json({ error: "Missing required fields" });
    const msg = await Contact.create({ name, email: email.toLowerCase().trim(), subject, message });
    console.log(`[CONTACT] ✓ "${msg.subject}" from ${msg.name}`);
    sendContactEmail(msg).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Message failed" });
  }
});

/* ══════════════════════════════════════════════════════
 *  ADMIN ROUTES
 * ══════════════════════════════════════════════════════ */
function adminAuth(req, res, next) {
  if (req.headers["x-admin-key"] !== (process.env.ADMIN_KEY || "climas_admin"))
    return res.status(403).json({ error: "Forbidden" });
  next();
}

app.get("/admin/orders",   adminAuth, async (req, res) => res.json(await Order.find().sort({ createdAt: -1 })));
app.get("/admin/contacts", adminAuth, async (req, res) => res.json(await Contact.find().sort({ createdAt: -1 })));
app.get("/admin/alerts",   adminAuth, async (req, res) => res.json(await Alert.find().sort({ ts: -1 }).limit(50)));

app.patch("/admin/orders/:ref/status", adminAuth, async (req, res) => {
  const order = await Order.findOneAndUpdate(
    { ref: req.params.ref }, { status: req.body.status }, { new: true }
  );
  if (!order) return res.status(404).json({ error: "Not found" });
  if (req.body.status === "shipped" && mailer) {
    mailer.sendMail({
      from:    `"CLIMAS" <${process.env.MAIL_USER}>`,
      to:      order.email,
      subject: `Your CLIMAS device has shipped! — ${order.ref}`,
      html: `<div style="font-family:monospace;background:#07090d;color:#eef0f6;padding:40px;border-radius:12px;max-width:500px"><h2 style="color:#0ea5e9">CLIMAS</h2><p style="color:#94a3b8">Hi ${order.name.split(" ")[0]}, your <strong>${order.productName}</strong> has shipped and is on its way! Your activation token will arrive in a separate email shortly.</p><p style="color:#475569;font-size:.8rem">Order ref: ${order.ref}</p></div>`
    }).catch(() => {});
  }
  res.json({ ok: true, order });
});

/* ══════════════════════════════════════════════════════
 *  WEBSOCKET
 * ══════════════════════════════════════════════════════ */
io.use((socket, next) => {
  try {
    socket.userId = jwt.verify(socket.handshake.auth.token, JWT_SECRET).userId;
    next();
  } catch { next(new Error("Unauthorized")); }
});

io.on("connection", async socket => {
  socket.on("watch", async deviceId => {
    const dev = await Device.findOne({ deviceId, userId: socket.userId });
    if (dev) socket.join(`device:${deviceId}`);
  });
});

/* ── PWA files ──────────────────────────────────────── */
app.get("/manifest.json", (req, res) => res.json({
  name: "CLIMAS", short_name: "CLIMAS",
  description: "Smart Home Safety Monitor",
  start_url: "/app", display: "standalone",
  background_color: "#07090d", theme_color: "#07090d",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }]
}));

app.get("/icon.svg", (req, res) => {
  res.setHeader("Content-Type","image/svg+xml");
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#07090d"/><circle cx="50" cy="50" r="28" fill="none" stroke="#0ea5e9" stroke-width="3.5"/><text x="50" y="57" text-anchor="middle" font-family="monospace" font-size="18" font-weight="bold" fill="#0ea5e9">CLM</text></svg>`);
});

app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type","application/javascript");
  res.send(`
const CACHE="climas-v3";
self.addEventListener("install",e=>{self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(clients.claim())});
self.addEventListener("fetch",e=>{
  if(e.request.url.includes("/v1/")||e.request.url.includes("/api/")||e.request.url.includes("socket.io"))return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});
self.addEventListener("push",e=>{
  if(!e.data)return;
  let d;try{d=e.data.json()}catch{d={title:"CLIMAS",body:e.data.text()}}
  e.waitUntil(self.registration.showNotification(d.title||"CLIMAS",{
    body:d.body,icon:"/icon.svg",badge:"/icon.svg",
    vibrate:d.alarm?[200,100,200,100,400]:[200],
    tag:d.alarm?"gas-alarm":"climas",renotify:true,
    actions:d.alarm?[{action:"view",title:"View Dashboard"}]:[]
  }));
});
self.addEventListener("notificationclick",e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:"window"}).then(list=>{
    for(const c of list)if(c.focus)return c.focus();
    return clients.openWindow("/");
  }));
});
  `);
});

/* ── Serve website + app ────────────────────────────── */
const fs = require("fs");

// Marketing website — served at root
app.get("/", (req, res) => {
  try { res.send(fs.readFileSync(__dirname + "/website.html", "utf8")); }
  catch { res.send("<h2>website.html not found — place it in the same folder as server.js</h2>"); }
});

// Dashboard app — served at /app
app.get("/app", (req, res) => {
  try { res.send(fs.readFileSync(__dirname + "/app.html", "utf8")); }
  catch { res.send("<h2>app.html not found — place it in the same folder as server.js</h2>"); }
});

// Catch-all → website (handles SPA routing for website pages)
app.get(/\/.*/, (req, res) => {
  try { res.send(fs.readFileSync(__dirname + "/website.html", "utf8")); }
  catch { res.send("<h2>website.html not found</h2>"); }
});

/* ── Start ──────────────────────────────────────────── */
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const n of Object.keys(nets))
    for (const i of nets[n])
      if (i.family === "IPv4" && !i.internal) return i.address;
  return "localhost";
}

server.listen(3000, "0.0.0.0", () => {
  const ip = getLocalIP();
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║     CLIMAS — PRODUCTION SERVER           ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Local   → http://localhost:3000          ║`);
  console.log(`║  Network → http://${ip}:3000${" ".repeat(Math.max(0,21-ip.length))}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

/*
 * ═══════════════════════════════════════════════════════════
 *  .env TEMPLATE — save as .env in same folder as server.js
 * ═══════════════════════════════════════════════════════════
 *
 * MONGO_URI=mongodb://localhost:27017/climasv3
 * JWT_SECRET=your_super_secret_key_change_this
 * SITE_URL=https://yourngrok.ngrok.io
 * ADMIN_KEY=choose_a_secret_admin_password
 *
 * # Email (Gmail app password)
 * MAIL_USER=yourgmail@gmail.com
 * MAIL_PASS=xxxx_xxxx_xxxx_xxxx
 *
 * # Paystack — create 4 plans on Paystack dashboard
 * PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxx
 * PAYSTACK_V2_BASIC_PLAN=PLN_xxxxxxxxxxxxxxxx   # GHS 18/mo
 * PAYSTACK_V2_PRO_PLAN=PLN_xxxxxxxxxxxxxxxx     # GHS 38/mo
 * PAYSTACK_V3_BASIC_PLAN=PLN_xxxxxxxxxxxxxxxx   # GHS 28/mo
 * PAYSTACK_V3_PRO_PLAN=PLN_xxxxxxxxxxxxxxxx     # GHS 48/mo
 *
 * # Africa's Talking — https://africastalking.com
 * AT_API_KEY=atsk_xxxxxxxxxxxxxxxxxxxxxxxx
 * AT_USERNAME=your_at_username              # "sandbox" for testing
 * AT_SENDER_ID=CLIMAS                       # approved alphanumeric sender ID
 * AT_VIRTUAL_NUMBER=+233XXXXXXXXX           # your AT phone number for voice calls
 * VOICE_CALLBACK_URL=https://yourngrok.ngrok.io/v1/voice-callback
 *
 * # OpenWeather — https://openweathermap.org/api (free tier)
 * OWM_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * # VAPID — auto-generated on first run, paste output here
 * VAPID_PUBLIC=
 * VAPID_PRIVATE=
 * ═══════════════════════════════════════════════════════════
 */
