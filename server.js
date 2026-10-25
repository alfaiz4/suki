import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const need = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "FR3_API_KEY", "WA_NUMBER"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error("Variabel belum diisi:", missing.join(", ")); process.exit(1); }

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, FR3_API_KEY, WA_NUMBER } = process.env;
const FR3_BASE = process.env.FR3_BASE || "https://fr3newera.com/api/v1";
const PAID = ["success", "paid", "settlement", "completed", "berhasil", "sukses"];
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pick = (d, keys) => { for (const k of keys) if (d?.[k] != null) return String(d[k]); return null; };

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// Hanya nilai publik yang dikirim ke browser (service role & FR3 key TIDAK pernah dikirim)
app.get("/config.js", (_req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store")
    .send(`window.__CFG=${JSON.stringify({ SUPABASE_URL, SUPABASE_ANON_KEY, WA_NUMBER })};`);
});

// Pembatas sederhana: 30 permintaan / menit / user
const hits = new Map();
const limited = (uid) => {
  const now = Date.now(), a = (hits.get(uid) || []).filter((t) => now - t < 60000);
  a.push(now); hits.set(uid, a); return a.length > 30;
};

app.post("/api/fr3", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const { data: { user } = {} } = await db.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (limited(user.id)) return res.status(429).json({ error: "Terlalu banyak permintaan" });

    const { action, order_id } = req.body || {};
    await db.rpc("expire_orders");
    const get = async () =>
      (await db.from("orders").select("*").eq("id", order_id).eq("user_id", user.id).single()).data;
    const o = await get();
    if (!o) return res.status(404).json({ error: "Pesanan tidak ditemukan" });

    if (action === "create") {
      if (o.status !== "pending") return res.status(400).json({ error: "Pesanan sudah tidak menunggu pembayaran" });
      if (o.pay_data) return res.json({ order: o });
      // klaim atomik: cegah 2 QRIS untuk 1 pesanan
      const { data: claim } = await db.from("orders").update({ pay_data: { creating: true } })
        .eq("id", o.id).is("pay_data", null).select("id");
      if (!claim?.length) return res.json({ order: await get() });

      const r = await fetch(`${FR3_BASE}/topup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apikey: FR3_API_KEY, nominal: o.total, add_mdr_to_customer: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.data) {
        await db.from("orders").update({ pay_data: null }).eq("id", o.id);
        return res.status(502).json({ error: j?.message || "Gagal membuat QRIS" });
      }
      const trx = pick(j.data, ["trx_id", "trxid", "transaction_id", "id", "invoice", "invoice_id"]);
      await db.from("orders").update({ pay_data: j.data, trx_id: trx }).eq("id", o.id);
      return res.json({ order: await get() });
    }

    if (action === "status") {
      if (o.status === "pending" && o.trx_id) {
        // ⚠ Sesuaikan nama query param dengan dokumentasi GET /check-status FR3
        const r = await fetch(`${FR3_BASE}/check-status?apikey=${encodeURIComponent(FR3_API_KEY)}&trx_id=${encodeURIComponent(o.trx_id)}`);
        const j = await r.json().catch(() => ({}));
        const st = String(j?.data?.status ?? j?.data?.payment_status ?? "").toLowerCase();
        if (PAID.includes(st)) {
          const now = new Date();
          await db.from("orders").update({
            status: "proses", paid_at: now.toISOString(),
            process_deadline: new Date(now.getTime() + 30 * 60000).toISOString(),
            updated_at: now.toISOString(),
          }).eq("id", o.id).eq("status", "pending");
        }
      }
      return res.json({ order: await get() });
    }
    res.status(400).json({ error: "Aksi tidak dikenal" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kesalahan server" });
  }
});

// Sapu pesanan kedaluwarsa tiap 30 detik (selain pengecekan saat dibuka)
setInterval(() => db.rpc("expire_orders").then(() => {}, () => {}), 30000);

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(dir, { extensions: ["html"] }));
app.get("/", (_req, res) => res.redirect("/index.html"));

app.listen(process.env.PORT || 3000, () => console.log("Server berjalan"));
