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
  let browser;

  try {
    browser = await chromium.launch({
      headless: true
    });

    const page = await browser.newPage();

    console.log(`[${run_id}] Navegando a SEACE...`);
    
    await page.goto(
      "https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml",
      { waitUntil: "networkidle", timeout: 60000 }
    );

    const { departamento, objeto, anio } = req.body;
    
    console.log(`[${run_id}] Filtros recibidos:`, { departamento, objeto, anio });

    // Esperar a que la página esté completamente cargada
    await page.waitForSelector('#tbBuscador\\:idFormBuscarProceso\\:departamento', { timeout: 10000 });

    // SETEAR DEPARTAMENTO
    if (departamento) {
      console.log(`[${run_id}] Seteando Departamento: ${departamento}`);
      
      // Click en el dropdown
      await page.click('#tbBuscador\\:idFormBuscarProceso\\:departamento');
      
      // Esperar a que el panel sea visible
      await page.waitForSelector('.ui-selectonemenu-panel:visible', { timeout: 5000 });
      
      // Esperar un poco para que el panel se renderice completamente
      await page.waitForTimeout(300);
      
      // Click en la opción usando un selector más robusto
      await page.click(`.ui-selectonemenu-panel:visible .ui-selectonemenu-item:has-text("${departamento}")`);
      
      await page.waitForTimeout(500);
      console.log(`[${run_id}] ✓ Departamento seteado`);
    }

    // SETEAR OBJETO
    if (objeto) {
      console.log(`[${run_id}] Seteando Objeto: ${objeto}`);
      
      await page.click('#tbBuscador\\:idFormBuscarProceso\\:j_idt217');
      await page.waitForSelector('.ui-selectonemenu-panel:visible', { timeout: 5000 });
      await page.waitForTimeout(300);
      
      // Normalizar el texto (SEACE usa "Obra" no "OBRA")
      const objetoNormalizado = objeto.charAt(0).toUpperCase() + objeto.slice(1).toLowerCase();
      
      await page.click(`.ui-selectonemenu-panel:visible .ui-selectonemenu-item:has-text("${objetoNormalizado}")`);
      await page.waitForTimeout(500);
      console.log(`[${run_id}] ✓ Objeto seteado`);
    }

    // SETEAR AÑO
    if (anio) {
      console.log(`[${run_id}] Seteando Año: ${anio}`);
      
      await page.click('#tbBuscador\\:idFormBuscarProceso\\:anioConvocatoria');
      await page.waitForSelector('.ui-selectonemenu-panel:visible', { timeout: 5000 });
      await page.waitForTimeout(300);
      
      await page.click(`.ui-selectonemenu-panel:visible .ui-selectonemenu-item:has-text("${anio}")`);
      await page.waitForTimeout(500);
      console.log(`[${run_id}] ✓ Año seteado`);
    }

    console.log(`[${run_id}] Ejecutando búsqueda...`);
    
    // Click en el botón de búsqueda (el token button que es visible)
    await page.click('#tbBuscador\\:idFormBuscarProceso\\:btnBuscarSelToken');
    
    // Esperar a que comience el request AJAX (el overlay de bloqueo aparece)
    await page.waitForTimeout(1000);
    
    // Esperar a que termine el AJAX (esperar a que desaparezca el blocker)
    await page.waitForSelector('.ui-blockui-content', { state: 'hidden', timeout: 30000 }).catch(() => {
      console.log(`[${run_id}] No se detectó blocker, continuando...`);
    });
    
    // Esperar un poco más para asegurar que la tabla se actualice
    await page.waitForTimeout(2000);

    // Esperar a que aparezcan filas en la tabla
    console.log(`[${run_id}] Esperando resultados en la tabla...`);
    
    await page.waitForFunction(
      () => {
        const tbody = document.querySelector('tbody[id="tbBuscador:idFormBuscarProceso:dtProcesos_data"]');
        if (!tbody) return false;
        
        const rows = tbody.querySelectorAll('tr');
        // Verificar que haya filas Y que no sea solo el mensaje de "No se encontraron Datos"
        return rows.length > 0 && !rows[0].classList.contains('ui-datatable-empty-message');
      },
      { timeout: 30000 }
    );

    console.log(`[${run_id}] Resultados encontrados. Scrapeando...`);

    // Extraer datos de la tabla
    const items = await page.evaluate(() => {
      const tbody = document.querySelector('tbody[id="tbBuscador:idFormBuscarProceso:dtProcesos_data"]');
      
      if (!tbody) {
        console.error('No se encontró el tbody');
        return [];
      }
      
      const rows = tbody.querySelectorAll('tr:not(.ui-datatable-empty-message)');
      console.log(`Filas encontradas: ${rows.length}`);
      
      const results = [];

      for (const row of rows) {
        const cols = row.querySelectorAll('td');
        
        if (cols.length < 7) {
          console.warn('Fila con menos de 7 columnas, saltando');
          continue;
        }

        try {
          const item = {
            numero: cols[0]?.innerText?.trim() || "",
            entidad: cols[1]?.innerText?.trim() || "",
            fecha_publicacion: cols[2]?.innerText?.trim() || "",
            nomenclatura: cols[3]?.innerText?.trim() || "",
            reiniciado_desde: cols[4]?.innerText?.trim() || "",
            objeto: cols[5]?.innerText?.trim() || "",
            descripcion: cols[6]?.innerText?.trim() || ""
          };
          
          results.push(item);
        } catch (err) {
          console.error('Error procesando fila:', err);
        }
      }

      return results;
    });

    console.log(`[${run_id}] Scraping completado. Items: ${items.length}`);

    await browser.close();

    return res.json({
      run_id,
      items,
      total: items.length,
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
    console.error(`[${run_id}] Error durante scraping:`, err.message);

    let screenshotPath = null;
    let htmlPath = null;

    try {
      await fs.promises.mkdir("debug", { recursive: true });

      screenshotPath = `debug/${run_id}.png`;
      htmlPath = `debug/${run_id}.html`;

      if (browser) {
        const pages = browser.contexts()[0]?.pages() || [];
        const page = pages[0];
        
        if (page && !page.isClosed()) {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.log(`[${run_id}] Screenshot guardado: ${screenshotPath}`);
          
          const html = await page.content();
          await fs.promises.writeFile(htmlPath, html, "utf8");
          console.log(`[${run_id}] HTML guardado: ${htmlPath}`);
        }
      }
    } catch (dbgErr) {
      console.error(`[${run_id}] Error capturando debug:`, dbgErr.message);
    }

    if (browser) {
      await browser.close();
    }

    return res.status(500).json({
      run_id,
      error: err.message,
      stack: err.stack,
      debug: {
        screenshot: screenshotPath,
        html: htmlPath,
        message: "Revisa los archivos en debug/ para diagnosticar"
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`SEACE Runner running on port ${PORT}`);
});