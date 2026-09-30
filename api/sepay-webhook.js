// POST /api/sepay-webhook
// SePay gọi vào đây mỗi khi tài khoản nhận tiền. Xác thực bằng header
//   Authorization: Apikey <SEPAY_API_KEY>
// rồi tìm mã thanh toán (KSKxxxxxxxx) trong nội dung chuyển khoản để tự động
// kích hoạt / gia hạn gói cho đúng trạm.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { getPlan } = require("../lib/plan");

function okAuth(header, key) {
  const a = Buffer.from(String(header || ""));
  const b = Buffer.from(`Apikey ${key}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseVnTime(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T") + "+07:00");
  return isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    // Mở thẳng URL này trên trình duyệt để kiểm tra nhanh máy chủ đã nhận đủ biến môi trường chưa
    res.status(200).json({
      ok: true,
      endpoint: "sepay-webhook",
      has_SEPAY_API_KEY: !!process.env.SEPAY_API_KEY,
      has_SUPABASE_URL: !!process.env.SUPABASE_URL,
      has_SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ success: false, message: "Method not allowed" });
    return;
  }

  const apiKey = process.env.SEPAY_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !supabaseUrl || !serviceKey) {
    res.status(500).json({ success: false, message: "Thiếu SEPAY_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    return;
  }
  if (!okAuth(req.headers.authorization, apiKey)) {
    res.status(401).json({ success: false, message: "Sai API key" });
    return;
  }

  try {
    const b = req.body || {};
    const plan = getPlan();

    // Chỉ xử lý tiền VÀO đúng tài khoản nhận; còn lại bỏ qua (vẫn trả success để SePay không gửi lại)
    if (String(b.transferType || "").toLowerCase() !== "in") {
      res.status(200).json({ success: true, message: "Bỏ qua: không phải tiền vào" });
      return;
    }
    // Không chặn theo số tài khoản: SePay có thể gửi số tài khoản định danh (VA) khác số hiển thị.
    // Nguồn gọi đã được xác thực bằng API key ở trên.
    console.log("sepay-webhook nhận:", JSON.stringify({
      id: b.id, acc: b.accountNumber, sub: b.subAccount, amount: b.transferAmount,
      content: b.content, code: b.code,
    }));

    const sepayId = Number(b.id);
    if (!Number.isFinite(sepayId)) {
      res.status(400).json({ success: false, message: "Thiếu id giao dịch" });
      return;
    }
    const amount = Math.round(Number(b.transferAmount) || 0);

    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Tìm mã thanh toán trong nội dung (ngân hàng có thể thêm chữ trước/sau, đổi hoa/thường)
    const raw = `${b.code || ""} ${b.content || ""} ${b.description || ""}`.toUpperCase();
    const re = new RegExp(`${plan.prefix}[0-9A-F]{8}`);
    // Thử nguyên văn trước, rồi thử sau khi bỏ mọi ký tự không phải chữ/số (vd "KSK 1A2B-3C4D")
    const m = raw.match(re) || raw.replace(/[^0-9A-Z]/g, "").match(re);

    let tram = null;
    if (m) {
      const { data } = await sb.from("tram_y_te").select("id").eq("ma_thanh_toan", m[0]).maybeSingle();
      tram = data || null;
    }

    let status;
    let days = 0;
    if (!tram) {
      status = "khong_khop_ma";
    } else {
      const periods = Math.floor(amount / plan.price);
      if (periods < 1) {
        status = "thieu_tien";
      } else {
        status = "da_kich_hoat";
        days = periods * plan.days;
      }
    }

    // Ghi nhật ký trước (cột sepay_id UNIQUE => giao dịch gửi lại sẽ bị chặn, không cộng ngày 2 lần)
    const { error: insErr } = await sb.from("thanh_toan").insert({
      sepay_id: sepayId,
      tram_id: tram ? tram.id : null,
      so_tien: amount,
      noi_dung: b.content || null,
      ma_tham_chieu: b.referenceCode || null,
      thoi_gian_ck: parseVnTime(b.transactionDate),
      so_ngay_cong: days,
      trang_thai: status,
      du_lieu_goc: b,
    });
    if (insErr) {
      if (insErr.code === "23505") {
        res.status(200).json({ success: true, message: "Giao dịch đã xử lý trước đó" });
        return;
      }
      throw new Error(insErr.message);
    }

    if (status === "da_kich_hoat") {
      const { error: actErr } = await sb.rpc("kich_hoat_goi", { p_tram: tram.id, p_days: days });
      if (actErr) {
        // Hoàn tác nhật ký để SePay gửi lại và xử lý lần sau
        await sb.from("thanh_toan").delete().eq("sepay_id", sepayId);
        throw new Error(actErr.message);
      }
    }

    console.log("sepay-webhook kết quả:", status, tram ? tram.id : null, days);
    res.status(200).json({ success: true, status, tram_found: !!tram, days });
  } catch (err) {
    console.error("sepay-webhook lỗi:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
