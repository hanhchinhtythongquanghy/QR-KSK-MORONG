const { createStation } = require("../lib/adminActions");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const body = req.body || {};
    const result = await createStation({
      authHeader: req.headers.authorization,
      ten_xa: body.ten_xa,
      ten_tram: body.ten_tram,
      danh_sach_nguoi_quet: body.danh_sach_nguoi_quet,
      email: body.email,
      password: body.password,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};
