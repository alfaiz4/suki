// Supabase dimuat lewat <script> CDN di index.html (variabel global "supabase")
const createClient = window.supabase && window.supabase.createClient;

// CONFIGURATION - GANTI DENGAN CREDENTIAL KAMU
const SUPABASE_URL = window.__CFG.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.__CFG.SUPABASE_ANON_KEY;

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;
const PHONE_CHANNEL = "sms";        // "sms" atau "whatsapp" (WhatsApp butuh Twilio di Supabase)
const DEFAULT_COUNTRY_CODE = "62";  // Indonesia
const HOME_URL = "home.html";       // tujuan setelah login / daftar berhasil

const $ = (s) => document.querySelector(s);
const configured = !/[\[\]]/.test(SUPABASE_URL + SUPABASE_ANON_KEY);

/* ---------- Penyimpanan sesi (mendukung "Ingat Saya") ---------- */
const REMEMBER_KEY = "polos-remember";
const PENDING_KEY = "polos-pending";
const END_KEY = "polos-otp-end";
const RESET_KEY = "polos-reset";
const RESET_END_KEY = "polos-reset-end";
const NOAUTO_KEY = "polos-noauto"; // diset home.html saat sesi tidak valid, mencegah loop
const adaptiveStorage = {
  getItem: (k) => localStorage.getItem(k) ?? sessionStorage.getItem(k),
  setItem: (k, v) => {
    const persist = localStorage.getItem(REMEMBER_KEY) !== "0";
    (persist ? sessionStorage : localStorage).removeItem(k);
    (persist ? localStorage : sessionStorage).setItem(k, v);
  },
  removeItem: (k) => { localStorage.removeItem(k); sessionStorage.removeItem(k); },
};

const sb = configured && createClient
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage: adaptiveStorage, persistSession: true, autoRefreshToken: true },
    })
  : null;
if (!configured) $("#notice").hidden = false;
else if (!createClient) {
  $("#notice").textContent = "Library Supabase gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.";
  $("#notice").hidden = false;
}

/* ---------- Tema gelap / terang ---------- */
const root = document.documentElement;
const sw = $("#theme");
const isDark = () => root.dataset.theme
  ? root.dataset.theme === "dark"
  : matchMedia("(prefers-color-scheme: dark)").matches;
const syncSwitch = () => sw.setAttribute("aria-checked", isDark());
try {
  const t = localStorage.getItem("polos-tema");
  if (t === "dark" || t === "light") root.dataset.theme = t;
} catch (e) {}
syncSwitch();
sw.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  root.dataset.theme = next;
  syncSwitch();
  try { localStorage.setItem("polos-tema", next); } catch (e) {}
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncSwitch);

/* ---------- Helper ---------- */
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function parseContact(raw) {
  const v = raw.trim();
  if (isEmail(v)) return { type: "email", value: v.toLowerCase() };
  let d = v.replace(/[\s\-().]/g, "");
  if (!/^\+?\d{8,15}$/.test(d)) return null;
  if (d.startsWith("+")) return { type: "phone", value: d };
  if (d.startsWith("0")) d = DEFAULT_COUNTRY_CODE + d.slice(1);
  else if (!d.startsWith(DEFAULT_COUNTRY_CODE)) d = DEFAULT_COUNTRY_CODE + d;
  return { type: "phone", value: "+" + d };
}

function setMsg(el, text, ok = false) {
  el.textContent = text;
  el.classList.toggle("ok", ok);
}

function guard(msgEl) {
  if (sb) return true;
  setMsg(msgEl, configured
    ? "Library Supabase belum termuat. Periksa internet lalu muat ulang."
    : "Isi SUPABASE_URL dan SUPABASE_ANON_KEY di app.js terlebih dahulu.");
  return false;
}

function busy(btn, on, label = "Memproses…") {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

function friendly(e) {
  const m = (e.message || "").toLowerCase();
  if (m.includes("provider is not enabled") || m.includes("unsupported provider")) return "Login Google belum diaktifkan di Supabase (Auth → Providers → Google).";
  if (m.includes("only request this after")) return "Tunggu 60 detik sebelum meminta kode lagi.";
  if (m.includes("different from the old")) return "Password baru harus berbeda dari password lama.";
  if (m.includes("at least") && m.includes("character")) return "Password terlalu pendek. Minimal 8 karakter.";
  if (m.includes("signups not allowed")) return "Akun dengan nomor ini tidak ditemukan.";
  if (m.includes("already registered")) return "Akun sudah terdaftar. Silakan masuk.";
  if (m.includes("invalid login")) return "Email/nomor HP atau password salah.";
  if (m.includes("rate limit") || e.status === 429) return "Terlalu banyak percobaan. Coba lagi beberapa saat.";
  if (m.includes("expired") || m.includes("invalid")) return "Kode salah atau sudah kedaluwarsa.";
  return e.message || "Terjadi kesalahan. Coba lagi.";
}

const resendPayload = (p) =>
  p.type === "email" ? { type: "signup", email: p.value } : { type: "sms", phone: p.value };
const verifyPayload = (p, token) =>
  p.type === "email"
    ? { email: p.value, token, type: "signup" }
    : { phone: p.value, token, type: "sms" };

const getReset = () => {
  try { return JSON.parse(sessionStorage.getItem(RESET_KEY)); } catch (e) { return null; }
};
const getPending = () => {
  try { return JSON.parse(sessionStorage.getItem(PENDING_KEY)); } catch (e) { return null; }
};

/* ---------- Timer kirim ulang OTP ---------- */
let timerId;
function startTimer() {
  sessionStorage.setItem(END_KEY, String(Date.now() + RESEND_SECONDS * 1000));
  tick();
}
function tick() {
  clearInterval(timerId);
  const btn = $("#btn-resend");
  const update = () => {
    const left = Math.ceil((Number(sessionStorage.getItem(END_KEY) || 0) - Date.now()) / 1000);
    if (left > 0) {
      btn.disabled = true;
      btn.textContent = `Kirim ulang OTP (${left} dtk)`;
    } else {
      btn.disabled = false;
      btn.textContent = "Kirim ulang OTP";
      clearInterval(timerId);
    }
  };
  update();
  timerId = setInterval(update, 1000);
}

/* ---------- Kotak input OTP ---------- */
const boxes = Array.from({ length: OTP_LENGTH }, (_, i) => {
  const b = document.createElement("input");
  b.className = "otp-box";
  b.inputMode = "numeric";
  b.maxLength = 1;
  b.autocomplete = i === 0 ? "one-time-code" : "off";
  b.setAttribute("aria-label", `Digit ${i + 1}`);
  $("#otp-boxes").append(b);
  return b;
});
boxes.forEach((b, i) => {
  b.addEventListener("input", () => {
    b.value = b.value.replace(/\D/g, "").slice(-1);
    if (b.value && boxes[i + 1]) boxes[i + 1].focus();
  });
  b.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !b.value && boxes[i - 1]) {
      boxes[i - 1].value = "";
      boxes[i - 1].focus();
    }
  });
  b.addEventListener("paste", (e) => {
    e.preventDefault();
    const d = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, OTP_LENGTH);
    d.split("").forEach((ch, k) => (boxes[k].value = ch));
    boxes[Math.min(d.length, OTP_LENGTH - 1)].focus();
  });
});
const clearBoxes = () => boxes.forEach((b) => (b.value = ""));

/* ---------- Routing sederhana (hash) + protected route ---------- */
const views = ["login", "register", "otp", "forgot", "reset"];
const titles = { login: "Masuk", register: "Daftar", otp: "Verifikasi", forgot: "Lupa Password", reset: "Password Baru" };
let session = null;

function show(view) {
  views.forEach((v) => ($(`#view-${v}`).hidden = v !== view));
  document.title = `NeoGroup — ${titles[view]}`;
  if (view === "otp") {
    $("#otp-target").textContent = getPending().value;
    tick();
    boxes[0].focus();
  }
  if (view === "forgot") $("#forgot-contact").focus();
  if (view === "reset") {
    $("#reset-target").textContent = getReset().value;
    tickReset();
    $("#reset-code").focus();
  }
}

async function route() {
  const hash = location.hash.replace("#/", "");
  let view = views.includes(hash) ? hash : "login";
  if (sb) {
    const { data } = await sb.auth.getSession();
    session = data.session;
  }
  const skipAuto = sessionStorage.getItem(NOAUTO_KEY);
  sessionStorage.removeItem(NOAUTO_KEY);
  if (session && !skipAuto) { location.replace(HOME_URL); return; } // sudah login
  if (view === "otp" && !getPending()) view = "register";
  if (view === "reset" && !getReset()) view = "forgot";
  show(view);
}

function go(view) {
  if (location.hash === `#/${view}`) route();
  else location.hash = `#/${view}`;
}
window.addEventListener("hashchange", route);

/* ---------- Register ---------- */
$("#form-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#msg-register");
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  setMsg(msg, "");
  if (!guard(msg)) return;

  const name = $("#reg-name").value.trim();
  const c = parseContact($("#reg-contact").value);
  const pw = $("#reg-password").value;
  if (name.length < 2) return setMsg(msg, "Nama lengkap minimal 2 karakter.");
  if (!c) return setMsg(msg, "Masukkan email atau nomor WhatsApp yang valid.");
  if (pw.length < 8) return setMsg(msg, "Password minimal 8 karakter.");

  busy(btn, true, "Mengirim kode…");
  const payload = c.type === "email"
    ? { email: c.value, password: pw, options: { data: { full_name: name } } }
    : { phone: c.value, password: pw, options: { data: { full_name: name }, channel: PHONE_CHANNEL } };
  localStorage.setItem(REMEMBER_KEY, "1");
  const { data, error } = await sb.auth.signUp(payload);
  busy(btn, false);
  if (error) return setMsg(msg, friendly(error));
  if (data && data.session) { location.href = HOME_URL; return; } // jika konfirmasi OTP dimatikan di Supabase

  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...c, name }));
  clearBoxes();
  setMsg($("#msg-otp"), "");
  startTimer();
  go("otp");
});

/* ---------- Verifikasi OTP ---------- */
$("#form-otp").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#msg-otp");
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  setMsg(msg, "");
  if (!guard(msg)) return;

  const p = getPending();
  if (!p) return go("register");
  const token = boxes.map((b) => b.value).join("");
  if (token.length < OTP_LENGTH) return setMsg(msg, `Masukkan ${OTP_LENGTH} digit kode OTP.`);

  localStorage.setItem(REMEMBER_KEY, "1");
  busy(btn, true, "Memverifikasi…");
  const { error } = await sb.auth.verifyOtp(verifyPayload(p, token));
  busy(btn, false);
  if (error) return setMsg(msg, friendly(error));

  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(END_KEY);
  clearInterval(timerId);
  location.href = HOME_URL;
});

$("#btn-resend").addEventListener("click", async () => {
  const msg = $("#msg-otp");
  setMsg(msg, "");
  if (!guard(msg)) return;
  const p = getPending();
  if (!p) return go("register");
  $("#btn-resend").disabled = true;
  const { error } = await sb.auth.resend(resendPayload(p));
  if (error) { $("#btn-resend").disabled = false; return setMsg(msg, friendly(error)); }
  clearBoxes();
  boxes[0].focus();
  startTimer();
  setMsg(msg, "Kode baru sudah dikirim.", true);
});

$("#otp-back").addEventListener("click", () => {
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(END_KEY);
  clearInterval(timerId);
});

/* ---------- Lupa password (kode OTP lewat email / SMS / WhatsApp) ---------- */
let resetTimerId;
let resetVerified = false; // kode hanya bisa dipakai sekali; jangan diverifikasi ulang jika password gagal disimpan

function startResetTimer() {
  sessionStorage.setItem(RESET_END_KEY, String(Date.now() + RESEND_SECONDS * 1000));
  tickReset();
}
function tickReset() {
  clearInterval(resetTimerId);
  const btn = $("#btn-reset-resend");
  const update = () => {
    const left = Math.ceil((Number(sessionStorage.getItem(RESET_END_KEY) || 0) - Date.now()) / 1000);
    if (left > 0) {
      btn.disabled = true;
      btn.textContent = `Kirim ulang kode (${left} dtk)`;
    } else {
      btn.disabled = false;
      btn.textContent = "Kirim ulang kode";
      clearInterval(resetTimerId);
    }
  };
  update();
  resetTimerId = setInterval(update, 1000);
}

const sendResetCode = (c) =>
  c.type === "email"
    ? sb.auth.resetPasswordForEmail(c.value)
    : sb.auth.signInWithOtp({ phone: c.value, options: { channel: PHONE_CHANNEL, shouldCreateUser: false } });

$("#form-forgot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#msg-forgot");
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  setMsg(msg, "");
  if (!guard(msg)) return;

  const c = parseContact($("#forgot-contact").value);
  if (!c) return setMsg(msg, "Masukkan email atau nomor HP yang valid.");

  busy(btn, true, "Mengirim kode…");
  const { error } = await sendResetCode(c);
  busy(btn, false);
  if (error) return setMsg(msg, friendly(error));

  sessionStorage.setItem(RESET_KEY, JSON.stringify(c));
  resetVerified = false;
  $("#reset-code").value = "";
  $("#reset-password").value = "";
  setMsg($("#msg-reset"), "");
  startResetTimer();
  go("reset");
});

$("#form-reset").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#msg-reset");
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  setMsg(msg, "");
  if (!guard(msg)) return;

  const c = getReset();
  if (!c) return go("forgot");
  const code = $("#reset-code").value.replace(/\D/g, "");
  const pw = $("#reset-password").value;
  if (!resetVerified && code.length < OTP_LENGTH) return setMsg(msg, `Masukkan ${OTP_LENGTH} digit kode.`);
  if (pw.length < 8) return setMsg(msg, "Password minimal 8 karakter.");

  localStorage.setItem(REMEMBER_KEY, "1");
  busy(btn, true, "Menyimpan…");
  if (!resetVerified) {
    const { error: verr } = await sb.auth.verifyOtp(
      c.type === "email"
        ? { email: c.value, token: code, type: "recovery" }
        : { phone: c.value, token: code, type: "sms" }
    );
    if (verr) { busy(btn, false); return setMsg(msg, friendly(verr)); }
    resetVerified = true;
  }
  const { error: uerr } = await sb.auth.updateUser({ password: pw });
  busy(btn, false);
  if (uerr) return setMsg(msg, friendly(uerr));

  sessionStorage.removeItem(RESET_KEY);
  sessionStorage.removeItem(RESET_END_KEY);
  clearInterval(resetTimerId);
  location.href = HOME_URL;
});

$("#btn-reset-resend").addEventListener("click", async () => {
  const msg = $("#msg-reset");
  setMsg(msg, "");
  if (!guard(msg)) return;
  const c = getReset();
  if (!c) return go("forgot");
  $("#btn-reset-resend").disabled = true;
  const { error } = await sendResetCode(c);
  if (error) { $("#btn-reset-resend").disabled = false; return setMsg(msg, friendly(error)); }
  startResetTimer();
  setMsg(msg, "Kode baru sudah dikirim.", true);
});

$("#reset-back").addEventListener("click", () => {
  sessionStorage.removeItem(RESET_KEY);
  sessionStorage.removeItem(RESET_END_KEY);
  clearInterval(resetTimerId);
});

/* ---------- Login ---------- */
$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#msg-login");
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  setMsg(msg, "");
  if (!guard(msg)) return;

  const c = parseContact($("#log-contact").value);
  const pw = $("#log-password").value;
  if (!c) return setMsg(msg, "Masukkan email atau nomor HP yang valid.");
  if (!pw) return setMsg(msg, "Password wajib diisi.");

  localStorage.setItem(REMEMBER_KEY, $("#remember").checked ? "1" : "0");
  busy(btn, true, "Masuk…");
  const creds = c.type === "email" ? { email: c.value, password: pw } : { phone: c.value, password: pw };
  const { error } = await sb.auth.signInWithPassword(creds);

  if (error && /not confirmed/i.test(error.message)) {
    // Akun belum diverifikasi: kirim OTP baru lalu arahkan ke halaman verifikasi
    const { error: e2 } = await sb.auth.resend(resendPayload(c));
    busy(btn, false);
    if (e2) return setMsg(msg, friendly(e2));
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(c));
    clearBoxes();
    startTimer();
    return go("otp");
  }
  busy(btn, false);
  if (error) return setMsg(msg, friendly(error));
  location.href = HOME_URL;
});

/* ---------- Login / daftar dengan Google ---------- */
document.querySelectorAll("[data-google]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const msg = btn.closest("form").querySelector(".msg");
    setMsg(msg, "");
    if (!guard(msg)) return;
    if (location.protocol === "file:") {
      return setMsg(msg, "Login Google tidak bisa dari file lokal. Jalankan lewat GitHub Pages atau http://localhost.");
    }
    localStorage.setItem(REMEMBER_KEY, "1");
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname }, // harus terdaftar di Supabase → Redirect URLs
    });
    if (error) { btn.disabled = false; setMsg(msg, friendly(error)); }
  });
});
// tombol Kembali di browser: aktifkan lagi tombol Google
window.addEventListener("pageshow", (e) => {
  if (e.persisted) document.querySelectorAll("[data-google]").forEach((b) => (b.disabled = false));
});

// Google mengembalikan error lewat alamat halaman (#error_description=...)
(function showOAuthError() {
  const d = new URLSearchParams(location.hash.replace(/^#/, "")).get("error_description");
  if (!d) return;
  history.replaceState(null, "", location.pathname + "#/login");
  setMsg($("#msg-login"), "Login Google gagal: " + d);
})();

route();
