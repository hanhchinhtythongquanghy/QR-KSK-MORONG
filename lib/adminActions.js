// ============================================================
// lib/adminActions.js
// Logic dùng CHUNG cho các serverless function quản trị (Vercel /api
// gọi vào đây). Đây là nơi DUY NHẤT
// dùng SUPABASE_SERVICE_ROLE_KEY — khóa này có toàn quyền trên
// database, KHÔNG BAO GIỜ được gửi ra trình duyệt.
//
// Mọi hàm ở đây đều tự kiểm tra người gọi có phải admin không (dựa
// trên token đăng nhập gửi lên qua header Authorization), rồi mới
// thực hiện thao tác.
// ============================================================

const { createClient } = require("@supabase/supabase-js");

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function getEnv() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw httpError(
      500,
      "Thiếu biến môi trường SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trên máy chủ. " +
        "Kiểm tra lại cấu hình Environment Variables trên Vercel."
    );
  }
  return { supabaseUrl, anonKey, serviceRoleKey };
}

// Xác thực người gọi API: phải đăng nhập VÀ có mặt trong bảng public.admins
async function requireAdmin(authHeader) {
  const { supabaseUrl, anonKey, serviceRoleKey } = getEnv();
  const token = (authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw httpError(401, "Thiếu token đăng nhập.");

  // Dùng anon key + token của người dùng để xác minh chính token đó hợp lệ
  const sbAsUser = createClient(supabaseUrl, anonKey);
  const {
    data: { user },
    error: userErr,
  } = await sbAsUser.auth.getUser(token);
  if (userErr || !user) throw httpError(401, "Token không hợp lệ hoặc đã hết hạn, vui lòng đăng nhập lại.");

  // Dùng service role để tra bảng admins (không phụ thuộc RLS)
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: adminRow, error: adminErr } = await sbAdmin
    .from("admins")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (adminErr) throw httpError(500, "Không kiểm tra được quyền quản trị: " + adminErr.message);
  if (!adminRow) throw httpError(403, "Tài khoản này không có quyền quản trị hệ thống.");

  return { sbAdmin, user };
}

// ---------- Tạo trạm y tế mới + tài khoản đăng nhập đầu tiên ----------
async function createStation({ authHeader, ten_xa, ten_tram, danh_sach_nguoi_quet, email, password }) {
  const { sbAdmin } = await requireAdmin(authHeader);

  ten_xa = (ten_xa || "").trim();
  ten_tram = (ten_tram || "").trim();
  email = (email || "").trim();
  if (!ten_xa || !ten_tram || !email || !password) {
    throw httpError(400, "Vui lòng nhập đầy đủ tên xã, tên trạm, email và mật khẩu.");
  }
  if (password.length < 6) {
    throw httpError(400, "Mật khẩu cần tối thiểu 6 ký tự.");
  }

  const { data: tram, error: tramErr } = await sbAdmin
    .from("tram_y_te")
    .insert({
      ten_xa,
      ten_tram,
      danh_sach_nguoi_quet: Array.isArray(danh_sach_nguoi_quet) ? danh_sach_nguoi_quet : [],
    })
    .select()
    .single();
  if (tramErr) throw httpError(400, "Không tạo được trạm: " + tramErr.message);

  const { data: userData, error: userErr } = await sbAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr) {
    await sbAdmin.from("tram_y_te").delete().eq("id", tram.id); // dọn lại, tránh trạm mồ côi
    throw httpError(400, "Không tạo được tài khoản đăng nhập: " + userErr.message);
  }

  const { error: profileErr } = await sbAdmin
    .from("profiles")
    .insert({ id: userData.user.id, tram_id: tram.id });
  if (profileErr) {
    await sbAdmin.auth.admin.deleteUser(userData.user.id);
    await sbAdmin.from("tram_y_te").delete().eq("id", tram.id);
    throw httpError(400, "Không gắn được tài khoản vào trạm: " + profileErr.message);
  }

  return { tram, user: { id: userData.user.id, email: userData.user.email } };
}

// ---------- Thêm 1 tài khoản đăng nhập cho trạm đã có sẵn ----------
async function createAccount({ authHeader, tram_id, email, password }) {
  const { sbAdmin } = await requireAdmin(authHeader);

  email = (email || "").trim();
  if (!tram_id || !email || !password) {
    throw httpError(400, "Vui lòng nhập đầy đủ trạm, email và mật khẩu.");
  }
  if (password.length < 6) {
    throw httpError(400, "Mật khẩu cần tối thiểu 6 ký tự.");
  }

  const { data: tram, error: tramFindErr } = await sbAdmin
    .from("tram_y_te")
    .select("id")
    .eq("id", tram_id)
    .maybeSingle();
  if (tramFindErr || !tram) throw httpError(404, "Không tìm thấy trạm y tế.");

  const { data: userData, error: userErr } = await sbAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr) throw httpError(400, "Không tạo được tài khoản: " + userErr.message);

  const { error: profileErr } = await sbAdmin
    .from("profiles")
    .insert({ id: userData.user.id, tram_id });
  if (profileErr) {
    await sbAdmin.auth.admin.deleteUser(userData.user.id);
    throw httpError(400, "Không gắn được tài khoản vào trạm: " + profileErr.message);
  }

  return { user: { id: userData.user.id, email: userData.user.email } };
}

// ---------- Danh sách tài khoản (kèm email) của 1 trạm ----------
async function listAccounts({ authHeader, tram_id }) {
  const { sbAdmin } = await requireAdmin(authHeader);
  if (!tram_id) throw httpError(400, "Thiếu tram_id.");

  const { data: profileRows, error } = await sbAdmin
    .from("profiles")
    .select("id, created_at")
    .eq("tram_id", tram_id)
    .order("created_at", { ascending: true });
  if (error) throw httpError(400, "Không tải được danh sách tài khoản: " + error.message);

  const accounts = [];
  for (const row of profileRows || []) {
    const { data: userData } = await sbAdmin.auth.admin.getUserById(row.id);
    accounts.push({
      id: row.id,
      email: userData?.user?.email || "(không rõ email)",
      created_at: row.created_at,
    });
  }
  return { accounts };
}

// ---------- Xóa hẳn 1 tài khoản đăng nhập (cascade gỡ khỏi trạm) ----------
async function deleteAccount({ authHeader, user_id }) {
  const { sbAdmin } = await requireAdmin(authHeader);
  if (!user_id) throw httpError(400, "Thiếu user_id.");

  const { error } = await sbAdmin.auth.admin.deleteUser(user_id);
  if (error) throw httpError(400, "Không xóa được tài khoản: " + error.message);

  return { ok: true };
}

// ---------- Xóa trạm y tế: xóa trạm (cascade dữ liệu tiếp đón + liên kết
// tài khoản) rồi xóa luôn các tài khoản đăng nhập từng gắn với trạm đó ----------
async function deleteStation({ authHeader, tram_id }) {
  const { sbAdmin } = await requireAdmin(authHeader);
  if (!tram_id) throw httpError(400, "Thiếu tram_id.");

  const { data: profileRows, error: profErr } = await sbAdmin
    .from("profiles")
    .select("id")
    .eq("tram_id", tram_id);
  if (profErr) throw httpError(400, "Không đọc được danh sách tài khoản của trạm: " + profErr.message);

  const { error: delTramErr } = await sbAdmin.from("tram_y_te").delete().eq("id", tram_id);
  if (delTramErr) throw httpError(400, "Không xóa được trạm: " + delTramErr.message);

  for (const p of profileRows || []) {
    await sbAdmin.auth.admin.deleteUser(p.id).catch(() => {});
  }

  return { ok: true };
}

// ---------- Gia hạn thủ công gói dịch vụ cho 1 trạm (khi cần xử lý tay) ----------
async function extendPlan({ authHeader, tram_id, days }) {
  const { sbAdmin } = await requireAdmin(authHeader);
  days = parseInt(days, 10);
  if (!tram_id) throw httpError(400, "Thiếu tram_id.");
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw httpError(400, "Số ngày gia hạn phải từ 1 đến 3650.");
  }

  const { data, error } = await sbAdmin.rpc("kich_hoat_goi", { p_tram: tram_id, p_days: days });
  if (error) throw httpError(400, "Không gia hạn được: " + error.message);

  await sbAdmin.from("thanh_toan").insert({
    tram_id,
    so_tien: 0,
    noi_dung: "Admin gia hạn thủ công",
    so_ngay_cong: days,
    trang_thai: "admin_gia_han",
  });

  return { ok: true, paid_until: data };
}

module.exports = {
  httpError,
  getEnv,
  requireAdmin,
  createStation,
  createAccount,
  listAccounts,
  deleteAccount,
  deleteStation,
  extendPlan,
};
