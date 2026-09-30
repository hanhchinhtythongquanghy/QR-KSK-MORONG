// ============================================================
// CONFIG.JS — Tải cấu hình Supabase (URL + anon key) từ biến môi
// trường khai báo trên Vercel, thông qua API nội bộ
// /api/config. Không còn hardcode khóa trong mã nguồn tĩnh nữa.
//
// index.html và admin.js/app.js chỉ cần chờ Promise này (biến toàn
// cục window.APP_CONFIG_READY) trước khi khởi tạo Supabase client.
// ============================================================
window.APP_CONFIG_READY = (async () => {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const cfg = await res.json();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      throw new Error(cfg.error || "Thiếu supabaseUrl/supabaseAnonKey trong phản hồi /api/config");
    }
    window.APP_CONFIG = {
      SUPABASE_URL: cfg.supabaseUrl,
      SUPABASE_ANON_KEY: cfg.supabaseAnonKey,
      PLAN: cfg.plan || null,
    };
  } catch (err) {
    console.error("Không tải được cấu hình hệ thống:", err);
    document.body.innerHTML =
      '<div style="padding:40px;max-width:560px;margin:60px auto;text-align:center;' +
      'font-family:sans-serif;color:#c0392b;border:1px solid #f1c3bb;border-radius:10px;background:#fdf3f1">' +
      "⚠ Không tải được cấu hình hệ thống.<br/><br/>" +
      "Kiểm tra lại biến môi trường <b>SUPABASE_URL</b> / <b>SUPABASE_ANON_KEY</b> " +
      "đã khai báo trên Vercel chưa, và hàm <code>/api/config</code> có hoạt động không." +
      "</div>";
    throw err;
  }
})();
