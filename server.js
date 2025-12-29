import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

function auth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization || "";
  if (header === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/seace/export", auth, async (req, res) => {
  const { departamento, objeto, anio } = req.body;

  if (!departamento || !objeto || !anio) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();

    // POR AHORA NO SCRAPEAMOS NADA
    // solo probamos que el runner funcione

    return res.json({
      run_id: new Date().toISOString(),
      items: [],
      meta: { departamento, objeto, anio }
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  } finally {
    await browser.close();
  }
});

app.listen(PORT, () => {
  console.log("SEACE Runner running on port", PORT);
});
