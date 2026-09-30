// GET /api/config
// Trả về URL + anon key của Supabase, lấy từ biến môi trường trên Vercel
// (Project Settings > Environment Variables). Anon key vốn được thiết kế
// để lộ ra trình duyệt (bảo vệ dữ liệu là do RLS), nên trả về đây là an toàn.
const { getPlan } = require("../lib/plan");

module.exports = async (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({
      error: "Thiếu biến môi trường SUPABASE_URL / SUPABASE_ANON_KEY trên máy chủ.",
    });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ supabaseUrl, supabaseAnonKey, plan: getPlan() });
};
