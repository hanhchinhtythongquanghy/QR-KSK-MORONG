# Triển khai: GitHub → Vercel + Supabase

Luồng làm việc: code lưu trên **GitHub** → **Vercel** tự deploy mỗi lần push →
Vercel đọc khóa Supabase từ **Environment Variables** (nạp từ file `.env`).
Dự án là site tĩnh (không cần build) + hàm serverless trong `api/`.

## 1) Chuẩn bị Supabase

1. Vào **SQL Editor**, chạy lần lượt `schema.sql`, `admin.sql` rồi `billing.sql` (dùng thử 7 ngày + thanh toán).
2. Lấy 3 giá trị ở **Project Settings > API**:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` → `SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_ROLE_KEY` (⚠ tuyệt đối bí mật)
3. **Authentication > Users > Add user** tạo tài khoản admin của bạn, rồi chạy:
   ```sql
   insert into public.admins (id) values ('<uid-của-bạn>');
   ```

## 2) Tạo file `.env` (chỉ nằm trên máy bạn)

```bash
cp .env.example .env
# mở .env và điền 3 giá trị lấy ở bước 1.2
```
`.env` đã nằm trong `.gitignore`, sẽ **không** bị đưa lên GitHub.

## 3) Đưa code lên GitHub

```bash
git init
git add .
git commit -m "Khởi tạo dự án"
git branch -M main
git remote add origin https://github.com/<tên-bạn>/<tên-repo>.git
git push -u origin main
```
(Tạo repo trống trên github.com trước, nên để **Private**.)
Kiểm tra kỹ trên GitHub: không được có file `.env`.

## 4) Tạo project trên Vercel

1. Vercel → **Add New… > Project** → chọn repo GitHub vừa tạo → **Import**.
2. Framework Preset: **Other**. Để trống Build Command và Output Directory.
3. **Chưa bấm Deploy** — sang bước 5 để khai báo biến trước.

## 5) Khai báo biến môi trường từ file `.env`

**Cách A – dán trực tiếp (dễ nhất):** ở màn hình import, mục
**Environment Variables**, mở file `.env`, copy toàn bộ nội dung rồi dán vào
ô *Key* — Vercel tự tách thành 3 biến. Sau đó bấm **Deploy**.

**Cách B – dùng script (project đã tạo sẵn):**
```bash
npm i -g vercel
vercel login
vercel link
bash scripts/vercel-env-push.sh      # đọc .env, đẩy lên cả 3 môi trường
```
Biến chỉ có hiệu lực cho lần deploy **sau** khi thêm/sửa, nên cần deploy lại
(`Deployments > Redeploy`, hoặc push commit mới).

## 6) Kiểm tra

- `/index.html` vào được màn hình đăng nhập (nếu báo đỏ "Không tải được cấu
  hình" → biến chưa đúng hoặc chưa redeploy; xem **Logs** của `/api/config`).
- `/admin.html` đăng nhập admin, thử **"+ Thêm trạm mới"**.

## 7) Cập nhật về sau

Sửa code → `git push` → Vercel tự deploy. Đổi khóa Supabase → sửa `.env`,
chạy lại script (hoặc sửa trên dashboard) → Redeploy.

## Thanh toán SePay (dùng thử 7 ngày → 200.000đ)

- Mỗi trạm được 7 ngày dùng thử. Hết hạn, phần mềm tự khóa và hiện mã QR chuyển
  khoản tới Vietinbank **101868077303** với số tiền `PLAN_PRICE` (mặc định 200.000đ)
  và nội dung riêng của trạm (dạng `KSKxxxxxxxx`). Mỗi 200.000đ = `PLAN_DAYS` ngày (mặc định 30).
- Cách bật:
  1. Đăng ký SePay, **liên kết tài khoản Vietinbank 101868077303** trong SePay.
  2. Trong `.env` đặt `SEPAY_API_KEY` = một chuỗi bí mật bạn tự đặt, đẩy lên Vercel rồi Redeploy.
  3. SePay > **Tích hợp Webhooks > Thêm webhooks**: URL `https://<tên-miền-vercel>/api/sepay-webhook`,
     kiểu chứng thực **API Key** (điền đúng chuỗi ở bước 2), sự kiện: **có tiền vào**.
  4. Thử: chuyển khoản 200.000đ với nội dung là mã của trạm hết hạn → vài giây sau phần mềm tự mở lại.
- Chuyển sai nội dung / thiếu tiền: giao dịch vẫn được ghi ở bảng `thanh_toan`
  (cột `trang_thai`); vào trang admin bấm **Gia hạn** ở trạm tương ứng để xử lý tay.
- Trạm muốn miễn phí vĩnh viễn: SQL Editor chạy `update tram_y_te set mien_phi = true where id = '<id>';`

## Lưu ý bảo mật

- `SUPABASE_SERVICE_ROLE_KEY` chỉ dùng trong `lib/adminActions.js` (phía máy
  chủ). Không được đặt tên biến bắt đầu bằng `NEXT_PUBLIC_`/`VITE_` hay đưa
  vào code trình duyệt.
- Nếu lỡ commit `.env`, hãy **xoay (rotate) khóa** trong Supabase ngay.
