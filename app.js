// ============================================================
// APP.JS - Logic tiếp đón, in phiếu, danh sách bàn giao V20
// Toàn bộ file được bọc trong 1 hàm async, chờ cấu hình Supabase
// (URL + anon key, lấy từ biến môi trường qua /api/config — xem
// config.js) tải xong rồi mới chạy, để phù hợp khi deploy Vercel.
// ============================================================
(async function () {
await window.APP_CONFIG_READY;

const sb = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

// ============================================================
// ĐA TRẠM (SaaS) — thông tin trạm y tế của tài khoản đang đăng nhập
// Không còn lấy từ config.js tĩnh nữa, mà tải từ Supabase (bảng
// tram_y_te, qua bảng profiles nối tài khoản đăng nhập -> trạm) ngay
// sau khi đăng nhập thành công. RLS trên Supabase đảm bảo mỗi tài
// khoản chỉ đọc/ghi được đúng dữ liệu của trạm mình.
// ============================================================
let currentTram = null; // { id, ten_xa, ten_tram, danh_sach_nguoi_quet }

async function loadTramConfig() {
  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) {
    currentTram = null;
    return null;
  }

  const { data: profile, error: profErr } = await sb
    .from("profiles")
    .select("tram_id, tram_y_te ( id, ten_xa, ten_tram, danh_sach_nguoi_quet )")
    .eq("id", user.id)
    .single();

  if (profErr || !profile?.tram_y_te) {
    console.error("Không tải được cấu hình trạm:", profErr);
    showToast?.("⚠ Tài khoản này chưa được gán vào trạm y tế nào. Liên hệ quản trị hệ thống.", "err");
    currentTram = null;
    return null;
  }

  currentTram = profile.tram_y_te;
  applyTramConfig();
  return currentTram;
}

// Đổ thông tin trạm vừa tải lên các phần tử hiển thị (đầu trang, phiếu in,
// danh sách người quét)
function applyTramConfig() {
  if (!currentTram) return;
  if (loginTramNameEl) loginTramNameEl.textContent = currentTram.ten_tram;
  const hdrTramEl = document.getElementById("hdr-tram");
  if (hdrTramEl) hdrTramEl.textContent = currentTram.ten_tram;
  populateNguoiQuetSelect();
  subscribeRealtime();
}

// ============================================================
// GÓI DỊCH VỤ: DÙNG THỬ 7 NGÀY -> HẾT HẠN THÌ TẠM DỪNG, THANH TOÁN QUA SEPAY
// - Trạng thái gói lấy từ Supabase (rpc goi_dich_vu) nên không sửa được ở máy khách;
//   ngoài ra RLS trên CSDL cũng chặn thêm/sửa tiếp đón khi hết hạn.
// - Mã QR tự sinh (qr.sepay.vn) kèm nội dung chuyển khoản riêng của từng trạm;
//   SePay báo về /api/sepay-webhook -> gói tự kích hoạt, màn hình tự mở khóa.
// ============================================================
let planInfo = null;
let planWatchTimer = null;
let paywallPollTimer = null;
let paywallLocked = false;

const paywallEl = document.getElementById("paywall");
const planBannerEl = document.getElementById("plan-banner");

function fmtVnDate(iso) {
  return iso ? new Date(iso).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "";
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString("vi-VN") + "đ";
}

async function refreshPlan() {
  if (!currentTram) return null;
  const { data, error } = await sb.rpc("goi_dich_vu");
  if (error || !data) {
    // Chưa chạy billing.sql hoặc lỗi mạng: không khóa nhầm (CSDL vẫn tự chặn khi hết hạn)
    console.error("Không đọc được gói dịch vụ:", error);
    return null;
  }
  const wasLocked = paywallLocked;
  const prevHan = planInfo ? new Date(planInfo.han_dung).getTime() : null;
  const wasOpen = paywallEl?.classList.contains("show");
  planInfo = data;
  renderPlan();
  const extended = prevHan !== null && new Date(data.han_dung).getTime() > prevHan;
  if (wasLocked && data.giai_doan !== "het_han") {
    showToast?.("✓ Đã kích hoạt gói thành công. Cảm ơn bạn!", "ok");
  } else if (wasOpen && extended) {
    closePaywall(); // đang mở màn hình gia hạn (chưa hết hạn) và vừa nhận được tiền
    showToast?.("✓ Đã gia hạn thành công. Cảm ơn bạn!", "ok");
  }
  return data;
}

function renderPlan() {
  if (!planInfo) return;
  const p = planInfo;
  const days = Math.ceil((p.giay_con_lai || 0) / 86400);

  if (p.giai_doan === "het_han") {
    planBannerEl.style.display = "none";
    // Chỉ dựng lại khi chưa hiện (tránh nạp lại mã QR mỗi 5 giây khi đang chờ thanh toán)
    if (!paywallLocked || !paywallEl.classList.contains("show")) openPaywall(true);
    return;
  }

  // Còn hạn: nếu đang mở màn hình khóa thì đóng lại
  if (paywallLocked) {
    paywallLocked = false;
    closePaywall();
  }

  if (p.giai_doan === "mien_phi") {
    planBannerEl.style.display = "none";
    return;
  }

  const warn = days <= (p.giai_doan === "dung_thu" ? 3 : 7);
  if (p.giai_doan === "tra_phi" && !warn) {
    planBannerEl.style.display = "none"; // gói đã trả phí và còn dài: không làm phiền
    return;
  }
  const label = p.giai_doan === "dung_thu" ? "Đang dùng thử miễn phí" : "Gói đang hoạt động";
  document.getElementById("plan-banner-text").textContent =
    `${label} — còn ${days} ngày (đến hết ${fmtVnDate(p.han_dung)})`;
  planBannerEl.classList.toggle("warn", warn);
  planBannerEl.style.display = "flex";
}

function buildQrUrl(plan, code, useFallback) {
  if (useFallback) {
    return `https://img.vietqr.io/image/${encodeURIComponent(plan.bankFallbackCode)}-${encodeURIComponent(plan.account)}-compact2.png` +
      `?amount=${plan.price}&addInfo=${encodeURIComponent(code)}`;
  }
  return `https://qr.sepay.vn/img?acc=${encodeURIComponent(plan.account)}&bank=${encodeURIComponent(plan.bank)}` +
    `&amount=${plan.price}&des=${encodeURIComponent(code)}&template=compact`;
}

function openPaywall(locked) {
  const plan = window.APP_CONFIG?.PLAN;
  if (!paywallEl || !plan || !planInfo) return;
  paywallLocked = !!locked;

  document.getElementById("pw-title").textContent = locked
    ? "Đã hết hạn dùng thử — vui lòng thanh toán để tiếp tục"
    : "Gia hạn gói sử dụng";
  document.getElementById("pw-sub").textContent = locked
    ? "Phần mềm đang tạm dừng. Quét mã QR bên dưới bằng ứng dụng ngân hàng; sau khi nhận được tiền, phần mềm tự mở lại."
    : `Gói hiện tại còn hiệu lực đến hết ${fmtVnDate(planInfo.han_dung)}. Thanh toán thêm sẽ được cộng nối tiếp vào thời hạn hiện có.`;

  const img = document.getElementById("pw-qr-img");
  let triedFallback = false;
  img.onerror = () => {
    if (!triedFallback) {
      triedFallback = true;
      img.src = buildQrUrl(plan, planInfo.ma_thanh_toan, true);
    }
  };
  img.src = buildQrUrl(plan, planInfo.ma_thanh_toan, false);

  document.getElementById("pw-bank").textContent = plan.bank;
  document.getElementById("pw-account").textContent = plan.account;
  document.getElementById("pw-amount").textContent = fmtMoney(plan.price);
  document.getElementById("pw-amount").dataset.raw = String(plan.price);
  document.getElementById("pw-code").textContent = planInfo.ma_thanh_toan;
  const nameRow = document.getElementById("pw-name-row");
  nameRow.style.display = plan.accountName ? "" : "none";
  document.getElementById("pw-name").textContent = plan.accountName || "";
  document.getElementById("pw-note").textContent =
    `Mỗi ${fmtMoney(plan.price)} = ${plan.days} ngày sử dụng. Giữ nguyên nội dung chuyển khoản ` +
    `“${planInfo.ma_thanh_toan}” (không sửa, không thêm) để hệ thống tự nhận diện đúng trạm. ` +
    `Nếu quá 5 phút chưa được kích hoạt, hãy liên hệ quản trị hệ thống.`;

  document.getElementById("pw-close").style.display = locked ? "none" : "";
  paywallEl.classList.add("show");

  // Trong lúc mở: hỏi máy chủ mỗi 5 giây xem đã thanh toán xong chưa
  clearInterval(paywallPollTimer);
  paywallPollTimer = setInterval(refreshPlan, 5000);
}

function closePaywall() {
  paywallEl?.classList.remove("show");
  clearInterval(paywallPollTimer);
  paywallPollTimer = null;
}

function hidePlanUi() {
  paywallLocked = false;
  closePaywall();
  if (planBannerEl) planBannerEl.style.display = "none";
}

function startPlanWatch() {
  clearInterval(planWatchTimer);
  planWatchTimer = setInterval(refreshPlan, 60000); // kiểm tra định kỳ mỗi phút
}

function stopPlanWatch() {
  clearInterval(planWatchTimer);
  planWatchTimer = null;
  planInfo = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentTram) refreshPlan();
});
document.getElementById("plan-banner-btn")?.addEventListener("click", () => openPaywall(false));
document.getElementById("pw-close")?.addEventListener("click", () => { if (!paywallLocked) closePaywall(); });
document.getElementById("pw-check")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Đang kiểm tra...";
  const d = await refreshPlan();
  btn.disabled = false;
  btn.textContent = old;
  if (d && d.giai_doan === "het_han") {
    showToast?.("Chưa nhận được thanh toán. Vui lòng đợi thêm ít phút rồi kiểm tra lại.", "err");
  }
});
document.getElementById("pw-logout")?.addEventListener("click", async () => {
  await sb.auth.signOut();
});
paywallEl?.addEventListener("click", async (e) => {
  const btn = e.target.closest(".pw-copy");
  if (!btn) return;
  const src = btn.dataset.copy === "pw-amount-raw"
    ? document.getElementById("pw-amount").dataset.raw
    : document.getElementById(btn.dataset.copy).textContent;
  try {
    await navigator.clipboard.writeText(src);
    const old = btn.textContent;
    btn.textContent = "Đã chép ✓";
    setTimeout(() => (btn.textContent = old), 1500);
  } catch { /* trình duyệt không cho copy */ }
});

// ============================================================
// ĐĂNG NHẬP (mỗi trạm y tế có 1 tài khoản riêng, dùng Supabase Auth;
// tài khoản đó được gán sẵn vào đúng trạm của mình trong bảng profiles)
// ============================================================
const loginScreenEl = document.getElementById("login-screen");
const appShellEl = document.getElementById("app-shell");
const loginFormEl = document.getElementById("login-form");
const loginErrorEl = document.getElementById("login-error");
const loginSubmitEl = document.getElementById("login-submit");
const loginTramNameEl = document.getElementById("login-tram-name");

async function showApp() {
  if (loginScreenEl) loginScreenEl.style.display = "none";
  if (appShellEl) appShellEl.style.display = "";
  await loadTramConfig();
  if (currentTram) {
    await refreshPlan();
    startPlanWatch();
  }
  if (currentTram && document.getElementById("page-list")?.classList.contains("active")) loadList();
}

function showLogin() {
  if (appShellEl) appShellEl.style.display = "none";
  if (loginScreenEl) loginScreenEl.style.display = "flex";
  currentTram = null;
  unsubscribeRealtime();
  stopPlanWatch();
  hidePlanUi();
}

// Kiểm tra session ngay khi tải trang — nếu máy đã đăng nhập trước đó
// (session Supabase tự lưu ở localStorage) thì vào thẳng app, không bắt
// đăng nhập lại mỗi lần mở trình duyệt/kiosk.
sb.auth.getSession().then(({ data }) => {
  if (data.session) {
    showApp();
  } else {
    showLogin();
  }
});

// Theo dõi thay đổi trạng thái đăng nhập (đăng nhập / đăng xuất / hết hạn)
sb.auth.onAuthStateChange((event, session) => {
  if (session) {
    showApp();
  } else {
    showLogin();
  }
});

loginFormEl?.addEventListener("submit", async (e) => {
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
});

document.getElementById("btn-logout")?.addEventListener("click", async () => {
  await sb.auth.signOut();
});

const SETTINGS_KEY = "dot_kham_settings_v1";

// ---------- Cài đặt mặc định của đợt khám (lưu localStorage theo máy) ----------
function getSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  const defaults = {
    nguoi_quet: "",
    ageMode: "date", // "date" = ngày sinh chính xác | "year" = theo năm sinh
    dan_toc: "Kinh",
    doi_tuong: "",
    nguon_chi_tra: "",
    nhom_mau: "",
    nghe_nghiep: "",
    noi_lam_viec: "",
    ly_do_kham: "Khám sức khỏe định kỳ",
  };
  if (!raw) return defaults;
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------- Helpers ngày tháng ----------
function parseDDMMYYYY(s) {
  if (!s || s.length !== 8 || !/^\d{8}$/.test(s)) return null;
  const dd = s.slice(0, 2), mm = s.slice(2, 4), yyyy = s.slice(4, 8);
  return `${yyyy}-${mm}-${dd}`; // ISO, phù hợp cột date của Postgres
}

function formatDateVN(iso) {
  if (!iso) return "…………………..";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function nowTimeVN() {
  return new Date().toLocaleTimeString("vi-VN", { hour12: false });
}

// ---------- Tiếng "tít" báo quét thành công ----------
function playBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 1000;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    osc.start(now);
    osc.stop(now + 0.16);
    osc.onended = () => ctx.close();
  } catch (e) {
    // Trình duyệt chặn AudioContext (chưa có tương tác người dùng) — bỏ qua, không quan trọng
  }
}

function calcTuoi(ngaySinhISO, mode) {
  if (!ngaySinhISO) return "";
  const today = new Date();
  const birth = new Date(ngaySinhISO);
  if (mode === "year") {
    return today.getFullYear() - birth.getFullYear();
  }
  let age = today.getFullYear() - birth.getFullYear();
  const mDiff = today.getMonth() - birth.getMonth();
  if (mDiff < 0 || (mDiff === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// Địa chỉ CCCD thường có dạng: "Thôn X, Xã Y, Huyện Z, Tỉnh T"
// Phiếu chỉ có 3 ô: Tỉnh/thành | Phường/xã | Số nhà/thôn/xóm
function splitDiaChi(diaChi) {
  const parts = (diaChi || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { soNha: "", phuongXa: "", tinh: "" };
  const tinh = parts[parts.length - 1] || "";
  const soNha = parts[0] || "";
  const phuongXa = parts.slice(1, parts.length - 1).join(", ");
  return { soNha, phuongXa, tinh };
}

// ---------- Phân tích chuỗi quét từ mã QR CCCD ----------
// Định dạng: CCCD|SoCMNDCu|HoTen|ddMMyyyy(sinh)|Gioi|DiaChi|ddMMyyyy(cap)|...
function parseQR(raw) {
  const parts = raw.split("|");
  const cccd = (parts[0] || "").trim();
  const hoTen = (parts[2] || "").trim();
  const ngaySinh = parseDDMMYYYY((parts[3] || "").trim());
  const gioi = (parts[4] || "").trim();
  const diaChi = (parts[5] || "").trim();
  const ngayCap = parseDDMMYYYY((parts[6] || "").trim());
  return { raw, cccd, hoTen, ngaySinh, gioi, diaChi, ngayCap };
}

// ============================================================
// TRANG 1 - TIẾP ĐÓN
// ============================================================

const qrInput = document.getElementById("qr-input");
const toast = document.getElementById("toast");
const warningBanner = document.getElementById("warning-banner");

const scanResultEl = document.getElementById("scan-result");
const srBadge = document.getElementById("scan-result-badge");
const srDup = document.getElementById("scan-result-dup");
const srSave = document.getElementById("scan-result-save");
const btnPrintScan = document.getElementById("btn-print-scan");
const btnClearScan = document.getElementById("btn-clear-scan");

function showToast(msg, type = "ok") {
  toast.textContent = msg;
  toast.className = "toast show " + type;
  setTimeout(() => (toast.className = "toast"), 2500);
}

// Hiện thông tin vừa quét lên khối kết quả (chưa in, chưa chắc đã lưu xong)
function showScanResult(data, tuoi, diaChiParts) {
  document.getElementById("sr-ho-ten").textContent = data.hoTen || "";
  document.getElementById("sr-gioi").textContent = data.gioi || "";
  const tuoiText = typeof tuoi === "number" ? ` (${tuoi} tuổi)` : "";
  document.getElementById("sr-ngay-sinh").textContent = formatDateVN(data.ngaySinh) + tuoiText;
  document.getElementById("sr-cccd").textContent = data.cccd || "";
  document.getElementById("sr-ngay-cap").textContent = formatDateVN(data.ngayCap);
  document.getElementById("sr-dia-chi").textContent = data.diaChi || "";

  srBadge.textContent = "Hợp lệ";
  srBadge.className = "badge-status ok";
  srDup.style.display = "none";
  srDup.textContent = "";
  srSave.textContent = "Đang lưu vào hệ thống…";
  srSave.className = "scan-result-save";

  scanResultEl.classList.add("show");
}

// Báo thẻ đã tồn tại trên hệ thống — không tự thêm bản ghi trùng
function showDuplicateWarning(existing) {
  srBadge.textContent = "⚠ Đã có trên hệ thống";
  srBadge.className = "badge-status warn";
  let ngay = "";
  let gio = "";
  if (existing?.created_at) {
    const d = new Date(existing.created_at);
    ngay = `ngày ${d.toLocaleDateString("vi-VN")}`;
    gio = ` lúc ${d.toLocaleTimeString("vi-VN", { hour12: false }).slice(0, 5)}`;
  }
  srDup.textContent = `⚠ Thẻ CCCD này đã được tiếp đón${ngay ? " " + ngay : ""}${gio}. Hệ thống không lưu thêm bản ghi trùng — bạn vẫn có thể bấm "In phiếu" nếu cần in lại.`;
  srDup.style.display = "block";
}

function setSaveStatus(text, type) {
  srSave.textContent = text;
  srSave.className = "scan-result-save" + (type ? " " + type : "");
}

btnPrintScan?.addEventListener("click", () => window.print());
btnClearScan?.addEventListener("click", () => {
  scanResultEl.classList.remove("show");
  warningBanner.style.display = "none";
  qrInput?.focus();
});

function fillPrintTemplate(data, settings, tuoi, diaChiParts) {
  const genderNam = data.gioi === "Nam";
  document.getElementById("pt-ten-xa").textContent = currentTram?.ten_xa || "";
  document.getElementById("pt-ten-tram").textContent = currentTram?.ten_tram || "";
  document.getElementById("pt-ho-ten").textContent = data.hoTen.toUpperCase();
  document.getElementById("pt-gioi-nam").textContent = genderNam ? "☒" : "☐";
  document.getElementById("pt-gioi-nu").textContent = genderNam ? "☐" : "☒";
  document.getElementById("pt-ngay-sinh").textContent = formatDateVN(data.ngaySinh);
  document.getElementById("pt-tuoi").textContent = tuoi;
  document.getElementById("pt-cccd").textContent = data.cccd;
  document.getElementById("pt-ngay-cap").textContent = formatDateVN(data.ngayCap);
  document.getElementById("pt-noi-cap").textContent = "";
  document.getElementById("pt-dan-toc").textContent = settings.dan_toc;
  document.getElementById("pt-doi-tuong").textContent = settings.doi_tuong;
  document.getElementById("pt-nguon-chi-tra").textContent = settings.nguon_chi_tra;
  document.getElementById("pt-nhom-mau").textContent = settings.nhom_mau;
  document.getElementById("pt-tinh").textContent = diaChiParts.tinh;
  document.getElementById("pt-phuong-xa").textContent = diaChiParts.phuongXa;
  document.getElementById("pt-so-nha").textContent = diaChiParts.soNha;
  document.getElementById("pt-nghe-nghiep").textContent = settings.nghe_nghiep;
  document.getElementById("pt-noi-lam-viec").textContent = settings.noi_lam_viec;
  document.getElementById("pt-ly-do").textContent = settings.ly_do_kham;
}

async function handleScan(raw) {
  raw = raw.trim();
  if (!raw) return;

  if (!currentTram) {
    showToast("⚠ Chưa tải được cấu hình trạm y tế, vui lòng tải lại trang", "err");
    return;
  }

  const data = parseQR(raw);
  const settings = getSettings();

  if (!settings.nguoi_quet) {
    showToast("⚠ Chưa chọn người quét — vào Cấu hình đợt khám để chọn", "err");
  }

  if (!data.cccd || !data.hoTen) {
    showToast("⚠ Không đọc được dữ liệu QR, thử quét lại", "err");
    return;
  }

  playBeep();

  const tuoi = calcTuoi(data.ngaySinh, settings.ageMode);
  warningBanner.style.display = "none";
  if (typeof tuoi === "number" && tuoi < 18) {
    warningBanner.textContent = `⚠ ${data.hoTen} — ${tuoi} tuổi theo dữ liệu CCCD. Mẫu phiếu đang dùng chỉ dành cho người từ 18 tuổi trở lên.`;
    warningBanner.style.display = "block";
  }

  const diaChiParts = splitDiaChi(data.diaChi);
  fillPrintTemplate(data, settings, tuoi, diaChiParts);

  // Hiện thông tin ngay lập tức (chưa in — chỉ in khi bấm nút "In phiếu tiếp đón")
  showScanResult(data, tuoi, diaChiParts);

  qrInput.value = "";
  qrInput.focus();

  // Kiểm tra thẻ đã tồn tại trên hệ thống chưa, để tránh lưu trùng lặp
  let existing = null;
  try {
    const { data: found, error: checkErr } = await sb
      .from("tiep_don")
      .select("id, created_at")
      .eq("tram_id", currentTram.id)
      .eq("cccd", data.cccd)
      .order("created_at", { ascending: false })
      .limit(1);
    if (checkErr) console.error(checkErr);
    if (found && found.length) existing = found[0];
  } catch (e) {
    console.error(e);
  }

  if (existing) {
    showDuplicateWarning(existing);
    showToast(`⚠ ${data.hoTen} đã có trên hệ thống, không lưu trùng`, "err");
    return;
  }

  // Lưu vào Supabase ngay, nhanh nhất có thể
  // Chỉ lưu đúng các trường cần thiết: tram_id, ma_qr, ho_ten, ngay_sinh,
  // gioi, cccd, ngay_cap, dia_chi, nguoi_quet (da_nhap_v20, thoi_gian_nhap_v20,
  // created_at do database tự quản lý / cập nhật sau).
  const row = {
    tram_id: currentTram.id,
    ma_qr: data.raw,
    ho_ten: data.hoTen,
    ngay_sinh: data.ngaySinh,
    gioi: data.gioi,
    cccd: data.cccd,
    ngay_cap: data.ngayCap,
    dia_chi: data.diaChi,
    nguoi_quet: settings.nguoi_quet || null,
  };

  const { error } = await sb.from("tiep_don").insert(row);
  if (error) {
    console.error(error);
    if (error.code === "42501") {
      // Bị CSDL từ chối vì hết hạn dùng thử -> kiểm tra lại gói và hiện màn hình thanh toán
      refreshPlan();
    }
    setSaveStatus("✗ Lỗi lưu dữ liệu, kiểm tra lại kết nối!", "err");
    showToast(`✗ Lỗi lưu dữ liệu: ${data.hoTen}`, "err");
  } else {
    setSaveStatus("✓ Đã lưu vào hệ thống", "ok");
    showToast(`✓ Đã tiếp đón: ${data.hoTen}`, "ok");
  }
}

if (qrInput) {
  qrInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(qrInput.value);
    }
  });
  // Chỉ tự động focus lại ô quét QR khi: đang ở trang tiếp đón,
  // popup cấu hình KHÔNG mở, và không phải đang bấm vào popup/nút/nav khác.
  // (Trước đây nghe click trên TOÀN TRANG nên mỗi lần bấm vào dropdown/ô
  // nhập trong popup cấu hình lại bị cướp focus về ô quét QR đang ẩn.)
  window.addEventListener("click", (e) => {
    const isReceptionActive = document
      .getElementById("page-reception")
      ?.classList.contains("active");
    const isSettingsOpen = settingsModal && settingsModal.style.display === "flex";
    const isCameraOpen = document.getElementById("camera-modal")?.style.display === "flex";
    if (!isReceptionActive || isSettingsOpen || isCameraOpen) return;
    if (e.target.closest("#settings-modal, .modal, button, select, a")) return;
    qrInput.focus();
  });
  qrInput.focus();
}

// ---------- Modal cài đặt đợt khám ----------
const settingsModal = document.getElementById("settings-modal");
const settingsForm = document.getElementById("settings-form");
const nguoiQuetSelect = document.getElementById("field-nguoi-quet");
const currentNguoiQuetEl = document.getElementById("current-nguoi-quet");

// Đổ danh sách tên nhân viên (cấu hình riêng theo từng trạm, lưu ở Supabase)
// vào ô chọn "Người quét"
function populateNguoiQuetSelect() {
  if (!nguoiQuetSelect) return;
  const list = currentTram?.danh_sach_nguoi_quet || [];
  nguoiQuetSelect.innerHTML =
    `<option value="">— Chọn tên —</option>` +
    list.map((ten) => `<option value="${ten}">${ten}</option>`).join("");
}

// Hiện tên người quét đang được chọn trên thanh công cụ trang Tiếp đón,
// để biết ngay đang tiếp đón dưới tên ai mà không cần mở lại cấu hình.
function updateCurrentNguoiQuetLabel() {
  if (!currentNguoiQuetEl) return;
  const s = getSettings();
  currentNguoiQuetEl.textContent = s.nguoi_quet
    ? `Người quét: ${s.nguoi_quet}`
    : "⚠ Chưa chọn người quét — mở Cấu hình đợt khám để chọn";
}
updateCurrentNguoiQuetLabel();

function openSettings() {
  const s = getSettings();
  for (const key of Object.keys(s)) {
    const el = settingsForm.elements[key];
    if (el) el.value = s[key];
  }
  settingsModal.style.display = "flex";
}

function closeSettings() {
  settingsModal.style.display = "none";
}

if (settingsForm) {
  settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(settingsForm);
    const s = Object.fromEntries(fd.entries());
    saveSettings(s);
    updateCurrentNguoiQuetLabel();
    closeSettings();
    qrInput.focus();
    showToast("Đã lưu cấu hình đợt khám", "ok");
  });
}

// ---------- Quét QR bằng camera ----------
// Cách Zalo quét nhanh & chính xác: (1) xin camera độ phân giải cao, (2) bật lấy nét
// liên tục (continuous autofocus), (3) ZOOM/CẮT vào đúng vùng khung ngắm trước khi
// giải mã — vì mã QR trên CCCD rất nhỏ so với cả khung hình, nếu đưa nguyên khung hình
// độ phân giải thấp cho bộ giải mã thì mã QR chỉ chiếm vài chục điểm ảnh, rất khó đọc.
// Ở đây mô phỏng lại bằng: getUserMedia độ phân giải cao + zoom phần cứng (nếu máy hỗ
// trợ) + luôn crop vùng trung tâm (khớp khung ngắm trên màn hình) rồi phóng to lên một
// canvas làm việc trước khi đưa cho ZXing giải mã — thay vì dùng chế độ quét mặc định
// của thư viện (chỉ đọc nguyên khung hình gốc, không zoom).
const cameraModal = document.getElementById("camera-modal");
const cameraVideo = document.getElementById("camera-video");
const cameraStatusEl = document.getElementById("camera-status");
const btnOpenCamera = document.getElementById("btn-open-camera");
const btnCloseCamera = document.getElementById("btn-close-camera");
const btnSwitchCamera = document.getElementById("btn-switch-camera");
const btnTorch = document.getElementById("btn-torch");
const btnZoomIn = document.getElementById("btn-zoom-in");
const btnZoomOut = document.getElementById("btn-zoom-out");
const zoomLabel = document.getElementById("zoom-label");

let cameraDevices = [];
let currentCameraIndex = 0;
let cameraBusy = false; // chặn xử lý trùng khi vừa quét được 1 mã
let activeTrack = null;
let zoomCapabilities = null; // { min, max, step } nếu camera hỗ trợ zoom phần cứng
let currentZoom = 1;
let torchOn = false;

let scanLoopHandle = null;
let qrCoreReader = null; // bộ giải mã QR mức thấp, tự quản lý crop/zoom
const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
let lastDecodeAt = 0;
let attemptIndex = 0; // luân phiên giữa các tỉ lệ crop mỗi lần thử giải mã
const DECODE_INTERVAL_MS = 90; // ~11 lần/giây cho pipeline ZXing (đủ nhanh, không quá tải CPU)
const NATIVE_DECODE_INTERVAL_MS = 55; // ~18 lần/giây cho BarcodeDetector gốc (rẻ hơn nhiều, tương đương Zalo)

// Cờ chống race-condition: BarcodeDetector.detect() là async, có thể vẫn đang
// chạy khi người dùng đã đóng camera — dùng cờ này để callback tự huỷ thay vì
// lỡ gọi handleScan() hoặc lên lịch frame tiếp theo sau khi camera đã tắt.
let cameraScanActive = false;

// ---------- Quét QR bằng API gốc của hệ điều hành (BarcodeDetector) ----------
// Đây là cách Zalo/ML Kit quét nhanh & chính xác: dùng bộ giải mã native của
// Android/Chrome (được OS tối ưu bằng phần cứng) thay vì decode bằng JS thuần.
// Chrome trên Android hỗ trợ tốt; Safari/iOS hiện chưa hỗ trợ nên sẽ tự động
// rơi xuống pipeline ZXing crop/zoom thủ công bên dưới.
let nativeQrSupported = null; // cache kết quả kiểm tra, tránh hỏi lại mỗi lần mở camera
let nativeDetector = null;

async function supportsNativeBarcodeDetector() {
  if (!("BarcodeDetector" in window)) return false;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes("qr_code");
  } catch {
    return false;
  }
}

function nativeDecodeTick(ts) {
  if (!cameraScanActive) return;
  if (!cameraVideo || cameraVideo.readyState < 2 || !nativeDetector) {
    scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    return;
  }
  if (ts - lastDecodeAt < NATIVE_DECODE_INTERVAL_MS) {
    scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    return;
  }
  lastDecodeAt = ts;

  nativeDetector
    .detect(cameraVideo)
    .then((codes) => {
      if (!cameraScanActive) return; // camera đã bị đóng trong lúc chờ detect()
      if (codes && codes.length && !cameraBusy) {
        cameraBusy = true;
        const text = codes[0].rawValue;
        cameraStatusEl.style.color = "var(--ok)";
        cameraStatusEl.textContent = "✓ Đã nhận mã QR";
        try { navigator.vibrate?.(70); } catch {}
        closeCamera();
        handleScan(text);
        return;
      }
      scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    })
    .catch(() => {
      if (!cameraScanActive) return;
      scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    });
}

// Vài phiên bản/bản dựng của thư viện có thể không lộ đủ các lớp mức thấp
// (HTMLCanvasElementLuminanceSource, BinaryBitmap, HybridBinarizer, QRCodeReader)
// cần cho việc tự crop/zoom trước khi giải mã. Kiểm tra trước — nếu thiếu, tự
// động chuyển sang chế độ quét dự phòng bằng BrowserQRCodeReader (đọc nguyên
// khung hình, không crop) để tính năng luôn hoạt động, không im lặng thất bại.
function canUseManualCropDecode() {
  return (
    window.ZXing &&
    typeof ZXing.HTMLCanvasElementLuminanceSource === "function" &&
    typeof ZXing.BinaryBitmap === "function" &&
    typeof ZXing.HybridBinarizer === "function" &&
    typeof ZXing.QRCodeReader === "function"
  );
}

let fallbackReader = null;
let fallbackControls = null;

async function pickBestDeviceId() {
  try {
    cameraDevices = await ZXing.BrowserCodeReader.listVideoInputDevices();
  } catch {
    cameraDevices = [];
  }
  if (!cameraDevices.length) return null;
  // Ưu tiên camera sau (thường ghi "back"/"rear"/"environment" trong tên thiết bị)
  const backIdx = cameraDevices.findIndex((d) => /back|rear|environment|sau/i.test(d.label));
  currentCameraIndex = backIdx >= 0 ? backIdx : 0;
  btnSwitchCamera.style.display = cameraDevices.length > 1 ? "inline-block" : "none";
  return cameraDevices[currentCameraIndex].deviceId;
}

function setupTrackControls(track) {
  zoomCapabilities = null;
  torchOn = false;
  currentZoom = 1;
  btnTorch.style.display = "none";
  btnTorch.textContent = "🔦 Đèn flash";
  btnZoomIn.style.display = "none";
  btnZoomOut.style.display = "none";
  zoomLabel.style.display = "none";

  const caps = track.getCapabilities ? track.getCapabilities() : {};

  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoomCapabilities = caps.zoom;
    btnZoomIn.style.display = "inline-block";
    btnZoomOut.style.display = "inline-block";
    zoomLabel.style.display = "inline-block";
    // Tự phóng to NHẸ ngay từ đầu (giống Zalo zoom sẵn trước khi quét), để mã QR
    // trên thẻ chiếm nhiều diện tích khung hình hơn ngay khi mở camera — không
    // zoom quá tay vì còn phần crop phần mềm phía dưới hỗ trợ thêm.
    const auto = caps.zoom.min + (caps.zoom.max - caps.zoom.min) * 0.2;
    applyZoom(auto);
  } else {
    zoomLabel.textContent = "";
  }

  if (caps.torch) {
    btnTorch.style.display = "inline-block";
  }
}

async function applyZoom(z) {
  if (!activeTrack || !zoomCapabilities) return;
  z = Math.min(zoomCapabilities.max, Math.max(zoomCapabilities.min, z));
  try {
    await activeTrack.applyConstraints({ advanced: [{ zoom: z }] });
    currentZoom = z;
    zoomLabel.textContent = z.toFixed(1) + "x";
  } catch {
    // Một số trình duyệt/camera báo hỗ trợ zoom nhưng vẫn từ chối áp constraint — bỏ qua
  }
}

function buildCoreReader() {
  return new ZXing.QRCodeReader();
}

function decodeTick(ts) {
  if (!cameraScanActive) return;
  if (!cameraVideo || cameraVideo.readyState < 2 || !qrCoreReader) {
    scanLoopHandle = requestAnimationFrame(decodeTick);
    return;
  }
  if (ts - lastDecodeAt < DECODE_INTERVAL_MS) {
    scanLoopHandle = requestAnimationFrame(decodeTick);
    return;
  }
  lastDecodeAt = ts;

  const vw = cameraVideo.videoWidth;
  const vh = cameraVideo.videoHeight;
  if (!vw || !vh) {
    scanLoopHandle = requestAnimationFrame(decodeTick);
    return;
  }

  // QUAN TRỌNG: nếu camera đã zoom phần cứng (currentZoom > 1) thì khung hình
  // video (vw x vh) đã LÀ ảnh phóng to sẵn rồi — không được chia thêm cho
  // currentZoom lần nữa, nếu không sẽ cắt chồng 2 lần zoom, cắt mất luôn góc
  // định vị của mã QR dù mắt nhìn preview vẫn thấy ảnh rất rõ (đây là lỗi cũ).
  // Mỗi lượt thử luân phiên 3 tỉ lệ crop khác nhau (toàn khung / vừa / sát) để
  // bắt được mã QR dù người dùng đưa thẻ gần hay xa, không cần canh khung chuẩn.
  attemptIndex = (attemptIndex + 1) % 3;
  const cropRatio = attemptIndex === 0 ? 1.0 : attemptIndex === 1 ? 0.7 : 0.42;
  const side = Math.min(vw, vh) * cropRatio;
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  const outSize = 800;
  if (scanCanvas.width !== outSize) {
    scanCanvas.width = outSize;
    scanCanvas.height = outSize;
    scanCtx.imageSmoothingEnabled = false; // giữ cạnh sắc nét, không làm mờ khi phóng to
  }
  scanCtx.drawImage(cameraVideo, sx, sy, side, side, 0, 0, outSize, outSize);

  try {
    const luminanceSource = new ZXing.HTMLCanvasElementLuminanceSource(scanCanvas);
    const binaryBitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const result = qrCoreReader.decode(binaryBitmap, hints);
    if (result && !cameraBusy) {
      cameraBusy = true;
      const text = result.getText();
      try { navigator.vibrate?.(70); } catch {}
      cameraStatusEl.style.color = "var(--ok)";
      cameraStatusEl.textContent = "✓ Đã nhận mã QR";
      closeCamera();
      handleScan(text);
      return; // dừng vòng lặp, không cần requestAnimationFrame tiếp
    }
  } catch {
    // Chưa thấy mã hợp lệ trong khung hình này — bình thường, thử lại khung kế tiếp
  }

  scanLoopHandle = requestAnimationFrame(decodeTick);
}

async function startCameraScan(deviceId) {
  stopCameraScan();
  cameraStatusEl.textContent = "";
  cameraBusy = false;

  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatusEl.textContent = "✗ Trình duyệt không hỗ trợ camera, hoặc trang chưa chạy qua HTTPS.";
    return;
  }

  const videoConstraints = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: "environment" } };
  // Xin độ phân giải cao — mã QR càng nhiều điểm ảnh càng dễ giải mã.
  videoConstraints.width = { ideal: 3840 };
  videoConstraints.height = { ideal: 3840 };
  // Khung hình/giây cao giúp bộ giải mã (native lẫn ZXing) có nhiều cơ hội bắt
  // được mã QR hơn mỗi giây, đặc biệt khi tay người dùng hơi rung khi cầm thẻ.
  videoConstraints.frameRate = { ideal: 30 };
  // LƯU Ý: KHÔNG đặt `advanced: [{ focusMode: "continuous" }]` ngay trong yêu cầu
  // getUserMedia ban đầu. Safari/iPhone hay trả lỗi OverconstrainedError và từ
  // chối mở camera hoàn toàn khi gặp constraint "advanced" mà nó không hỗ trợ
  // đầy đủ (đây là lỗi WebKit được nhiều người gặp), trong khi Chrome/Android
  // thì âm thầm bỏ qua. focusMode vẫn được áp dụng an toàn hơn NGAY SAU KHI mở
  // camera thành công, thông qua applyConstraints() có bọc try/catch bên dưới —
  // nên bỏ dòng này khỏi yêu cầu ban đầu không làm mất chức năng lấy nét liên tục.

  if (nativeQrSupported === null) {
    nativeQrSupported = await supportsNativeBarcodeDetector();
  }

  // ---------- Nhánh 1: BarcodeDetector gốc của hệ điều hành (nhanh & chính xác
  // nhất, tương đương công nghệ Zalo dùng) — ưu tiên khi trình duyệt hỗ trợ ----------
  if (nativeQrSupported) {
    try {
      const stream = await getCameraStreamWithFallback(videoConstraints);
      cameraVideo.srcObject = stream;
      await cameraVideo.play();

      activeTrack = stream.getVideoTracks()[0];
      try {
        const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.includes("continuous")) {
          await activeTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        }
      } catch {}
      setupTrackControls(activeTrack);

      nativeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
      cameraScanActive = true;
      lastDecodeAt = 0;
      scanLoopHandle = requestAnimationFrame(nativeDecodeTick);
    } catch (e) {
      reportCameraError(e);
    }
    return;
  }

  if (!window.ZXing) {
    cameraStatusEl.textContent = "✗ Không tải được thư viện quét mã. Kiểm tra kết nối mạng.";
    return;
  }

  // ---------- Nhánh 2 (dự phòng, ví dụ Safari/iPhone chưa hỗ trợ BarcodeDetector):
  // nếu trình duyệt/thư viện không lộ đủ API mức thấp để tự crop/zoom trước khi
  // giải mã, dùng thẳng decodeFromConstraints (API đã kiểm chứng luôn hoạt động)
  // — đọc nguyên khung hình, không tự crop phần mềm được, nhưng vẫn đọc được mã,
  // chỉ là kém nhạy hơn với mã QR nhỏ/ở xa. ----------
  if (!canUseManualCropDecode()) {
    try {
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      fallbackReader = new ZXing.BrowserQRCodeReader(hints, { delayBetweenScanAttempts: 80 });
      cameraScanActive = true;
      fallbackControls = await fallbackReader.decodeFromConstraints(
        { video: videoConstraints, audio: false },
        cameraVideo,
        (result) => {
          if (!cameraScanActive) return;
          if (result && !cameraBusy) {
            cameraBusy = true;
            try { navigator.vibrate?.(70); } catch {}
            cameraStatusEl.style.color = "var(--ok)";
            cameraStatusEl.textContent = "✓ Đã nhận mã QR";
            closeCamera();
            handleScan(result.getText());
          }
        }
      );
      activeTrack = cameraVideo.srcObject?.getVideoTracks?.()[0] || null;
      if (activeTrack) setupTrackControls(activeTrack);
    } catch (e) {
      reportCameraError(e);
    }
    return;
  }

  // ---------- Nhánh 3 (dự phòng cuối): ZXing tự crop/zoom thủ công ----------
  try {
    const stream = await getCameraStreamWithFallback(videoConstraints);
    cameraVideo.srcObject = stream;
    await cameraVideo.play();

    activeTrack = stream.getVideoTracks()[0];
    // Nếu trình duyệt không chấp nhận focusMode trong constraint ban đầu, thử áp lại riêng
    try {
      const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes("continuous")) {
        await activeTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch {}
    setupTrackControls(activeTrack);

    qrCoreReader = buildCoreReader();
    cameraScanActive = true;
    lastDecodeAt = 0;
    scanLoopHandle = requestAnimationFrame(decodeTick);
  } catch (e) {
    reportCameraError(e);
  }
}

function reportCameraError(e) {
  console.error(e);
  let msg = "✗ Không thể mở camera.";
  if (e && (e.name === "NotAllowedError" || e.name === "PermissionDeniedError")) {
    msg = "✗ Chưa được cấp quyền camera. Vui lòng cho phép truy cập camera cho trang này.";
  } else if (e && e.name === "NotFoundError") {
    msg = "✗ Không tìm thấy camera trên thiết bị này.";
  } else if (e && e.name === "NotReadableError") {
    msg = "✗ Camera đang được ứng dụng khác sử dụng.";
  } else if (e && e.name === "OverconstrainedError") {
    msg = "✗ Camera của máy không đáp ứng được yêu cầu quét. Thử tải lại trang.";
  } else if (e && e.name) {
    // In kèm tên lỗi gốc để dễ chẩn đoán nếu vẫn còn gặp lỗi khác trên một máy cụ thể
    msg = `✗ Không thể mở camera (${e.name}).`;
  }
  cameraStatusEl.style.color = "var(--err)";
  cameraStatusEl.textContent = msg;
}

// Một số máy (đặc biệt iPhone/Safari đời cũ) từ chối getUserMedia hoàn toàn với lỗi
// OverconstrainedError nếu bất kỳ ràng buộc nào (kể cả chỉ là "ideal") không khớp
// hoàn hảo với phần cứng — dù về mặt chuẩn W3C, "ideal" đáng lẽ chỉ là gợi ý, không
// bắt buộc. Để không bị lỗi hẳn không quét được trên những máy đó, nếu gặp đúng lỗi
// này thì tự động thử lại với ràng buộc tối giản (chỉ chọn camera/hướng camera).
async function getCameraStreamWithFallback(videoConstraints) {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
  } catch (e) {
    if (e && e.name === "OverconstrainedError") {
      const simplified = videoConstraints.deviceId
        ? { deviceId: videoConstraints.deviceId }
        : { facingMode: videoConstraints.facingMode || { ideal: "environment" } };
      return await navigator.mediaDevices.getUserMedia({ video: simplified, audio: false });
    }
    throw e;
  }
}

function stopCameraScan() {
  cameraScanActive = false;
  if (scanLoopHandle) {
    cancelAnimationFrame(scanLoopHandle);
    scanLoopHandle = null;
  }
  qrCoreReader = null;
  nativeDetector = null;
  if (fallbackControls) {
    try { fallbackControls.stop(); } catch {}
    fallbackControls = null;
  }
  if (fallbackReader) {
    try { fallbackReader.reset(); } catch {}
    fallbackReader = null;
  }
  if (cameraVideo && cameraVideo.srcObject) {
    cameraVideo.srcObject.getTracks().forEach((t) => t.stop());
    cameraVideo.srcObject = null;
  }
  activeTrack = null;
  zoomCapabilities = null;
}

async function openCamera() {
  if (!cameraModal) return;
  cameraModal.style.display = "flex";
  const deviceId = await pickBestDeviceId();
  startCameraScan(deviceId || undefined);
}

function closeCamera() {
  stopCameraScan();
  if (cameraModal) cameraModal.style.display = "none";
}

// Chạm vào khung camera để lấy nét đúng vị trí đó (nếu máy hỗ trợ) — hữu ích khi
// đưa thẻ CCCD lại gần, camera lấy nét macro chưa kịp bắt nét khu vực mã QR.
cameraVideo?.addEventListener("click", async (e) => {
  if (!activeTrack) return;
  try {
    const rect = cameraVideo.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : {};
    if (caps.pointsOfInterest) {
      const advanced = [{ pointsOfInterest: [{ x, y }] }];
      if (caps.focusMode && caps.focusMode.includes("single-shot")) {
        advanced[0].focusMode = "single-shot";
      }
      await activeTrack.applyConstraints({ advanced });
    }
  } catch {}
});

btnOpenCamera?.addEventListener("click", openCamera);
btnCloseCamera?.addEventListener("click", () => {
  closeCamera();
  qrInput?.focus();
});
btnSwitchCamera?.addEventListener("click", () => {
  if (!cameraDevices.length) return;
  currentCameraIndex = (currentCameraIndex + 1) % cameraDevices.length;
  startCameraScan(cameraDevices[currentCameraIndex].deviceId);
});
btnZoomIn?.addEventListener("click", () => {
  if (!zoomCapabilities) return;
  const step = zoomCapabilities.step || (zoomCapabilities.max - zoomCapabilities.min) / 10;
  applyZoom(currentZoom + step);
});
btnZoomOut?.addEventListener("click", () => {
  if (!zoomCapabilities) return;
  const step = zoomCapabilities.step || (zoomCapabilities.max - zoomCapabilities.min) / 10;
  applyZoom(currentZoom - step);
});
btnTorch?.addEventListener("click", async () => {
  if (!activeTrack) return;
  try {
    await activeTrack.applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
    btnTorch.textContent = torchOn ? "🔦 Tắt đèn" : "🔦 Đèn flash";
  } catch {
    showToast("Thiết bị không hỗ trợ bật đèn flash qua trình duyệt", "err");
  }
});
window.addEventListener("beforeunload", stopCameraScan);



let allRows = [];
let hideExported = true;
let currentRange = "today"; // today | yesterday | 7d | 30d | custom | all
let loadListSeq = 0; // chống ghi đè khi bấm lọc liên tiếp

// ---------- Tiện ích ngày theo GIỜ VIỆT NAM (UTC+7), không phụ thuộc múi giờ máy ----------
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// Trả về chuỗi YYYY-MM-DD của ngày hiện tại theo giờ VN, cộng thêm offsetDays ngày
function vnDateStr(offsetDays = 0) {
  const t = new Date(Date.now() + VN_OFFSET_MS + offsetDays * 86400000);
  return t.toISOString().slice(0, 10);
}

// Cộng/trừ ngày cho chuỗi YYYY-MM-DD
function addDaysStr(dateStr, n) {
  const t = new Date(`${dateStr}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function fmtDMY(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// Tính khoảng [from, to] (YYYY-MM-DD, gồm cả 2 đầu) theo lựa chọn hiện tại
function getRangeDates() {
  const today = vnDateStr(0);
  switch (currentRange) {
    case "today": return { from: today, to: today, label: `Hôm nay (${fmtDMY(today)})` };
    case "yesterday": {
      const y = vnDateStr(-1);
      return { from: y, to: y, label: `Hôm qua (${fmtDMY(y)})` };
    }
    case "7d": {
      const f = vnDateStr(-6);
      return { from: f, to: today, label: `7 ngày nay (${fmtDMY(f)} – ${fmtDMY(today)})` };
    }
    case "30d": {
      const f = vnDateStr(-29);
      return { from: f, to: today, label: `1 tháng nay (${fmtDMY(f)} – ${fmtDMY(today)})` };
    }
    case "custom": {
      let f = document.getElementById("filter-from").value;
      let t = document.getElementById("filter-to").value;
      if (!f && !t) return { from: null, to: null, label: "Khoảng thời gian: chọn ngày bắt đầu/kết thúc", incomplete: true };
      if (f && t && f > t) [f, t] = [t, f]; // người dùng chọn ngược -> tự đảo
      const label = `Từ ${f ? fmtDMY(f) : "…"} đến ${t ? fmtDMY(t) : "…"}`;
      return { from: f || null, to: t || null, label };
    }
    default: return { from: null, to: null, label: "Tất cả thời gian" };
  }
}

function setListMessage(text, isErr = false) {
  const tbody = document.getElementById("list-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr style="cursor:default"><td colspan="11" class="list-msg${isErr ? " err" : ""}">${text}</td></tr>`;
}

// Đảm bảo đã biết trạm hiện tại (đợi tối đa ~5 giây nếu đang tải)
async function ensureTram() {
  if (currentTram) return currentTram;
  for (let i = 0; i < 25 && !currentTram; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!currentTram) {
    try { await loadTramConfig(); } catch (e) { console.error(e); }
  }
  return currentTram;
}

async function loadList() {
  const seq = ++loadListSeq;
  setListMessage("Đang tải danh sách...");

  const tram = await ensureTram();
  if (seq !== loadListSeq) return;
  if (!tram) {
    setListMessage("⚠ Chưa xác định được trạm y tế của tài khoản này. Hãy tải lại trang hoặc đăng nhập lại.", true);
    return;
  }

  const range = getRangeDates();
  const summaryEl = document.getElementById("list-summary");
  if (range.incomplete) {
    allRows = [];
    if (summaryEl) summaryEl.innerHTML = `<b>${range.label}</b>`;
    setListMessage("Hãy chọn ngày bắt đầu và/hoặc ngày kết thúc để xem danh sách.");
    return;
  }

  let query = sb
    .from("tiep_don")
    .select("*")
    .eq("tram_id", tram.id)
    .order("created_at", { ascending: false });

  // created_at là timestamptz -> so sánh theo mốc 00:00 giờ VN (+07:00)
  if (range.from) query = query.gte("created_at", `${range.from}T00:00:00+07:00`);
  if (range.to) query = query.lt("created_at", `${addDaysStr(range.to, 1)}T00:00:00+07:00`);

  const { data, error } = await query.limit(2000);
  if (seq !== loadListSeq) return; // đã có lần lọc mới hơn
  if (error) {
    console.error("Lỗi tải danh sách:", error);
    setListMessage(`✗ Không tải được danh sách: ${error.message || "lỗi không xác định"}`, true);
    return;
  }
  allRows = data || [];
  renderList();
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderList() {
  const term = document.getElementById("search-box").value.trim().toLowerCase();
  const tbody = document.getElementById("list-body");
  const summaryEl = document.getElementById("list-summary");
  tbody.innerHTML = "";

  let rows = allRows.filter((r) => (hideExported ? !r.da_nhap_v20 : true));
  if (term) {
    rows = rows.filter((r) =>
      [r.ho_ten, r.cccd, r.dia_chi].filter(Boolean).join(" ").toLowerCase().includes(term)
    );
  }

  const range = getRangeDates();
  const total = allRows.length;
  const done = allRows.filter((r) => r.da_nhap_v20).length;
  if (summaryEl) {
    summaryEl.innerHTML =
      `<b>${range.label}</b> — đã quét <b>${total}</b> người, đã bàn giao V20 <b>${done}</b>, ` +
      `chưa bàn giao <b>${total - done}</b> · đang hiển thị <b>${rows.length}</b>`;
  }

  if (!rows.length) {
    const hiddenCount = allRows.length - rows.length;
    let msg = "Không có ai được quét trong khoảng thời gian này.";
    if (allRows.length && hideExported && !term) msg = `Tất cả ${allRows.length} người đã bàn giao V20 (đang được ẩn). Bỏ tích “Ẩn những người đã bàn giao V20” để xem lại.`;
    else if (allRows.length && term) msg = "Không có kết quả khớp với từ khóa tìm kiếm.";
    setListMessage(msg);
    return;
  }

  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    if (r.da_nhap_v20) tr.classList.add("exported");
    const createdAt = r.created_at ? new Date(r.created_at) : null;
    const gioText = createdAt
      ? createdAt.toLocaleTimeString("vi-VN", { hour12: false, timeZone: "Asia/Ho_Chi_Minh" }).slice(0, 5)
      : "";
    const ngayText = createdAt
      ? createdAt.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
      : "";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${gioText}</td>
      <td>${ngayText}</td>
      <td>${escapeHtml(r.ho_ten)}</td>
      <td>${formatDateVN(r.ngay_sinh)}</td>
      <td>${escapeHtml(r.gioi)}</td>
      <td class="cccd-cell">${escapeHtml(r.cccd)}</td>
      <td>${escapeHtml(r.dia_chi)}</td>
      <td>${escapeHtml(r.nguoi_quet)}</td>
      <td>${r.da_nhap_v20 ? "✓ Đã nhập" : "—"}</td>
      <td><button type="button" class="btn-print-row" data-id="${r.id}">🖨 In phiếu</button></td>
    `;
    tr.addEventListener("click", () => copyRow(r, tr));
    tr.querySelector(".btn-print-row")?.addEventListener("click", (e) => {
      e.stopPropagation(); // không cho kích hoạt copyRow khi bấm nút in
      printRow(r);
    });
    tbody.appendChild(tr);
  });
}

// ---------- In lại phiếu khám sức khỏe từ danh sách ----------
// Dùng chính dữ liệu đã lưu tại thời điểm tiếp đón (không phụ thuộc cấu hình
// hiện tại của máy), để phiếu in ra khớp với những gì đã ghi nhận ban đầu.
function printRow(row) {
  const data = {
    hoTen: row.ho_ten || "",
    gioi: row.gioi || "",
    ngaySinh: row.ngay_sinh || "",
    cccd: row.cccd || "",
    ngayCap: row.ngay_cap || "",
  };
  // Các trường dân tộc/đối tượng/nghề nghiệp... không còn lưu theo từng người
  // trong CSDL (chỉ còn là cấu hình chung của đợt khám) — dùng cấu hình hiện
  // tại của máy khi in lại từ danh sách.
  const settings = getSettings();
  const diaChiParts = splitDiaChi(row.dia_chi || "");
  const tuoi = calcTuoi(row.ngay_sinh, settings.ageMode);

  fillPrintTemplate(data, settings, tuoi, diaChiParts);
  window.print();
}

async function copyRow(row, trEl) {
  try {
    await navigator.clipboard.writeText(row.ma_qr);
  } catch (e) {
    console.error("Clipboard error", e);
  }

  trEl.classList.add("copied");

  const { error } = await sb
    .from("tiep_don")
    .update({ da_nhap_v20: true, thoi_gian_nhap_v20: new Date().toISOString() })
    .eq("id", row.id);

  if (error) {
    console.error(error);
    if (error.code === "42501") refreshPlan();
  }

  setTimeout(() => {
    row.da_nhap_v20 = true;
    row.thoi_gian_nhap_v20 = new Date().toISOString();
    renderList();
  }, 2000);
}

document.getElementById("search-box")?.addEventListener("input", renderList);
document.getElementById("range-bar")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".range-btn");
  if (!btn) return;
  currentRange = btn.dataset.range;
  document.querySelectorAll("#range-bar .range-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.getElementById("range-custom")?.classList.toggle("show", currentRange === "custom");
  if (currentRange === "custom") {
    const fromEl = document.getElementById("filter-from");
    const toEl = document.getElementById("filter-to");
    if (!fromEl.value) fromEl.value = vnDateStr(-6);
    if (!toEl.value) toEl.value = vnDateStr(0);
  }
  loadList();
});
document.getElementById("filter-from")?.addEventListener("change", loadList);
document.getElementById("filter-to")?.addEventListener("change", loadList);
document.getElementById("toggle-hide-exported")?.addEventListener("change", (e) => {
  hideExported = e.target.checked;
  renderList();
});

// ---------- Realtime: tự cập nhật khi có tiếp đón mới từ máy khác cùng trạm ----------
// Chỉ đăng ký sau khi biết trạm hiện tại (currentTram), và lọc đúng tram_id
// để không nhận thông báo dữ liệu của trạm khác dùng chung hệ thống.
let realtimeChannel = null;

function subscribeRealtime() {
  if (!currentTram) return;
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  realtimeChannel = sb
    .channel(`tiep_don-changes-${currentTram.id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tiep_don", filter: `tram_id=eq.${currentTram.id}` },
      () => {
        if (document.getElementById("page-list").classList.contains("active")) {
          loadList();
        }
      }
    )
    .subscribe();
}

function unsubscribeRealtime() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ============================================================
// ĐIỀU HƯỚNG 2 TRANG
// ============================================================

function switchPage(name) {
  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((el) => el.classList.remove("active"));
  document.getElementById(`page-${name}`).classList.add("active");
  document.getElementById(`nav-${name}`).classList.add("active");
  if (name !== "reception") closeCamera();
  if (name === "list") loadList();
  if (name === "reception") qrInput?.focus();
}

document.getElementById("nav-reception")?.addEventListener("click", () => switchPage("reception"));
document.getElementById("nav-list")?.addEventListener("click", () => switchPage("list"));
document.getElementById("btn-settings")?.addEventListener("click", openSettings);
document.getElementById("btn-close-settings")?.addEventListener("click", closeSettings);

// Mặc định: tab danh sách mở với bộ lọc "Hôm nay" (tính theo giờ Việt Nam)

// ============================================================
// CẤU HÌNH THÔNG TIN TRẠM Y TẾ (mỗi trạm tự chỉnh, không ảnh hưởng trạm khác)
// Tên xã/tên trạm dùng để in trên phiếu khám; danh sách người quét là danh
// sách nhân viên của riêng trạm đó, hiện trong ô "Người quét" ở Cấu hình đợt khám.
// ============================================================
const tramSettingsModal = document.getElementById("tram-settings-modal");
const tramSettingsForm = document.getElementById("tram-settings-form");
const tramSettingsErrorEl = document.getElementById("tram-settings-error");
const tramSettingsSubmitEl = document.getElementById("tram-settings-submit");
const fieldTenXaEl = document.getElementById("field-ten-xa");
const fieldTenTramEl = document.getElementById("field-ten-tram");
const fieldDanhSachNguoiQuetEl = document.getElementById("field-danh-sach-nguoi-quet");

function openTramSettings() {
  if (!currentTram) return;
  tramSettingsErrorEl.textContent = "";
  fieldTenXaEl.value = currentTram.ten_xa || "";
  fieldTenTramEl.value = currentTram.ten_tram || "";
  fieldDanhSachNguoiQuetEl.value = (currentTram.danh_sach_nguoi_quet || []).join("\n");
  tramSettingsModal.style.display = "flex";
}

function closeTramSettings() {
  tramSettingsModal.style.display = "none";
}

document.getElementById("btn-tram-settings")?.addEventListener("click", openTramSettings);
document.getElementById("btn-close-tram-settings")?.addEventListener("click", closeTramSettings);

tramSettingsForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentTram) return;

  const tenXa = fieldTenXaEl.value.trim();
  const tenTram = fieldTenTramEl.value.trim();
  // Mỗi dòng một tên, bỏ dòng trống, bỏ khoảng trắng thừa
  const danhSachNguoiQuet = fieldDanhSachNguoiQuetEl.value
    .split("\n")
    .map((ten) => ten.trim())
    .filter(Boolean);

  if (!tenXa || !tenTram) {
    tramSettingsErrorEl.textContent = "Vui lòng nhập đầy đủ tên xã và tên trạm y tế.";
    return;
  }

  tramSettingsErrorEl.textContent = "";
  tramSettingsSubmitEl.disabled = true;
  tramSettingsSubmitEl.textContent = "Đang lưu...";

  const { data, error } = await sb
    .from("tram_y_te")
    .update({ ten_xa: tenXa, ten_tram: tenTram, danh_sach_nguoi_quet: danhSachNguoiQuet })
    .eq("id", currentTram.id)
    .select()
    .single();

  tramSettingsSubmitEl.disabled = false;
  tramSettingsSubmitEl.textContent = "Lưu";

  if (error) {
    console.error(error);
    tramSettingsErrorEl.textContent = "Không lưu được, vui lòng thử lại.";
    return;
  }

  currentTram = data;
  applyTramConfig();
  closeTramSettings();
  showToast("✓ Đã lưu cấu hình trạm y tế", "ok");
});

})(); // kết thúc hàm async bọc toàn bộ app.js
