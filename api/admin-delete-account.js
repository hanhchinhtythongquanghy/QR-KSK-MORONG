const { deleteAccount } = require("../lib/adminActions");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const body = req.body || {};
    const result = await deleteAccount({
      authHeader: req.headers.authorization,
      user_id: body.user_id,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};
