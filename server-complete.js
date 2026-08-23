import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, extname } from "path";
import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "funforrentgoldcoast@gmail.com";
const IS_SANDBOX = process.env.SQUARE_ENVIRONMENT !== "production";
const SQUARE_API_BASE = IS_SANDBOX
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";

const PUBLIC = resolve(process.cwd(), "dist/public");
const PORT = process.env.PORT || 3000;

// ── MIME types ──────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveFile(res, filePath) {
  if (!existsSync(filePath)) return false;
  const ext = extname(filePath);
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(filePath));
  return true;
}

// ── SQLite Database ─────────────────────────────────────────
const db = new Database("bookings.db");

// Bookings table
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_ref TEXT UNIQUE,
    items TEXT NOT NULL,
    total REAL NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    pickup_date TEXT NOT NULL,
    pickup_time TEXT NOT NULL,
    return_date TEXT,
    return_time TEXT,
    payment_id TEXT,
    payment_status TEXT DEFAULT 'pending',
    id_verification TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Inventory table - tracks booked quantities per date per item
db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    quantity_booked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, item_id)
  )
`);

// Settings table - stores config persistently
const defaultConfig = JSON.parse(readFileSync(resolve(PUBLIC, "config.json"), "utf-8"));
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Load config from DB or fallback to file
function loadConfig() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'config'").get();
    if (row) return JSON.parse(row.value);
  } catch { /* ignore */ }
  return defaultConfig;
}

function saveConfigToDb(config) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES ('config', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(JSON.stringify(config));
}
async function sendEmail(to, subject, html, text) {
  if (!RESEND_API_KEY) {
    console.log("[EMAIL SKIPPED] No RESEND_API_KEY configured");
    return { skipped: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `FunForRent <onboarding@resend.dev>`,
        to,
        subject,
        html,
        text,
      }),
    });
    const data = await res.json();
    if (data.id) {
      console.log(`[EMAIL SENT] to ${to}, id: ${data.id}`);
      return { sent: true, id: data.id };
    } else {
      console.error("[EMAIL FAILED]", data);
      return { error: data };
    }
  } catch (err) {
    console.error("[EMAIL ERROR]", err.message);
    return { error: err.message };
  }
}

// ── Helper: Check inventory ───────────────────────────────────
function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isTimeBlocked(date, time, blockoutTimes) {
  if (!time || !blockoutTimes) return false;
  const mins = timeToMinutes(time);
  for (const bt of blockoutTimes) {
    if (bt.date === date) {
      const startMins = timeToMinutes(bt.start);
      const endMins = timeToMinutes(bt.end);
      if (mins >= startMins && mins < endMins) {
        return bt;
      }
    }
  }
  return false;
}

function getAvailableQuantity(itemId, date, maxQuantity) {
  const row = db.prepare("SELECT quantity_booked FROM inventory WHERE date = ? AND item_id = ?").get(date, itemId);
  const booked = row ? row.quantity_booked : 0;
  return Math.max(0, maxQuantity - booked);
}

function bookInventory(itemId, date, quantity) {
  const stmt = db.prepare(`
    INSERT INTO inventory (date, item_id, quantity_booked)
    VALUES (?, ?, ?)
    ON CONFLICT(date, item_id) DO UPDATE SET
    quantity_booked = quantity_booked + excluded.quantity_booked
  `);
  stmt.run(date, itemId, quantity);
}

// ── Helper: Square API ──────────────────────────────────────
async function squareApi(path, body) {
  const res = await fetch(`${SQUARE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-08-08",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Server ──────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // ====== API: GET CONFIG ======
  if (pathname === "/api/config" && req.method === "GET") {
    const config = loadConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config));
    return;
  }

  // ====== API: CHECK INVENTORY + BLOCKOUTS ======
  if (pathname === "/api/inventory" && req.method === "GET") {
    const itemId = parseInt(url.searchParams.get("itemId") || "0");
    const date = url.searchParams.get("date");
    const maxQty = parseInt(url.searchParams.get("maxQuantity") || "0");
    const time = url.searchParams.get("time") || "";
    if (!itemId || !date || !maxQty) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing params" }));
      return;
    }
    // Check blockout dates
    try {
      const config = loadConfig();
      if (config.blockoutDates && config.blockoutDates.includes(date)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ available: 0, blocked: true }));
        return;
      }
      // Check time blockouts if time provided
      if (time && config.blockoutTimes) {
        const blocked = isTimeBlocked(date, time, config.blockoutTimes);
        if (blocked) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ available: 0, blocked: true, blockedReason: blocked.reason || "Blocked" }));
          return;
        }
      }
    } catch { /* ignore */ }
    const available = getAvailableQuantity(itemId, date, maxQty);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available }));
    return;
  }

  // ====== API: CREATE CHECKOUT ======
  if (pathname === "/api/checkout" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { amount, bookingId, customerName, customerEmail, customerPhone, items, pickupDate, pickupTime, returnDate, returnTime } = body;

      if (!amount || !items || !pickupDate) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing required fields" }));
        return;
      }

      // Check blockout dates
      try {
        const config = loadConfig();
        if (config.blockoutDates && config.blockoutDates.includes(pickupDate)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "This date is not available for booking. Please select another date." }));
          return;
        }
      } catch { /* ignore */ }

      // Check if pickup date/time is in the past
      const now = new Date();
      const pickupDateTime = new Date(`${pickupDate}T${pickupTime || '00:00'}`);
      if (pickupDateTime < now) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Pickup time has already passed. Please select a future time." }));
        return;
      }

      // Check return date is not before pickup date
      if (returnDate && pickupDate) {
        const pickup = new Date(pickupDate + "T12:00:00");
        const returnD = new Date(returnDate + "T12:00:00");
        if (returnD < pickup) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Return date cannot be before pickup date." }));
          return;
        }
      }

      // Check inventory before creating checkout
      for (const item of items) {
        const available = getAvailableQuantity(item.itemId, pickupDate, item.maxQuantity);
        if (available < item.quantity) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: `${item.name} is sold out for ${pickupDate}. Only ${available} left.` }));
          return;
        }
      }

      const amountInCents = Math.round(parseFloat(amount) * 100);
      const idempotencyKey = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
      const itemDesc = items.map((i) => `${i.name} x${i.quantity}`).join(", ");

      // Generate booking reference BEFORE creating Square checkout
      const bookingRef = `FFR-${Date.now().toString(36).toUpperCase().slice(-6)}`;

      const squareRes = await squareApi("/v2/online-checkout/payment-links", {
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: `FunForRent - ${itemDesc}`,
          price_money: {
            amount: amountInCents,
            currency: "AUD",
          },
          location_id: LOCATION_ID,
        },
        checkout_options: {
          redirect_url: `${url.protocol}//${url.host}/success.html?ref=${bookingRef}`,
          ask_for_shipping_address: false,
        },
        pre_populated_data: customerEmail ? {
          buyer_email: customerEmail,
        } : undefined,
      });

      if (squareRes.payment_link?.url) {
        // Pre-book inventory (will be confirmed on payment webhook)
        for (const item of items) {
          bookInventory(item.itemId, pickupDate, item.quantity);
        }

        // Save booking to database
        db.prepare(`
          INSERT INTO bookings (booking_ref, items, total, customer_name, customer_email, customer_phone, pickup_date, pickup_time, return_date, return_time, payment_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          bookingRef,
          JSON.stringify(items),
          amount,
          customerName || "",
          customerEmail || "",
          customerPhone || "",
          pickupDate,
          pickupTime || "",
          returnDate || "",
          returnTime || "",
          "pending"
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          checkoutUrl: squareRes.payment_link.url,
          orderId: squareRes.payment_link.order_id,
          bookingRef,
        }));
      } else {
        console.error("Square error:", squareRes);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: squareRes.errors?.[0]?.detail || "Could not create checkout" }));
      }
    } catch (err) {
      console.error("Checkout error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err?.message || "Checkout failed" }));
    }
    return;
  }

  // ====== API: PAYMENT SUCCESS WEBHOOK (simulated via redirect) ======
  if (pathname === "/api/booking-confirm" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { bookingRef, paymentId, paymentStatus } = body;

      // Update booking status
      db.prepare("UPDATE bookings SET payment_id = ?, payment_status = ? WHERE booking_ref = ?")
        .run(paymentId || "", paymentStatus || "completed", bookingRef);

      // Get booking details for emails
      const booking = db.prepare("SELECT * FROM bookings WHERE booking_ref = ?").get(bookingRef);
      let emailStatus = { business: false, customer: false };
      if (booking) {
        const items = JSON.parse(booking.items);
        const itemList = items.map((i) => `• ${i.name} x${i.quantity} - $${i.price}`).join("<br>");

        // Email to business
        const businessHtml = `
          <h2>New FunForRent Booking</h2>
          <p><strong>Ref:</strong> ${bookingRef}</p>
          <p><strong>Customer:</strong> ${booking.customer_name}</p>
          <p><strong>Email:</strong> ${booking.customer_email}</p>
          <p><strong>Phone:</strong> ${booking.customer_phone}</p>
          <p><strong>Pickup:</strong> ${booking.pickup_date} at ${booking.pickup_time}</p>
          <p><strong>Return:</strong> ${booking.return_date} at ${booking.return_time}</p>
          <h3>Items:</h3>
          <p>${itemList}</p>
          <p><strong>Total:</strong> $${booking.total}</p>
          <p><strong>Payment ID:</strong> ${paymentId}</p>
        `;

        const bizResult = await sendEmail(
          BUSINESS_EMAIL,
          `New Booking: ${bookingRef} - $${booking.total}`,
          businessHtml,
          `New booking ${bookingRef} from ${booking.customer_name} for $${booking.total}`
        );
        emailStatus.business = !!(bizResult.sent || bizResult.skipped);

        // Email to customer
        const customerHtml = `
          <h2>Thanks for your booking, ${booking.customer_name}!</h2>
          <p><strong>Booking Ref:</strong> ${bookingRef}</p>
          <h3>Your Items:</h3>
          <p>${itemList}</p>
          <p><strong>Pickup:</strong> ${booking.pickup_date} at ${booking.pickup_time}</p>
          <p><strong>Return:</strong> ${booking.return_date} at ${booking.return_time}</p>
          <p><strong>Total Paid:</strong> $${booking.total}</p>
          <hr>
          <p><strong>Location:</strong> Shop 6, 35 Orchid Ave, Surfers Paradise</p>
          <p><strong>Phone:</strong> 0411 181 571</p>
          <p>Please bring ID to collect your equipment.</p>
        `;

        const custResult = await sendEmail(
          booking.customer_email,
          `FunForRent Booking Confirmed - ${bookingRef}`,
          customerHtml,
          `Your booking ${bookingRef} is confirmed. Pickup: ${booking.pickup_date} at ${booking.pickup_time}. Total: $${booking.total}`
        );
        emailStatus.customer = !!(custResult.sent || custResult.skipped);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, emailStatus }));
    } catch (err) {
      console.error("Confirm error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ====== API: TEST EMAIL ======
  if (pathname === "/api/test-email" && req.method === "GET") {
    try {
      const testResult = await sendEmail(
        BUSINESS_EMAIL,
        "FunForRent Test Email",
        "<h2>This is a test email from FunForRent</h2><p>If you received this, your email configuration is working correctly.</p>",
        "This is a test email from FunForRent. If you received this, your email configuration is working correctly."
      );
      if (testResult.sent || testResult.skipped) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, result: testResult }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: testResult.error || "Email failed" }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ====== API: GET BOOKINGS (for admin) ======
  if (pathname === "/api/bookings" && req.method === "GET") {
    try {
      const bookings = db.prepare("SELECT * FROM bookings ORDER BY created_at DESC").all();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, bookings }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ====== API: UPDATE BOOKING STATUS ======
  if (pathname === "/api/booking-status" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { bookingRef, status } = body;
      db.prepare("UPDATE bookings SET payment_status = ? WHERE booking_ref = ?").run(status, bookingRef);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ====== API: SAVE CONFIG (admin) ======
  if (pathname === "/api/config" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      saveConfigToDb(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ====== API: UPLOAD IMAGE (admin) ======
  if (pathname === "/api/upload" && req.method === "POST") {
    try {
      // Simple multipart parser for single file upload
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";
      const boundary = contentType.split("boundary=")[1];
      if (!boundary) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "No boundary" }));
        return;
      }
      const parts = buffer.toString("binary").split(`--${boundary}`);
      const filePart = parts.find(p => p.includes("Content-Disposition") && p.includes("filename="));
      if (!filePart) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "No file" }));
        return;
      }
      const filenameMatch = filePart.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : `upload-${Date.now()}.jpg`;
      const safeName = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
      const uniqueName = `${Date.now()}-${safeName}`;
      const uploadDir = resolve(PUBLIC, "items");
      if (!existsSync(uploadDir)) {
        const { mkdirSync } = await import("fs");
        mkdirSync(uploadDir, { recursive: true });
      }
      const filePath = resolve(uploadDir, uniqueName);
      // Extract binary data after empty line
      const binaryStart = filePart.indexOf("\r\n\r\n");
      const binaryData = filePart.slice(binaryStart + 4).replace(/\r\n$/, "");
      writeFileSync(filePath, Buffer.from(binaryData, "binary"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, url: `/items/${uniqueName}` }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ====== STATIC FILES ======
  let filePath = resolve(PUBLIC, pathname === "/" ? "index.html" : pathname.slice(1));
  if (existsSync(filePath) && !filePath.endsWith("/")) {
    serveFile(res, filePath);
    return;
  }
  if (!extname(pathname)) {
    serveFile(res, resolve(PUBLIC, "index.html"));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`FunForRent Server running on port ${PORT}`);
  console.log(`Square env: ${IS_SANDBOX ? "sandbox" : "production"}`);
  console.log(`Database: bookings.db`);
  console.log(`Email: ${RESEND_API_KEY ? "enabled" : "disabled (set RESEND_API_KEY)"}`);
});
