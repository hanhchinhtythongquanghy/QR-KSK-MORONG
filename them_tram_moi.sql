-- ============================================================
-- THÊM_TRAM_MOI.SQL — Mẫu để thêm 1 trạm y tế mới vào hệ thống BẰNG TAY
--
-- ⚠ KHÔNG CÒN CẦN THIẾT cho việc thêm trạm hằng ngày — trang admin.html
-- giờ đã tự tạo trạm + tài khoản đăng nhập trong 1 bước (nút "+ Thêm
-- trạm mới"), qua serverless function dùng service role key.
--
-- File này chỉ còn hữu ích để: (1) tạo TÀI KHOẢN ADMIN đầu tiên cho
-- chính bạn (trang admin.html không tự tạo được tài khoản admin đầu
-- tiên — xem admin.sql), hoặc (2) thao tác thủ công khi cần khắc phục
-- sự cố / không có sẵn quyền deploy serverless function.
-- ============================================================

-- BƯỚC 1 — Tạo trạm mới, điền tên xã / tên trạm / danh sách người quét
-- ban đầu (trạm có thể tự sửa lại sau trong ứng dụng, ở nút "🏥 Trạm").
insert into public.tram_y_te (ten_xa, ten_tram, danh_sach_nguoi_quet)
values (
  'UBND XÃ ...',                 -- 👈 sửa lại
  'TRẠM Y TẾ XÃ ...',            -- 👈 sửa lại
  '["Nguyễn Văn A", "Trần Thị B"]'::jsonb  -- 👈 sửa lại, có thể để []
)
returning id;
-- 👆 Ghi lại "id" trả về (dạng uuid) — cần dùng ở Bước 3.

-- BƯỚC 2 — Tạo tài khoản đăng nhập cho trạm đó (1 tài khoản dùng chung
-- cho cả trạm, giống trước đây):
--   Supabase Dashboard > Authentication > Users > Add user
--   Nhập email + mật khẩu cho trạm, rồi Create user.
--   Ghi lại "User UID" (uuid) của tài khoản vừa tạo.

-- BƯỚC 3 — Gắn tài khoản vừa tạo vào đúng trạm vừa tạo ở Bước 1
-- (thay 2 giá trị uuid dưới đây):
insert into public.profiles (id, tram_id)
values (
  '<user-uuid-tu-buoc-2>',
  '<tram-uuid-tu-buoc-1>'
);

-- Xong — trạm mới có thể đăng nhập ngay vào ứng dụng bằng email/mật khẩu
-- vừa tạo, hệ thống sẽ tự nhận đúng trạm và chỉ thấy dữ liệu của trạm đó.


-- ------------------------------------------------------------
-- (Tuỳ chọn) Kiểm tra nhanh danh sách các trạm và tài khoản đã gắn:
-- ------------------------------------------------------------
-- select t.id as tram_id, t.ten_tram, p.id as user_id
-- from public.tram_y_te t
-- left join public.profiles p on p.tram_id = t.id
-- order by t.created_at;
