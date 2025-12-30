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
    // 1️⃣ NAVEGACIÓN INICIAL
    // Ir a la página de búsqueda pública de SEACE
    await page.goto(
      "https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );

    console.log(`[${run_id}] Página cargada. Extrayendo filtros de req.body...`);

    // 2️⃣ MAPEO DE VALORES DESDE req.body
    // Los valores llegan como texto (ej: "LA LIBERTAD", "OBRA", "2025")
    // pero SEACE espera values numéricos o exactos del dropdown
    
    const { departamento, objeto, anio } = req.body;
    
    // Mapeo de departamentos (texto → value)
    const departamentos = {
      "LA LIBERTAD": "14",
      "LIMA": "15",
      "AREQUIPA": "4",
      // ... otros valores según necesidad
    };

    // Mapeo de objetos (texto → value)
    // Nota: En SEACE el texto es "Obra" (no "OBRA")
    const objetos = {
      "OBRA": "64",
      "Obra": "64",
      "BIEN": "63",
      "Bien": "63",
      "SERVICIO": "65",
      "Servicio": "65",
      // ... otros valores
    };

    // Año generalmente se mapea directamente
    const anioValue = String(anio);

    console.log(`[${run_id}] Filtros a aplicar:
      - Departamento: ${departamento} (value: ${departamentos[departamento]})
      - Objeto: ${objeto} (value: ${objetos[objeto]})
      - Año: ${anioValue}`);

    // 3️⃣ SETEAR FILTROS EN LA UI
    // Los selectores PrimeFaces tienen un <select> oculto (_input)
    // que Playwright SÍ puede manipular con selectOption()

    if (departamentos[departamento]) {
      console.log(`[${run_id}] Seteando Departamento...`);
      await page.selectOption(
        '#tbBuscador\\:idFormBuscarProceso\\:departamento_input',
        departamentos[departamento]
      );
      // Pequeña pausa para que PrimeFaces actualice el label
      await page.waitForTimeout(300);
    }

    if (objetos[objeto]) {
      console.log(`[${run_id}] Seteando Objeto de Contratación...`);
      await page.selectOption(
        '#tbBuscador\\:idFormBuscarProceso\\:j_idt217_input',
        objetos[objeto]
      );
      await page.waitForTimeout(300);
    }

    if (anioValue) {
      console.log(`[${run_id}] Seteando Año de Convocatoria...`);
      await page.selectOption(
        '#tbBuscador\\:idFormBuscarProceso\\:anioConvocatoria_input',
        anioValue
      );
      await page.waitForTimeout(300);
    }

    // 4️⃣ EJECUTAR BÚSQUEDA
    // Ahora que los filtros están seteados, hacer click en "Buscar"
    console.log(`[${run_id}] Ejecutando búsqueda...`);
    await page.click("text=Buscar");

    // 5️⃣ ESPERAR A QUE APAREZCAN FILAS REALES
    // Usar waitForFunction para detectar filas por conteo, no por visibilidad
    // (evita el timeout con elementos "hidden")
    console.log(`[${run_id}] Esperando resultados...`);
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_data tr"
      );
      // Retornar true cuando haya al menos 1 fila
      return rows.length > 0;
    }, { timeout: 60000 });

    console.log(`[${run_id}] Resultados encontrados. Scrapeando...`);

    // 6️⃣ SCRAPEAR DATOS DE LA TABLA
    const items = await page.evaluate(() => {
      const rows = document.querySelectorAll(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_data tr"
      );

      const results = [];

      for (const row of rows) {
        const cols = row.querySelectorAll("td");
        
        // Validar que la fila tenga suficientes columnas
        if (cols.length < 7) continue;

        // Extraer datos según posición de columnas
        // Ajustar índices según estructura real de SEACE
        results.push({
          entidad: cols[1]?.innerText.trim() || "",
          descripcion: cols[6]?.innerText.trim() || "",
          nomenclatura: cols[3]?.innerText.trim() || ""
        });
      }

      return results;
    });

    console.log(`[${run_id}] Scraping completado. Items encontrados: ${items.length}`);

    // 7️⃣ CERRAR NAVEGADOR Y RESPONDER
    await browser.close();

    return res.json({
      run_id,
      items,
      meta: {
        fuente: "SEACE",
        scraped_at: run_id,
        filtros_aplicados: {
          departamento,
          objeto,
          anio
        }
      }
    });

  } catch (err) {
    // 8️⃣ MANEJO DE ERRORES CON DEBUG
    console.error(`[${run_id}] Error durante scraping:`, err.message);

    let screenshotPath = null;
    let htmlPath = null;

    try {
      // Crear directorio debug si no existe
      await fs.promises.mkdir("debug", { recursive: true });

      screenshotPath = `debug/${run_id}.png`;
      htmlPath = `debug/${run_id}.html`;

      // Capturar screenshot de la página (para inspeccionar visualmente)
      if (page && !page.isClosed && typeof page.screenshot === "function") {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[${run_id}] Screenshot guardado en: ${screenshotPath}`);
      }

      // Capturar HTML completo (para inspeccionar estructura)
      if (page && typeof page.content === "function") {
        const html = await page.content();
        await fs.promises.writeFile(htmlPath, html, "utf8");
        console.log(`[${run_id}] HTML guardado en: ${htmlPath}`);
      }
    } catch (dbgErr) {
      // Si falla la captura de debug, no sobreescribir el error original
      console.error(`[${run_id}] Fallo al capturar debug:`, String(dbgErr));
    }

    await browser.close();

    // Responder con error y rutas de debug
    return res.status(500).json({
      run_id,
      error: String(err),
      debug: {
        screenshot: screenshotPath,
        html: htmlPath,
        message: "Revisa los archivos en debug/ para diagnosticar"
      }
    });
  }
});

app.listen(PORT, () => {
  console.log("SEACE Runner running on port", PORT);
});
