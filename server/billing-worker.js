// Bait & See: Pro subscription check (Cloudflare Worker, free plan).
//
// The app sends Google Play's purchase receipt (a "purchase token") here. This worker asks
// Google whether the subscription is active, acknowledges new purchases (Google refunds any
// purchase that isn't acknowledged within 3 days), and tells the app whether to unlock Pro.
//
// Settings to add in Cloudflare (Workers > this worker > Settings > Variables):
//   PACKAGE_NAME  the Android app id, e.g. com.baitandsee.app
//   SA_EMAIL      the Google Cloud service account email linked in Play Console
//   SA_KEY        that service account's private key (the "private_key" value from its JSON
//                 key file). Add it as a Secret, not a plain variable.
//   APP_ORIGINS   comma-separated web addresses allowed to call this, e.g.
//                 https://baitandsee.com,https://baitandsee.pages.dev
//   PRODUCTS      comma-separated subscription ids, e.g. pro_monthly,pro_yearly

let cachedToken = null; // { value, exp }

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method !== "POST" || new URL(request.url).pathname !== "/verify") return reply({ error: "not found" }, 404);
    if (allowed.length && !allowed.includes(origin)) return reply({ error: "origin not allowed" }, 403);

    let body;
    try { body = await request.json(); } catch { return reply({ error: "bad request" }, 400); }
    const token = String(body.token || ""), sku = String(body.sku || "");
    const products = (env.PRODUCTS || "pro_monthly,pro_yearly").split(",").map((s) => s.trim());
    if (!token || token.length > 1000 || !products.includes(sku)) return reply({ error: "bad request" }, 400);

    try {
      const access = await googleToken(env);
      const base = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" +
        encodeURIComponent(env.PACKAGE_NAME) + "/purchases/subscriptions";
      const r = await fetch(base + "v2/tokens/" + encodeURIComponent(token), { headers: { Authorization: "Bearer " + access } });
      if (r.status === 404 || r.status === 410) return reply({ active: false });
      if (!r.ok) return reply({ error: "google " + r.status }, 502);
      const sub = await r.json();

      const items = (sub.lineItems || []).filter((li) => products.includes(li.productId));
      const expiry = Math.max(0, ...items.map((li) => Date.parse(li.expiryTime) || 0));
      const state = sub.subscriptionState || "";
      const active = items.length > 0 && expiry > Date.now() &&
        ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_CANCELED"].includes(state);

      if (active && sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
        const productId = items[0].productId;
        const ack = await fetch(base + "/" + encodeURIComponent(productId) + "/tokens/" + encodeURIComponent(token) + ":acknowledge", {
          method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" }, body: "{}",
        });
        if (!ack.ok) return reply({ error: "acknowledge failed " + ack.status }, 502);
      }
      // CANCELED means it won't renew, but the person keeps Pro until the paid time runs out.
      return reply({ active, expiry: expiry || null, state });
    } catch (e) {
      return reply({ error: "check failed" }, 502);
    }
  },
};

// Signs in to Google as the service account and returns an access token.
async function googleToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: env.SA_EMAIL, scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const pem = String(env.SA_KEY).replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + b64url(new Uint8Array(sig));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt,
  });
  if (!r.ok) throw new Error("google sign-in " + r.status);
  const j = await r.json();
  cachedToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.value;
}
function b64url(bytes) {
  let s = ""; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
