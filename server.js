import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const need = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ARIE_API_KEY", "WA_NUMBER"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error("Variabel belum diisi:", missing.join(", ")); process.exit(1); }

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ARIE_API_KEY, WA_NUMBER } = process.env;
// Provider: Ariepulsa QRISGO (POST form-urlencoded)
const ARIE_URL = process.env.ARIE_URL || "https://ariepulsa.com/api/qrisgo.php";
const TYPE_FEE = process.env.ARIE_TYPE_FEE || "1";
const ACT_CREATE = process.env.ARIE_ACTION_CREATE || "get-deposit";
const ACT_STATUS = process.env.ARIE_ACTION_STATUS || "status-deposit"; // ⚠ sesuaikan dengan dokumentasi "Cek Status"
const ACT_CANCEL = process.env.ARIE_ACTION_CANCEL || "cancel-deposit";
const PAID = ["success", "paid", "settlement", "completed", "berhasil", "sukses", "lunas", "settled"];

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pick = (d, keys) => { for (const k of keys) if (d?.[k] != null && typeof d[k] !== "object") return String(d[k]); return null; };
const truthy = (v) => v === true || v === "true" || v === 1 || v === "1";
const msgOf = (j) => j?.data?.pesan || j?.data?.message || j?.pesan || j?.message || j?.msg || null;
const isPaidText = (v) => {
  const t = String(v ?? "").toLowerCase();
  return !/unpaid|not|fail|gagal|expire|pending|created|belum/.test(t) && PAID.some((w) => t.includes(w));
};

async function arie(params) {
  const r = await fetch(ARIE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: ARIE_API_KEY, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  console.log("Arie", params.action, r.status, text.slice(0, 600));
  return { http: r.status, j };
}

const plus30 = () => new Date(Date.now() + 30 * 60000).toISOString();
async function setPaid(id) {
  await db.from("orders").update({
    status: "proses", paid_at: new Date().toISOString(), process_deadline: plus30(), updated_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "pending");
}
// Cek status ke gateway (dipakai tombol "Muat ulang" & polling)
async function markIfPaid(o) {
  if (o.status !== "pending" || !o.pay_data || o.pay_data.creating) return;
  try {
    const { j } = await arie({ action: ACT_STATUS, kode_deposit: o.invoice_id, reff_id: o.invoice_id });
    const d = j?.data;
    const st = String(d?.status ?? "").toLowerCase();
    if (st === "success" || isPaidText(st)) {
      if (d?.saldo_diterima != null && Number(d.saldo_diterima) < o.total) {
        console.error("Nominal tidak sesuai", o.invoice_id, d.saldo_diterima, o.total); return;
      }
      await setPaid(o.id);
    } else if (st === "error") { // dibatalkan / kedaluwarsa di sisi gateway
      await db.from("orders").update({ status: "gagal", fail_reason: "Pembayaran dibatalkan atau kedaluwarsa", gw_cancelled: true, updated_at: new Date().toISOString() })
        .eq("id", o.id).eq("status", "pending");
    }
  } catch (e) { console.error("status check error:", e); }
}
// Batalkan transaksi di gateway. Jika ternyata sudah dibayar → pesanan dipulihkan ke Proses.
async function cancelAtGateway(o) {
  const { j } = await arie({ action: ACT_CANCEL, kode_deposit: o.invoice_id });
  const pesan = String(msgOf(j) || "");
  const done = () => db.from("orders").update({ gw_cancelled: true }).eq("id", o.id);
  if (truthy(j?.status)) { await done(); return "cancelled"; }
  if (/success/i.test(pesan)) {
    await db.from("orders").update({ status: "proses", paid_at: new Date().toISOString(), process_deadline: plus30(),
      fail_reason: null, gw_cancelled: true, updated_at: new Date().toISOString() }).eq("id", o.id).eq("status", "gagal");
    return "paid";
  }
  if (/batal|kedaluwarsa|expired|tidak ditemukan|not found|cancel/i.test(pesan)) { await done(); return "done"; }
  return "error";
}

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const app = express();
app.disable("x-powered-by");
app.use((req, _res, next) => { if (req.path.startsWith("/api")) console.log("→", req.method, req.path); next(); });
app.get("/api/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));
app.use(express.json({ limit: "10kb" }));

// Hanya nilai publik yang dikirim ke browser
app.get("/config.js", (_req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-store")
    .send(`window.__CFG=${JSON.stringify({ SUPABASE_URL, SUPABASE_ANON_KEY, WA_NUMBER })};`);
});

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
      const pd = o.pay_data;
      if (pd && !pd.creating) return res.json({ order: o });
      if (pd && pd.creating && Date.now() - (pd.at || 0) < 20000) return res.json({ order: o });
      if (pd) await db.from("orders").update({ pay_data: null }).eq("id", o.id); // klaim macet → reset
      const { data: claim } = await db.from("orders").update({ pay_data: { creating: true, at: Date.now() } })
        .eq("id", o.id).is("pay_data", null).select("id");
      if (!claim?.length) return res.json({ order: await get() });

      let out;
      try {
        out = await arie({ action: ACT_CREATE, jumlah: String(o.total), reff_id: o.invoice_id, type_fee: TYPE_FEE });
      } catch (e) {
        console.error("Arie error:", e);
        await db.from("orders").update({ pay_data: null }).eq("id", o.id);
        return res.status(502).json({ error: "Tidak bisa menghubungi payment gateway" });
      }
      const { http, j } = out;
      if (!truthy(j?.status) || !(j?.data ?? null)) {
        await db.from("orders").update({ pay_data: null }).eq("id", o.id);
        return res.status(502).json({ error: (msgOf(j) || "Gagal membuat QRIS") + " (HTTP " + http + ")" });
      }
      await db.from("orders").update({ pay_data: j.data, trx_id: o.invoice_id }).eq("id", o.id);
      return res.json({ order: await get() });
    }

    if (action === "status") {
      await markIfPaid(o);
      return res.json({ order: await get() });
    }
    if (action === "cancel") {
      if (o.status !== "pending") return res.status(400).json({ error: "Pesanan tidak bisa dibatalkan" });
      await markIfPaid(o); // jangan batalkan kalau ternyata sudah dibayar
      const fresh = await get();
      if (fresh.status !== "pending") return res.status(409).json({ error: "Pembayaran sudah diterima, pesanan tidak bisa dibatalkan" });
      const uc = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: "Bearer " + token } }, auth: { persistSession: false } });
      const { error } = await uc.rpc("cancel_order", { p_id: o.id }); // batas 2x + cooldown 3 menit
      if (error) return res.status(400).json({ error: error.message });
      if (fresh.pay_data && !fresh.pay_data.creating) {
        try { await cancelAtGateway(fresh); } catch (e) { console.error("cancel gateway error:", e); } // dicoba ulang oleh sweeper
      } else await db.from("orders").update({ gw_cancelled: true }).eq("id", o.id);
      return res.json({ order: await get() });
    }
    res.status(400).json({ error: "Aksi tidak dikenal" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Kesalahan server" });
  }
});

// Tiap 30 dtk: tandai pesanan kedaluwarsa, lalu batalkan transaksinya di gateway
setInterval(async () => {
  try {
    await db.rpc("expire_orders");
    // pengganti callback: cek pesanan pending ke gateway walau pembeli sudah menutup halaman
    const { data: pend } = await db.from("orders").select("*").eq("status", "pending").not("pay_data", "is", null).limit(20);
    for (const o of pend || []) if (!o.pay_data?.creating) await markIfPaid(o);
    const { data } = await db.from("orders").select("*").eq("status", "gagal").eq("gw_cancelled", false)
      .not("pay_data", "is", null).limit(20);
    for (const o of data || []) {
      if (o.pay_data?.creating) { if (Date.now() - (o.pay_data.at || 0) > 60000) await db.from("orders").update({ gw_cancelled: true }).eq("id", o.id); continue; }
      await cancelAtGateway(o);
    }
  } catch (e) { console.error("sweeper:", e); }
}, 30000);

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(dir, { extensions: ["html"] }));
app.get("/", (_req, res) => res.redirect("/index.html"));
app.use((err, _req, res, _next) => { console.error("express error:", err); res.status(500).json({ error: "Kesalahan server" }); });
app.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("Server berjalan di port", process.env.PORT || 3000));
