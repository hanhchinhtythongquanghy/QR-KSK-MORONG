// Cấu hình gói dịch vụ — đọc từ biến môi trường (có mặc định).
// Dùng chung cho /api/config (hiển thị mã QR) và /api/sepay-webhook (đối soát).
function getPlan() {
  return {
    price: parseInt(process.env.PLAN_PRICE || "200000", 10),       // VNĐ / kỳ
    days: parseInt(process.env.PLAN_DAYS || "30", 10),             // số ngày mỗi kỳ
    bank: process.env.PLAN_BANK || "VietinBank",                   // tên ngân hàng theo SePay/VietQR
    bankFallbackCode: process.env.PLAN_BANK_CODE || "ICB",         // mã VietQR dự phòng
    account: process.env.PLAN_ACCOUNT || "101868077303",           // số tài khoản nhận tiền
    accountName: process.env.PLAN_ACCOUNT_NAME || "",              // tên chủ TK (không bắt buộc)
    prefix: "KSK",                                                 // tiền tố mã thanh toán
  };
}
module.exports = { getPlan };
