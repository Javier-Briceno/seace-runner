import express from "express";
import { chromium } from "playwright";
import fs from "fs";

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

app.get("/test-outbound", async (req, res) => {
  try {
    const r = await fetch("https://www.google.com");
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/seace/export", async (req, res) => {
  const run_id = new Date().toISOString();

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  try {
    await page.goto(
      "https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );

    // ⚠️ IMPORTANTE:
    // aquí asumo que los filtros ya están aplicados
    // (por ahora scraping MVP)

    // Ejecutar búsqueda
    await page.click("text=Buscar");

    // Esperar a que aparezcan filas reales
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_data tr"
      );
      return rows.length > 0;
    }, { timeout: 60000 });

    // Scrapear
    const items = await page.evaluate(() => {
      const rows = document.querySelectorAll(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_data tr"
      );

      const results = [];

      for (const row of rows) {
        const cols = row.querySelectorAll("td");
        if (cols.length < 7) continue;

        results.push({
          entidad: cols[1]?.innerText.trim(),
          descripcion: cols[6]?.innerText.trim(),
          nomenclatura: cols[3]?.innerText.trim()
        });
      }

      return results;
    });

    await browser.close();

    return res.json({
      run_id,
      items,
      meta: {
        fuente: "SEACE",
        scraped_at: run_id
      }
    });
  } catch (err) {
    let screenshotPath = null;
    let htmlPath = null;
    try {
      await fs.promises.mkdir("debug", { recursive: true });
      screenshotPath = `debug/${run_id}.png`;
      htmlPath = `debug/${run_id}.html`;
      if (page && !page.isClosed && typeof page.screenshot === "function") {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      if (page && typeof page.content === "function") {
        const html = await page.content();
        await fs.promises.writeFile(htmlPath, html, "utf8");
      }
    } catch (dbgErr) {
      // best-effort debug capture; don't override original error
      console.error("debug capture failed:", String(dbgErr));
    }

    await browser.close();
    return res.status(500).json({
      run_id,
      error: String(err),
      debug: { screenshot: screenshotPath, html: htmlPath }
    });
  }
});

app.listen(PORT, () => {
  console.log("SEACE Runner running on port", PORT);
});
