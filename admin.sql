-- ============================================================
-- ADMIN.SQL — Bổ sung vai trò QUẢN TRỊ HỆ THỐNG (nhìn/ quản lý được
-- TẤT CẢ các trạm) + view thống kê dùng cho trang admin.html.
-- Chạy SAU KHI đã chạy schema.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Bảng danh sách tài khoản admin (tách riêng khỏi profiles, vì admin
--    không thuộc về 1 trạm cụ thể nào)
-- ------------------------------------------------------------
create table if not exists public.admins (
  id          uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

alter table public.admins enable row level security;

create policy "Admin tự xem mình trong danh sách admin"
  on public.admins for select
  to authenticated
  using (id = auth.uid());

-- Hàm kiểm tra người dùng hiện tại có phải admin không
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.admins where id = auth.uid());
$$;

-- ------------------------------------------------------------
-- 2) Mở quyền cho admin trên các bảng nghiệp vụ (đứng CHỒNG lên các
--    policy "chỉ xem trạm của mình" đã có ở schema.sql — Postgres cho
--    phép nhiều policy cùng loại, thỏa 1 trong các policy là được).
-- ------------------------------------------------------------

-- tram_y_te: admin xem / thêm / sửa / xóa mọi trạm
create policy "Admin xem tất cả trạm"
  on public.tram_y_te for select to authenticated
  using (public.is_admin());

create policy "Admin thêm trạm mới"
  on public.tram_y_te for insert to authenticated
  with check (public.is_admin());

create policy "Admin sửa mọi trạm"
  on public.tram_y_te for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admin xóa trạm"
  on public.tram_y_te for delete to authenticated
  using (public.is_admin());

-- tiep_don: admin chỉ cần XEM (để thống kê), không sửa dữ liệu tiếp đón
-- của trạm khác
create policy "Admin xem tất cả tiếp đón"
  on public.tiep_don for select to authenticated
  using (public.is_admin());

-- profiles: admin xem / gắn / gỡ tài khoản vào trạm
create policy "Admin xem tất cả hồ sơ"
  on public.profiles for select to authenticated
  using (public.is_admin());

create policy "Admin gắn tài khoản vào trạm"
  on public.profiles for insert to authenticated
  with check (public.is_admin());

create policy "Admin sửa gán trạm của tài khoản"
  on public.profiles for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admin gỡ tài khoản khỏi trạm"
  on public.profiles for delete to authenticated
  using (public.is_admin());

-- ------------------------------------------------------------
-- 3) VIEW thống kê theo trạm — dùng cho trang admin.html:
--    tổng số lượt nhập, số lượt nhập hôm nay (theo giờ VN), lần cuối
--    sử dụng, số tài khoản đang gắn vào trạm.
-- ------------------------------------------------------------
create or replace view public.tram_thong_ke as
select
  t.id                as tram_id,
  t.ten_xa,
  t.ten_tram,
  t.created_at        as tram_created_at,
  count(td.id)         as tong_so_nhap,
  count(td.id) filter (
    where td.created_at >= (date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')
  )                     as so_nhap_hom_nay,
  max(td.created_at)   as lan_cuoi_su_dung,
  count(distinct p.id) as so_tai_khoan
from public.tram_y_te t
left join public.tiep_don td on td.tram_id = t.id
left join public.profiles p on p.tram_id = t.id
group by t.id, t.ten_xa, t.ten_tram, t.created_at;

-- View kế thừa RLS của các bảng gốc (tram_y_te / tiep_don / profiles) theo
-- quyền của người đang truy vấn — vì vậy chỉ admin (đã có policy ở trên)
-- mới thấy được dữ liệu của TẤT CẢ các trạm qua view này; tài khoản trạm
-- thường nếu lỡ truy vấn view này cũng chỉ thấy đúng trạm của mình.

-- ------------------------------------------------------------
-- 4) Gắn 1 tài khoản làm admin (chạy sau khi đã tạo tài khoản đăng
--    nhập cho admin trong Supabase Dashboard > Authentication > Users)
-- ------------------------------------------------------------
-- insert into public.admins (id) values ('<user-uuid-cua-admin>');
