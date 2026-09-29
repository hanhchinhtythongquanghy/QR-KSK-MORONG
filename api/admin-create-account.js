const { createAccount } = require("../lib/adminActions");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const body = req.body || {};
    const result = await createAccount({
      authHeader: req.headers.authorization,
      tram_id: body.tram_id,
      email: body.email,
      password: body.password,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};
