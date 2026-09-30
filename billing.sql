-- ============================================================
-- BILLING.SQL — Dùng thử 7 ngày, sau đó tạm dừng và yêu cầu thanh toán.
-- Chạy SAU schema.sql và admin.sql (Supabase > SQL Editor > Run).
-- Có thể chạy lại nhiều lần (idempotent).
--
-- LƯU Ý: các trạm ĐÃ CÓ sẵn sẽ được tính 7 ngày dùng thử kể từ lúc
-- chạy file này. Trạm tạo mới sau này được 7 ngày kể từ lúc tạo.
-- ============================================================

-- 1) Cột gói dịch vụ trên bảng trạm
alter table public.tram_y_te
  add column if not exists trial_ends_at timestamptz not null default (now() + interval '7 days'),
  add column if not exists paid_until    timestamptz,
  add column if not exists mien_phi      boolean not null default false,
  add column if not exists ma_thanh_toan text not null
    default ('KSK' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)));

create unique index if not exists tram_y_te_ma_thanh_toan_key on public.tram_y_te (ma_thanh_toan);

-- 2) Chặn trạm tự sửa cột gói dịch vụ (RLS cho phép trạm sửa dòng của mình,
--    nên cần trigger để không ai tự kéo dài hạn dùng). Chỉ service_role
--    (máy chủ/webhook) hoặc chạy SQL trực tiếp trong Dashboard mới sửa được.
create or replace function public.bao_ve_cot_goi_dich_vu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.trial_ends_at is distinct from old.trial_ends_at
      or new.paid_until is distinct from old.paid_until
      or new.mien_phi is distinct from old.mien_phi
      or new.ma_thanh_toan is distinct from old.ma_thanh_toan)
     and coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'Không được tự sửa thông tin gói dịch vụ';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bao_ve_goi_dich_vu on public.tram_y_te;
create trigger trg_bao_ve_goi_dich_vu
  before update on public.tram_y_te
  for each row execute function public.bao_ve_cot_goi_dich_vu();

-- 3) Nhật ký thanh toán (mỗi giao dịch SePay báo về = 1 dòng)
create table if not exists public.thanh_toan (
  id             bigserial primary key,
  sepay_id       bigint unique,                -- id giao dịch bên SePay, chống xử lý trùng
  tram_id        uuid references public.tram_y_te(id) on delete set null,
  so_tien        bigint not null default 0,
  noi_dung       text,
  ma_tham_chieu  text,
  thoi_gian_ck   timestamptz,
  so_ngay_cong   int not null default 0,
  trang_thai     text not null,                -- da_kich_hoat | khong_khop_ma | thieu_tien | admin_gia_han
  du_lieu_goc    jsonb,
  created_at     timestamptz not null default now()
);

alter table public.thanh_toan enable row level security;

drop policy if exists "Xem thanh toán của trạm mình" on public.thanh_toan;
create policy "Xem thanh toán của trạm mình"
  on public.thanh_toan for select to authenticated
  using (tram_id = public.current_tram_id());

drop policy if exists "Admin xem tất cả thanh toán" on public.thanh_toan;
create policy "Admin xem tất cả thanh toán"
  on public.thanh_toan for select to authenticated
  using (public.is_admin());
-- (Không có policy insert/update: chỉ máy chủ dùng service_role mới ghi được.)

-- 4) Trạm còn hạn sử dụng không?
create or replace function public.tram_dang_hoat_dong(p_tram uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select t.mien_phi or greatest(t.trial_ends_at, t.paid_until) > now()
       from public.tram_y_te t where t.id = p_tram),
    false);
$$;

-- 5) Thông tin gói cho trạm của người đang đăng nhập (app gọi qua rpc)
create or replace function public.goi_dich_vu()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'tram_id',        t.id,
    'ma_thanh_toan',  t.ma_thanh_toan,
    'trial_ends_at',  t.trial_ends_at,
    'paid_until',     t.paid_until,
    'mien_phi',       t.mien_phi,
    'han_dung',       greatest(t.trial_ends_at, t.paid_until),
    'giay_con_lai',   greatest(0, floor(extract(epoch from (greatest(t.trial_ends_at, t.paid_until) - now()))))::bigint,
    'giai_doan',      case
                        when t.mien_phi then 'mien_phi'
                        when t.paid_until is not null and t.paid_until > now() then 'tra_phi'
                        when t.trial_ends_at > now() then 'dung_thu'
                        else 'het_han'
                      end,
    'server_now',     now()
  )
  from public.tram_y_te t
  where t.id = public.current_tram_id();
$$;

grant execute on function public.goi_dich_vu() to authenticated;
grant execute on function public.tram_dang_hoat_dong(uuid) to authenticated;

-- 6) Kích hoạt / gia hạn gói (CHỈ máy chủ gọi được). Cộng dồn từ mốc xa nhất
--    trong (bây giờ, hạn đã trả phí, hạn dùng thử) để không mất ngày còn lại.
create or replace function public.kich_hoat_goi(p_tram uuid, p_days int)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new timestamptz;
begin
  update public.tram_y_te
     set paid_until = greatest(now(), paid_until, trial_ends_at) + make_interval(days => p_days)
   where id = p_tram
  returning paid_until into v_new;
  return v_new;
end;
$$;

revoke all on function public.kich_hoat_goi(uuid, int) from public, anon, authenticated;
grant execute on function public.kich_hoat_goi(uuid, int) to service_role;

-- 7) Ép quy tắc ở tầng CSDL: hết hạn thì không thêm / sửa được tiếp đón,
--    dù có cố gọi thẳng API bỏ qua giao diện.
drop policy if exists "Thêm tiếp đón cho trạm mình" on public.tiep_don;
create policy "Thêm tiếp đón cho trạm mình"
  on public.tiep_don for insert to authenticated
  with check (tram_id = public.current_tram_id() and public.tram_dang_hoat_dong(tram_id));

drop policy if exists "Sửa tiếp đón của trạm mình" on public.tiep_don;
create policy "Sửa tiếp đón của trạm mình"
  on public.tiep_don for update to authenticated
  using (tram_id = public.current_tram_id() and public.tram_dang_hoat_dong(tram_id))
  with check (tram_id = public.current_tram_id() and public.tram_dang_hoat_dong(tram_id));

-- 8) View thống kê cho admin: thêm thông tin gói (cột mới đặt ở cuối)
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
  count(distinct p.id) as so_tai_khoan,
  t.trial_ends_at,
  t.paid_until,
  t.mien_phi,
  t.ma_thanh_toan,
  case
    when t.mien_phi then 'mien_phi'
    when t.paid_until is not null and t.paid_until > now() then 'tra_phi'
    when t.trial_ends_at > now() then 'dung_thu'
    else 'het_han'
  end                  as giai_doan
from public.tram_y_te t
left join public.tiep_don td on td.tram_id = t.id
left join public.profiles p on p.tram_id = t.id
group by t.id, t.ten_xa, t.ten_tram, t.created_at;
