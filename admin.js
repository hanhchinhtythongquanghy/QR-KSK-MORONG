// ============================================================
// ADMIN.JS - Quản trị hệ thống: danh sách trạm, thống kê, tài khoản
// Yêu cầu: tài khoản đăng nhập phải có mặt trong bảng public.admins
// (xem admin.sql). Người dùng thường (tài khoản của từng trạm) đăng
// nhập ở đây sẽ bị từ chối vào trang quản trị.
//
// Toàn bộ file bọc trong 1 hàm async, chờ cấu hình Supabase (URL +
// anon key, lấy từ biến môi trường qua /api/config — xem config.js)
// tải xong rồi mới chạy.
//
// Các thao tác TẠO/XÓA trạm và tài khoản đăng nhập gọi vào serverless
// function (/api/admin-...), nơi duy nhất dùng service role key để
// thực sự tạo/xóa tài khoản trong Supabase Auth — trình duyệt không
// bao giờ thấy khóa đó.
// ============================================================
(async function () {
await window.APP_CONFIG_READY;

const sb = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

const loginScreenEl = document.getElementById("login-screen");
const appShellEl = document.getElementById("app-shell");
const loginFormEl = document.getElementById("login-form");
const loginErrorEl = document.getElementById("login-error");
const loginSubmitEl = document.getElementById("login-submit");
const toastEl = document.getElementById("toast");

function showToast(msg, type = "ok") {
  toastEl.textContent = msg;
  toastEl.className = "toast show " + type;
  setTimeout(() => (toastEl.className = "toast"), 2800);
}

// ---------- Gọi các serverless function quản trị (/api/admin-...) ----------
// Tự đính kèm access token của phiên đăng nhập hiện tại; function phía máy
// chủ sẽ tự kiểm tra lại người gọi có phải admin không trước khi thực hiện.
async function callAdminApi(path, payload) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");

  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload || {}),
  });

  let json = null;
  try { json = await res.json(); } catch { /* phản hồi rỗng */ }

  if (!res.ok) {
    throw new Error((json && json.error) || `Lỗi máy chủ (${res.status})`);
  }
  return json;
}

function showLogin() {
  appShellEl.style.display = "none";
  loginScreenEl.style.display = "flex";
}

async function showApp() {
  loginScreenEl.style.display = "none";
  appShellEl.style.display = "";
  await loadTrams();
}

// ---------- Kiểm tra quyền admin sau khi đăng nhập ----------
async function checkAdminThenEnter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    showLogin();
    return;
  }
  const { data, error } = await sb.from("admins").select("id").eq("id", user.id).maybeSingle();
  if (error || !data) {
    loginErrorEl.textContent = "Tài khoản này không có quyền quản trị hệ thống.";
    await sb.auth.signOut();
    showLogin();
    return;
  }
  await showApp();
}

sb.auth.getSession().then(({ data }) => {
  if (data.session) checkAdminThenEnter();
  else showLogin();
});

loginFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErrorEl.textContent = "";
  loginSubmitEl.disabled = true;
  loginSubmitEl.textContent = "Đang đăng nhập...";

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });

  loginSubmitEl.disabled = false;
  loginSubmitEl.textContent = "Đăng nhập";

  if (error) {
    loginErrorEl.textContent = "Sai email hoặc mật khẩu. Vui lòng thử lại.";
    return;
  }
  loginFormEl.reset();
  await checkAdminThenEnter();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  showLogin();
});

// ============================================================
// DANH SÁCH TRẠM + THỐNG KÊ (đọc từ view public.tram_thong_ke, qua RLS)
// ============================================================
let allTrams = [];

async function loadTrams() {
  const { data, error } = await sb
    .from("tram_thong_ke")
    .select("*")
    .order("ten_tram", { ascending: true });

  if (error) {
    console.error(error);
    showToast("Không tải được danh sách trạm", "err");
    return;
  }
  allTrams = data || [];
  renderKpis();
  renderTable();
}

function renderKpis() {
  const soTram = allTrams.length;
  const tongNhap = allTrams.reduce((sum, t) => sum + (t.tong_so_nhap || 0), 0);
  const homNay = allTrams.reduce((sum, t) => sum + (t.so_nhap_hom_nay || 0), 0);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const hoatDong = allTrams.filter(
    (t) => t.lan_cuoi_su_dung && new Date(t.lan_cuoi_su_dung).getTime() >= sevenDaysAgo
  ).length;

  document.getElementById("kpi-so-tram").textContent = soTram;
  document.getElementById("kpi-tong-nhap").textContent = tongNhap.toLocaleString("vi-VN");
  document.getElementById("kpi-hom-nay").textContent = homNay.toLocaleString("vi-VN");
  document.getElementById("kpi-hoat-dong").textContent = `${hoatDong}/${soTram}`;
}

function formatDateTimeVN(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("vi-VN", { hour12: false });
}

function renderTable() {
  const term = document.getElementById("search-box").value.trim().toLowerCase();
  const tbody = document.getElementById("tram-table-body");
  const emptyStateEl = document.getElementById("empty-state");
  tbody.innerHTML = "";

  let rows = allTrams;
  if (term) {
    rows = rows.filter((t) =>
      [t.ten_tram, t.ten_xa].filter(Boolean).join(" ").toLowerCase().includes(term)
    );
  }

  emptyStateEl.style.display = rows.length ? "none" : "block";

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  rows.forEach((t) => {
    const activeRecently = t.lan_cuoi_su_dung && new Date(t.lan_cuoi_su_dung).getTime() >= sevenDaysAgo;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${t.ten_tram || ""}</b></td>
      <td>${t.ten_xa || ""}</td>
      <td>${t.so_tai_khoan ?? 0}</td>
      <td>${(t.tong_so_nhap ?? 0).toLocaleString("vi-VN")}</td>
      <td>${(t.so_nhap_hom_nay ?? 0).toLocaleString("vi-VN")}</td>
      <td>${t.lan_cuoi_su_dung ? formatDateTimeVN(t.lan_cuoi_su_dung) : '<span class="muted">Chưa sử dụng</span>'}</td>
      <td>${formatDateTimeVN(t.tram_created_at)}</td>
      <td>${activeRecently ? '<span class="badge-active">Đang hoạt động</span>' : '<span class="badge-idle">Ít/chưa hoạt động</span>'}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="btn secondary small btn-edit-tram">Sửa</button>
          <button type="button" class="btn secondary small btn-manage-accounts">Tài khoản</button>
          <button type="button" class="btn danger small btn-delete-tram">Xóa</button>
        </div>
      </td>
    `;
    tr.querySelector(".btn-edit-tram").addEventListener("click", () => openTramModal(t));
    tr.querySelector(".btn-manage-accounts").addEventListener("click", () => openAccountsModal(t));
    tr.querySelector(".btn-delete-tram").addEventListener("click", () => openDeleteModal(t));
    tbody.appendChild(tr);
  });
}

document.getElementById("search-box").addEventListener("input", renderTable);

// ============================================================
// THÊM / SỬA TRẠM
// - Thêm mới: gọi /api/admin-create-station (tạo trạm + tài khoản đầu tiên
//   trong 1 bước, dùng service role phía máy chủ).
// - Sửa: chỉ đổi thông tin trạm (không đụng tài khoản) — vẫn làm trực tiếp
//   qua Supabase client vì admin đã có quyền RLS update trên tram_y_te.
// ============================================================
const tramModal = document.getElementById("tram-modal");
const tramForm = document.getElementById("tram-form");
const tramModalTitleEl = document.getElementById("tram-modal-title");
const tramModalErrorEl = document.getElementById("tram-modal-error");
const tramModalSubmitEl = document.getElementById("tram-modal-submit");
const tramModalAccountFieldsEl = document.getElementById("tram-modal-account-fields");
const fieldTenXaEl = document.getElementById("field-ten-xa");
const fieldTenTramEl = document.getElementById("field-ten-tram");
const fieldDanhSachEl = document.getElementById("field-danh-sach-nguoi-quet");
const fieldTramEmailEl = document.getElementById("field-tram-email");
const fieldTramPasswordEl = document.getElementById("field-tram-password");

let editingTramId = null; // null = đang thêm mới

async function openTramModal(tram) {
  tramModalErrorEl.textContent = "";
  editingTramId = tram ? tram.tram_id : null;
  tramModalTitleEl.textContent = tram ? "Sửa thông tin trạm" : "Thêm trạm y tế mới";
  fieldTenXaEl.value = tram?.ten_xa || "";
  fieldTenTramEl.value = tram?.ten_tram || "";
  fieldDanhSachEl.value = "";
  fieldDanhSachEl.placeholder = "Nguyễn Thị A\nTrần Văn B";
  fieldTramEmailEl.value = "";
  fieldTramPasswordEl.value = "";

  // Chỉ khi THÊM MỚI mới cần nhập email/mật khẩu tài khoản đầu tiên
  tramModalAccountFieldsEl.style.display = tram ? "none" : "";
  fieldTramEmailEl.required = !tram;
  fieldTramPasswordEl.required = !tram;

  tramModal.style.display = "flex";
  fieldTenXaEl.focus();

  if (tram) {
    // Lấy danh sách người quét hiện tại của trạm để hiển thị sẵn trong ô sửa
    const { data, error } = await sb
      .from("tram_y_te")
      .select("danh_sach_nguoi_quet")
      .eq("id", tram.tram_id)
      .single();
    if (!error && data) {
      fieldDanhSachEl.value = (data.danh_sach_nguoi_quet || []).join("\n");
    }
  }
}

function closeTramModal() {
  tramModal.style.display = "none";
}

document.getElementById("btn-add-tram").addEventListener("click", () => openTramModal(null));
document.getElementById("btn-close-tram-modal").addEventListener("click", closeTramModal);

tramForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tenXa = fieldTenXaEl.value.trim();
  const tenTram = fieldTenTramEl.value.trim();
  const danhSachRaw = fieldDanhSachEl.value.trim();
  const danhSach = danhSachRaw ? danhSachRaw.split("\n").map((s) => s.trim()).filter(Boolean) : [];

  if (!tenXa || !tenTram) {
    tramModalErrorEl.textContent = "Vui lòng nhập đầy đủ tên xã và tên trạm y tế.";
    return;
  }

  if (!editingTramId) {
    const email = fieldTramEmailEl.value.trim();
    const password = fieldTramPasswordEl.value;
    if (!email || !password) {
      tramModalErrorEl.textContent = "Vui lòng nhập email và mật khẩu cho tài khoản đăng nhập đầu tiên của trạm.";
      return;
    }
    if (password.length < 6) {
      tramModalErrorEl.textContent = "Mật khẩu cần tối thiểu 6 ký tự.";
      return;
    }
  }

  tramModalSubmitEl.disabled = true;
  tramModalSubmitEl.textContent = "Đang lưu...";
  tramModalErrorEl.textContent = "";

  try {
    if (editingTramId) {
      const { error } = await sb
        .from("tram_y_te")
        .update({ ten_xa: tenXa, ten_tram: tenTram, danh_sach_nguoi_quet: danhSach })
        .eq("id", editingTramId);
      if (error) throw new Error(error.message);
      showToast("✓ Đã cập nhật thông tin trạm", "ok");
    } else {
      await callAdminApi("/api/admin-create-station", {
        ten_xa: tenXa,
        ten_tram: tenTram,
        danh_sach_nguoi_quet: danhSach,
        email: fieldTramEmailEl.value.trim(),
        password: fieldTramPasswordEl.value,
      });
      showToast("✓ Đã thêm trạm mới và tạo tài khoản đăng nhập", "ok");
    }
    closeTramModal();
    await loadTrams();
  } catch (err) {
    console.error(err);
    tramModalErrorEl.textContent = err.message || "Không lưu được, vui lòng thử lại.";
  } finally {
    tramModalSubmitEl.disabled = false;
    tramModalSubmitEl.textContent = "Lưu";
  }
});

// ============================================================
// QUẢN LÝ TÀI KHOẢN CỦA 1 TRẠM (tạo/xóa thật sự qua serverless function)
// ============================================================
const accountsModal = document.getElementById("accounts-modal");
const accountsListEl = document.getElementById("accounts-list");
const accountsModalErrorEl = document.getElementById("accounts-modal-error");
const accountsModalTramNameEl = document.getElementById("accounts-modal-tram-name");
const addAccountFormEl = document.getElementById("add-account-form");
const fieldNewAccountEmailEl = document.getElementById("field-new-account-email");
const fieldNewAccountPasswordEl = document.getElementById("field-new-account-password");
const btnAddAccountEl = document.getElementById("btn-add-account");

let currentAccountsTramId = null;

async function openAccountsModal(tram) {
  currentAccountsTramId = tram.tram_id;
  accountsModalTramNameEl.textContent = tram.ten_tram;
  accountsModalErrorEl.textContent = "";
  fieldNewAccountEmailEl.value = "";
  fieldNewAccountPasswordEl.value = "";
  accountsModal.style.display = "flex";
  await renderAccountsList();
}

function closeAccountsModal() {
  accountsModal.style.display = "none";
  currentAccountsTramId = null;
}

async function renderAccountsList() {
  accountsListEl.innerHTML = '<p class="hint">Đang tải...</p>';
  try {
    const { accounts } = await callAdminApi("/api/admin-list-accounts", { tram_id: currentAccountsTramId });

    if (!accounts.length) {
      accountsListEl.innerHTML = '<p class="hint">Trạm này chưa có tài khoản đăng nhập nào.</p>';
      return;
    }

    accountsListEl.innerHTML = "";
    accounts.forEach((acc) => {
      const row = document.createElement("div");
      row.className = "account-row";
      row.innerHTML = `
        <div>
          <div><b>${acc.email}</b></div>
          <div class="muted">Tạo lúc: ${formatDateTimeVN(acc.created_at)}</div>
        </div>
        <button type="button" class="btn secondary small btn-delete-account">Xóa tài khoản</button>
      `;
      row.querySelector(".btn-delete-account").addEventListener("click", () => deleteAccount(acc));
      accountsListEl.appendChild(row);
    });
  } catch (err) {
    console.error(err);
    accountsListEl.innerHTML = '<p class="hint">Không tải được danh sách tài khoản.</p>';
  }
}

async function deleteAccount(acc) {
  if (!confirm(`Xóa vĩnh viễn tài khoản "${acc.email}"? Tài khoản sẽ không đăng nhập được nữa.`)) {
    return;
  }
  try {
    await callAdminApi("/api/admin-delete-account", { user_id: acc.id });
    showToast("✓ Đã xóa tài khoản", "ok");
    await renderAccountsList();
    await loadTrams();
  } catch (err) {
    console.error(err);
    showToast(err.message || "Không xóa được tài khoản", "err");
  }
}

addAccountFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  accountsModalErrorEl.textContent = "";
  const email = fieldNewAccountEmailEl.value.trim();
  const password = fieldNewAccountPasswordEl.value;

  if (!email || !password) {
    accountsModalErrorEl.textContent = "Vui lòng nhập email và mật khẩu.";
    return;
  }
  if (password.length < 6) {
    accountsModalErrorEl.textContent = "Mật khẩu cần tối thiểu 6 ký tự.";
    return;
  }

  btnAddAccountEl.disabled = true;
  btnAddAccountEl.textContent = "Đang tạo...";

  try {
    await callAdminApi("/api/admin-create-account", { tram_id: currentAccountsTramId, email, password });
    fieldNewAccountEmailEl.value = "";
    fieldNewAccountPasswordEl.value = "";
    showToast("✓ Đã tạo tài khoản mới cho trạm", "ok");
    await renderAccountsList();
    await loadTrams();
  } catch (err) {
    console.error(err);
    accountsModalErrorEl.textContent = err.message || "Không tạo được tài khoản.";
  } finally {
    btnAddAccountEl.disabled = false;
    btnAddAccountEl.textContent = "Tạo tài khoản";
  }
});

document.getElementById("btn-close-accounts-modal").addEventListener("click", closeAccountsModal);

// ============================================================
// XÓA TRẠM (yêu cầu gõ lại đúng tên để xác nhận) — gọi serverless
// function để xóa luôn cả các tài khoản đăng nhập gắn với trạm.
// ============================================================
const deleteModal = document.getElementById("delete-modal");
const deleteTramNameEl = document.getElementById("delete-tram-name");
const fieldDeleteConfirmEl = document.getElementById("field-delete-confirm");
const deleteModalErrorEl = document.getElementById("delete-modal-error");
const btnConfirmDeleteEl = document.getElementById("btn-confirm-delete");

let tramPendingDelete = null;

function openDeleteModal(tram) {
  tramPendingDelete = tram;
  deleteTramNameEl.textContent = tram.ten_tram;
  fieldDeleteConfirmEl.value = "";
  deleteModalErrorEl.textContent = "";
  deleteModal.style.display = "flex";
}

function closeDeleteModal() {
  deleteModal.style.display = "none";
  tramPendingDelete = null;
}

document.getElementById("btn-close-delete-modal").addEventListener("click", closeDeleteModal);

btnConfirmDeleteEl.addEventListener("click", async () => {
  if (!tramPendingDelete) return;
  if (fieldDeleteConfirmEl.value.trim() !== tramPendingDelete.ten_tram) {
    deleteModalErrorEl.textContent = "Tên trạm gõ lại chưa khớp.";
    return;
  }

  btnConfirmDeleteEl.disabled = true;
  btnConfirmDeleteEl.textContent = "Đang xóa...";

  try {
    await callAdminApi("/api/admin-delete-station", { tram_id: tramPendingDelete.tram_id });
    showToast("✓ Đã xóa trạm y tế", "ok");
    closeDeleteModal();
    await loadTrams();
  } catch (err) {
    console.error(err);
    deleteModalErrorEl.textContent = err.message || "Không xóa được, vui lòng thử lại.";
  } finally {
    btnConfirmDeleteEl.disabled = false;
    btnConfirmDeleteEl.textContent = "Xóa vĩnh viễn";
  }
});

})(); // kết thúc hàm async bọc toàn bộ admin.js
