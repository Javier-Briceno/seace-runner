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

    // Esperar a que la página cargue completamente
    await page.waitForSelector('.ui-tabs', { timeout: 15000 });
    await page.waitForTimeout(2000);
    
    console.log(`[${run_id}] Activando tab de búsqueda...`);
    
    // Forzar la activación del tab usando JavaScript directo
    await page.evaluate(() => {
      // Encontrar el tab correcto (índice 1)
      const tabLinks = document.querySelectorAll('.ui-tabs-nav li');
      const tabPanels = document.querySelectorAll('.ui-tabs-panel');
      
      // Desactivar todos los tabs
      tabLinks.forEach((tab) => {
        tab.classList.remove('ui-tabs-selected', 'ui-state-active', 'ui-state-focus');
        tab.setAttribute('aria-expanded', 'false');
      });
      
      // Ocultar todos los paneles
      tabPanels.forEach((panel) => {
        panel.style.display = 'none';
        panel.classList.add('ui-helper-hidden');
        panel.setAttribute('aria-hidden', 'true');
      });
      
      // Activar el tab deseado (índice 1 = "Buscador de Procedimientos de Selección")
      if (tabLinks[1]) {
        tabLinks[1].classList.add('ui-tabs-selected', 'ui-state-active');
        tabLinks[1].setAttribute('aria-expanded', 'true');
      }
      
      // Mostrar el panel correspondiente
      if (tabPanels[1]) {
        tabPanels[1].style.display = 'block';
        tabPanels[1].classList.remove('ui-helper-hidden');
        tabPanels[1].setAttribute('aria-hidden', 'false');
      }
      
      // Actualizar el activeIndex del componente de tabs
      const hiddenInput = document.querySelector('#tbBuscador_activeIndex');
      if (hiddenInput) {
        hiddenInput.value = '1';
      }
    });
    
    await page.waitForTimeout(1500);
    
    // Esperar a que el formulario tenga tamaño real (esté completamente renderizado)
    console.log(`[${run_id}] Esperando a que el formulario se renderice...`);
    
    // Just wait a fixed amount of time after activating the tab
    console.log(`[${run_id}] Tab activado, esperando renderizado del formulario...`);
    await page.waitForTimeout(3000);

    console.log(`[${run_id}] Formulario listo, procediendo con los filtros...`);
    
    // Verificar que el formulario esté visible
    const formCheck = await page.evaluate(() => {
      const dept = document.querySelector('#tbBuscador\\:idFormBuscarProceso\\:departamento');
      if (!dept) return { exists: false, visible: false };
      
      const rect = dept.getBoundingClientRect();
      const style = window.getComputedStyle(dept);
      const parentPanel = dept.closest('.ui-tabs-panel');
      
      return {
        exists: true,
        visible: style.display !== 'none' && style.visibility !== 'hidden',
        hasSize: rect.width > 0 && rect.height > 0,
        panelVisible: parentPanel ? parentPanel.style.display !== 'none' : false,
        panelId: parentPanel ? parentPanel.id : 'no panel'
      };
    });
    
    console.log(`[${run_id}] Estado del formulario:`, formCheck);

    // Expandir "Búsqueda Avanzada" para acceder al campo Departamento
    console.log(`[${run_id}] Expandiendo Búsqueda Avanzada...`);
    await page.click('.ui-fieldset-legend:has-text("Búsqueda Avanzada")');
    await page.waitForTimeout(1000);
    console.log(`[${run_id}] ✓ Búsqueda Avanzada expandida`);

    // SETEAR DEPARTAMENTO
    if (departamento) {
      console.log(`[${run_id}] Seteando Departamento: ${departamento}`);
      
      // Encontrar el dropdown de Departamento de manera más robusta
      const deptSelector = await page.evaluate(() => {
        // Buscar por el label "Departamento" en la sección de búsqueda avanzada
        const labels = Array.from(document.querySelectorAll('#tbBuscador\\:idFormBuscarProceso\\:pnlFiltro2 label, #tbBuscador\\:idFormBuscarProceso\\:pnlFiltro2 span'));
        const deptLabel = labels.find(l => l.textContent.trim() === 'Departamento');
        
        if (deptLabel) {
          const cell = deptLabel.closest('td');
          if (cell) {
            const nextCell = cell.nextElementSibling;
            if (nextCell) {
              const select = nextCell.querySelector('.ui-selectonemenu');
              if (select) {
                return '#' + select.id.replace(/:/g, '\\:');
              }
            }
          }
        }
        
        // Fallback: buscar directamente por ID conocido
        const dept = document.querySelector('#tbBuscador\\:idFormBuscarProceso\\:departamento');
        return dept ? '#tbBuscador\\:idFormBuscarProceso\\:departamento' : null;
      });
      
      if (!deptSelector) {
        throw new Error('No se pudo encontrar el selector de Departamento');
      }
      
      console.log(`[${run_id}] Usando selector de departamento: ${deptSelector}`);
      
      // Click en el dropdown
      await page.click(deptSelector);
      
      // Esperar a que el panel del departamento sea visible
      await page.waitForFunction(() => {
        const panels = document.querySelectorAll('.ui-selectonemenu-panel');
        for (const panel of panels) {
          const style = window.getComputedStyle(panel);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            // Verificar que este panel contiene el departamento
            const items = panel.querySelectorAll('.ui-selectonemenu-item');
            return items.length > 0;
          }
        }
        return false;
      }, { timeout: 5000 });
      
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
      
      // Encontrar el dropdown de Objeto de Contratación de manera más robusta
      const objetoSelector = await page.evaluate(() => {
        // Buscar todos los selectonemenu en el formulario
        const selects = document.querySelectorAll('#tbBuscador\\:idFormBuscarProceso\\:pnlFiltro .ui-selectonemenu');
        
        // El segundo selectonemenu en pnlFiltro es "Objeto de Contratación"
        // (el primero es Tipo de Selección, el segundo es Objeto)
        if (selects.length >= 2) {
          const id = selects[1].id;
          // Escapar los ':' en el ID
          return '#' + id.replace(/:/g, '\\:');
        }
        
        return null;
      });
      
      if (!objetoSelector) {
        throw new Error('No se pudo encontrar el selector de Objeto de Contratación');
      }
      
      console.log(`[${run_id}] Usando selector: ${objetoSelector}`);
      
      await page.click(objetoSelector);
      
      // Esperar a que el panel del objeto sea visible
      await page.waitForFunction(() => {
        const panels = document.querySelectorAll('.ui-selectonemenu-panel');
        for (const panel of panels) {
          const style = window.getComputedStyle(panel);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const items = panel.querySelectorAll('.ui-selectonemenu-item');
            return items.length > 0;
          }
        }
        return false;
      }, { timeout: 5000 });
      
      await page.waitForTimeout(300);
      
      // Normalizar el texto (SEACE usa "Obra" no "OBRA")
      const objetoNormalizado = objeto.charAt(0).toUpperCase() + objeto.slice(1).toLowerCase();
      
      // Usar selector más específico para evitar capturar "Consultoria de Obra"
      await page.evaluate((texto) => {
        // Buscar el panel visible (sin usar :visible que no es CSS estándar)
        const panels = document.querySelectorAll('.ui-selectonemenu-panel');
        let visiblePanel = null;
        
        for (const panel of panels) {
          const style = window.getComputedStyle(panel);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            visiblePanel = panel;
            break;
          }
        }
        
        if (!visiblePanel) {
          console.error('No se encontró panel visible');
          return;
        }
        
        // Buscar el item exacto en el panel visible
        const items = visiblePanel.querySelectorAll('.ui-selectonemenu-item');
        for (const item of items) {
          if (item.innerText.trim() === texto) {
            item.click();
            return;
          }
        }
        
        console.error(`No se encontró item con texto: ${texto}`);
      }, objetoNormalizado);
      
      await page.waitForTimeout(500);
      console.log(`[${run_id}] ✓ Objeto seteado`);
    }

    // SETEAR AÑO
    if (anio) {
      console.log(`[${run_id}] Seteando Año: ${anio}`);
      
      // Encontrar el dropdown de Año de manera más robusta
      const anioSelector = await page.evaluate(() => {
        // El campo de año está en pnlFiltro (sección superior, no avanzada)
        // Buscar todos los selectonemenu en pnlFiltro
        const selects = document.querySelectorAll('#tbBuscador\\:idFormBuscarProceso\\:pnlFiltro .ui-selectonemenu');
        
        console.log(`Selectonemenu encontrados en pnlFiltro: ${selects.length}`);
        
        // Buscar por el label "Año de la Convocatoria" para identificar cuál es
        for (let i = 0; i < selects.length; i++) {
          const select = selects[i];
          const label = select.closest('td')?.previousElementSibling?.textContent || '';
          const label2 = select.closest('tr')?.querySelector('label')?.textContent || '';
          
          if (label.includes('Año') || label2.includes('Año')) {
            console.log(`Encontrado Año en índice ${i}:`, select.id);
            const id = select.id;
            return '#' + id.replace(/:/g, '\\:');
          }
        }
        
        // Fallback: buscar por label específico
        const labels = Array.from(document.querySelectorAll('#tbBuscador\\:idFormBuscarProceso\\:pnlFiltro label, #tbBuscador\\:idFormBuscarProceso\\:pnlFiltro span'));
        const anioLabel = labels.find(l => l.textContent.includes('Año'));
        
        if (anioLabel) {
          const select = anioLabel.closest('tr')?.querySelector('.ui-selectonemenu') || 
                        anioLabel.closest('td')?.nextElementSibling?.querySelector('.ui-selectonemenu');
          if (select) {
            console.log(`Encontrado por label:`, select.id);
            return '#' + select.id.replace(/:/g, '\\:');
          }
        }
        
        console.log('No se pudo encontrar el selector de Año');
        return null;
      });
      
      if (!anioSelector) {
        throw new Error('No se pudo encontrar el selector de Año');
      }
      
      console.log(`[${run_id}] Usando selector de año: ${anioSelector}`);
      
      await page.click(anioSelector);
      
      // Esperar a que el panel del año sea visible
      await page.waitForFunction(() => {
        const panels = document.querySelectorAll('.ui-selectonemenu-panel');
        for (const panel of panels) {
          const style = window.getComputedStyle(panel);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const items = panel.querySelectorAll('.ui-selectonemenu-item');
            return items.length > 0;
          }
        }
        return false;
      }, { timeout: 5000 });
      
      await page.waitForTimeout(300);
      
      await page.click(`.ui-selectonemenu-panel .ui-selectonemenu-item:has-text("${anio}")`);
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

    // Extraer datos de todas las páginas
    let allItems = [];
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      console.log(`[${run_id}] Scrapeando página ${currentPage}...`);

      // Extraer datos de la página actual
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

      console.log(`[${run_id}] Página ${currentPage}: ${items.length} items encontrados`);
      allItems = allItems.concat(items);

      // Verificar si hay botón "siguiente" habilitado
      const nextButtonDisabled = await page.evaluate(() => {
        const nextButton = document.querySelector('#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_paginator_bottom .ui-paginator-next');
        return nextButton ? nextButton.classList.contains('ui-state-disabled') : true;
      });

      if (nextButtonDisabled) {
        console.log(`[${run_id}] No hay más páginas. Total de páginas procesadas: ${currentPage}`);
        hasMorePages = false;
      } else {
        // Click en el botón siguiente
        console.log(`[${run_id}] Avanzando a la página ${currentPage + 1}...`);
        await page.click('#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_paginator_bottom .ui-paginator-next');
        
        // Esperar a que la tabla se actualice
        await page.waitForTimeout(1500);
        
        // Esperar a que aparezcan las nuevas filas
        await page.waitForFunction(
          () => {
            const tbody = document.querySelector('tbody[id="tbBuscador:idFormBuscarProceso:dtProcesos_data"]');
            if (!tbody) return false;
            const rows = tbody.querySelectorAll('tr:not(.ui-datatable-empty-message)');
            return rows.length > 0;
          },
          { timeout: 10000 }
        );
        
        currentPage++;
      }
    }

    console.log(`[${run_id}] Scraping completado. Total de items: ${allItems.length}`);

    await browser.close();

    return res.json({
      run_id,
      items: allItems,
      total: allItems.length,
      meta: {
        fuente: "SEACE",
        scraped_at: run_id,
        paginas_procesadas: currentPage,
        filtros_aplicados: {
          departamento,
          objeto,
          anio
        }
      }
    });

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
      // Asegurar que la carpeta debug existe
      if (!fs.existsSync("debug")) {
        fs.mkdirSync("debug", { recursive: true });
      }

      screenshotPath = `debug/${run_id.replace(/:/g, '-')}.png`;
      htmlPath = `debug/${run_id.replace(/:/g, '-')}.html`;

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