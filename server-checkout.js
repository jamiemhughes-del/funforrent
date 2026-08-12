import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, extname } from "path";
import dotenv from "dotenv";

dotenv.config();

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
const IS_SANDBOX = process.env.SQUARE_ENVIRONMENT !== "production";
const SQUARE_API_BASE = IS_SANDBOX
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";

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

const PUBLIC = resolve(process.cwd(), "dist/public");
const PORT = process.env.PORT || 3000;

function serveFile(res, filePath) {
  if (!existsSync(filePath)) return false;
  const ext = extname(filePath);
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(filePath));
  return true;
}

// Helper: call Square REST API
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

  // ====== SQUARE CHECKOUT API ======
  if (pathname === "/api/checkout" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { amount, bookingId, customerName, customerEmail, description } = body;

      if (!amount || !bookingId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing amount or bookingId" }));
        return;
      }

      const amountInCents = Math.round(parseFloat(amount) * 100);
      const idempotencyKey = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

      const squareRes = await squareApi("/v2/online-checkout/payment-links", {
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: description || `FunForRent Booking #${bookingId}`,
          price_money: {
            amount: amountInCents,
            currency: "AUD",
          },
          location_id: LOCATION_ID,
        },
        checkout_options: {
          redirect_url: `${url.protocol}//${url.host}/`,
          ask_for_shipping_address: false,
        },
        pre_populated_data: customerEmail ? {
          buyer_email: customerEmail,
        } : undefined,
      });

      if (squareRes.payment_link?.url) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          checkoutUrl: squareRes.payment_link.url,
          orderId: squareRes.payment_link.order_id,
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
  console.log(`FunForRent Checkout Server running on port ${PORT}`);
  console.log(`Square env: ${IS_SANDBOX ? "sandbox" : "production"}`);
});
