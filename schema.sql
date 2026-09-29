-- ============================================================
-- SCHEMA.SQL — Khởi tạo CSDL đa trạm y tế (SaaS) trên Supabase
-- Chạy trong: Supabase Dashboard > SQL Editor > New query > Run
--
-- Kiến trúc: MỘT project Supabase dùng chung cho NHIỀU trạm y tế.
-- Mỗi trạm là 1 dòng trong bảng tram_y_te. Mỗi tài khoản đăng nhập
-- (1 tài khoản chung cho cả trạm, như trước) được gắn vào đúng 1
-- trạm qua bảng profiles. Row Level Security (RLS) đảm bảo tài
-- khoản của trạm nào chỉ thấy/sửa được dữ liệu của trạm đó — các
-- trạm không nhìn thấy dữ liệu của nhau dù dùng chung 1 database.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1) TRẠM Y TẾ (tenant) — thông tin riêng từng trạm, tự cấu hình
--    trong ứng dụng ở nút "🏥 Trạm" sau khi đăng nhập.
-- ------------------------------------------------------------
create table if not exists public.tram_y_te (
  id                    uuid primary key default gen_random_uuid(),
  ten_xa                text not null,               -- in trên phiếu, vd "UBND XÃ HỒNG QUANG"
  ten_tram              text not null,                -- in trên phiếu, vd "TRẠM Y TẾ XÃ HỒNG QUANG"
  danh_sach_nguoi_quet  jsonb not null default '[]'::jsonb,  -- ["Nguyễn Thị A", ...] trạm tự thêm/bớt
  created_at            timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2) HỒ SƠ TÀI KHOẢN — nối 1 tài khoản Supabase Auth vào 1 trạm y tế.
--    Bảng này do QUẢN TRỊ HỆ THỐNG (bạn) tạo dòng khi thêm trạm mới,
--    trạm y tế không tự tạo tài khoản trong ứng dụng.
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  tram_id     uuid not null references public.tram_y_te(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists profiles_tram_id_idx on public.profiles (tram_id);

-- ------------------------------------------------------------
-- 3) TIẾP ĐÓN — thêm cột tram_id để phân vùng dữ liệu giữa các trạm
-- ------------------------------------------------------------
create table if not exists public.tiep_don (
  id                  uuid primary key default gen_random_uuid(),
  tram_id             uuid not null references public.tram_y_te(id) on delete cascade,
  ma_qr               text not null,              -- toàn bộ chuỗi thô đọc được từ mã QR CCCD
  ho_ten              text not null,
  ngay_sinh           date,
  gioi                text,                        -- "Nam" / "Nữ"
  cccd                text not null,
  ngay_cap            date,
  dia_chi             text,
  nguoi_quet          text,                        -- tên nhân viên trực tiếp quét/tiếp đón
  da_nhap_v20         boolean not null default false,
  thoi_gian_nhap_v20  timestamptz,
  created_at          timestamptz not null default now()
);

-- Chống lưu trùng CCCD, nhưng chỉ trong phạm vi CÙNG 1 trạm — hai trạm khác
-- nhau vẫn có thể tiếp đón cùng một công dân (không xung đột nhau).
create unique index if not exists tiep_don_tram_cccd_key on public.tiep_don (tram_id, cccd);
create index if not exists tiep_don_tram_created_idx on public.tiep_don (tram_id, created_at desc);
create index if not exists tiep_don_ho_ten_idx on public.tiep_don (ho_ten);

-- ------------------------------------------------------------
-- Hàm phụ trợ: lấy tram_id của người dùng đang đăng nhập
-- (security definer để đọc được bảng profiles bất kể chính sách RLS
-- của bảng đó, tránh đệ quy chính sách)
-- ------------------------------------------------------------
create or replace function public.current_tram_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select tram_id from public.profiles where id = auth.uid();
$$;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY — cách ly dữ liệu giữa các trạm
-- ------------------------------------------------------------
alter table public.tram_y_te enable row level security;
alter table public.profiles enable row level security;
alter table public.tiep_don enable row level security;

-- profiles: chỉ xem được hồ sơ (tram_id) của chính mình
create policy "Xem hồ sơ của chính mình"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- tram_y_te: chỉ xem/sửa được đúng trạm mình thuộc về
create policy "Xem trạm của mình"
  on public.tram_y_te for select
  to authenticated
  using (id = public.current_tram_id());

create policy "Sửa trạm của mình"
  on public.tram_y_te for update
  to authenticated
  using (id = public.current_tram_id())
  with check (id = public.current_tram_id());

-- tiep_don: chỉ xem/thêm/sửa dữ liệu tiếp đón trong phạm vi trạm mình
create policy "Xem tiếp đón của trạm mình"
  on public.tiep_don for select
  to authenticated
  using (tram_id = public.current_tram_id());

create policy "Thêm tiếp đón cho trạm mình"
  on public.tiep_don for insert
  to authenticated
  with check (tram_id = public.current_tram_id());

create policy "Sửa tiếp đón của trạm mình"
  on public.tiep_don for update
  to authenticated
  using (tram_id = public.current_tram_id())
  with check (tram_id = public.current_tram_id());

-- ------------------------------------------------------------
-- Bật Realtime cho bảng tiep_don (app.js subscribe theo tram_id để
-- danh sách tự cập nhật khi có máy khác cùng trạm vừa tiếp đón)
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.tiep_don;
