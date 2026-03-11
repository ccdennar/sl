const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");
const XLSX = require("xlsx");

// Configuration
const CONFIG = {
  url: "https://fdp.slb.com/apps/jobmanagement/#/dashboard/ops-activity",
  outputDir: path.join(__dirname, "data"),
  screenshotDir: path.join(__dirname, "screenshots"),
  sessionDir: path.join(__dirname, "slb_session"),
  timeout: 120000,        // Increased for slow enterprise apps
  navigationTimeout: 60000,
  maxRetries: 3,
  retryDelay: 5000,
};

// Ensure directories exist
async function ensureDirs() {
  for (const dir of [CONFIG.outputDir, CONFIG.screenshotDir]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Logging
function log(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  console.log(JSON.stringify(entry, null, 2));
}

// Try multiple selectors to find data
async function findDataContainer(page) {
  const selectors = [
    // Traditional tables
    { rows: "table tbody tr", cells: "td", type: "table" },
    { rows: "table tr", cells: "td", type: "table" },
    
    // AG Grid (common in enterprise)
    { rows: ".ag-center-cols-container .ag-row", cells: ".ag-cell", type: "ag-grid" },
    { rows: "[role='row'].ag-row", cells: "[role='gridcell']", type: "ag-grid" },
    
    // Material-UI
    { rows: ".MuiDataGrid-row", cells: ".MuiDataGrid-cell", type: "mui" },
    
    // React Data Table
    { rows: ".rdt_TableRow", cells: ".rdt_TableCell", type: "rdt" },
    
    // Generic ARIA
    { rows: "[role='row']", cells: "[role='gridcell']", type: "aria" },
    { rows: "[role='row']", cells: "td", type: "aria-mixed" },
    
    // DevExpress
    { rows: ".dx-data-row", cells: "td", type: "devexpress" },
    
    // Common CSS patterns
    { rows: ".data-row", cells: ".data-cell", type: "css-pattern" },
    { rows: "[class*='row']", cells: "[class*='cell']", type: "css-fuzzy" },
  ];

  for (const selector of selectors) {
    try {
      const count = await page.locator(selector.rows).count();
      if (count > 0) {
        log("info", `Found data container`, { type: selector.type, rows: count });
        return selector;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Extract headers
async function extractHeaders(page, cellSelector) {
  const headerSelectors = [
    "table thead th",
    ".ag-header-cell-text",
    ".MuiDataGrid-columnHeaderTitle",
    "[role='columnheader']",
    ".rdt_TableHead .rdt_TableCol",
    "th"
  ];

  for (const selector of headerSelectors) {
    try {
      const headers = await page.$$eval(selector, (ths) =>
        ths.map((th) => th.innerText?.trim() || th.textContent?.trim() || "")
      );
      if (headers.length > 0 && headers.some(h => h.length > 0)) {
        return headers;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Main scrape function
async function scrapeWithRetry(retryCount = 0) {
  let context;
  let browserLaunched = false;
  
  try {
    log("info", "Launching browser", { attempt: retryCount + 1 });
    
    context = await chromium.launchPersistentContext(CONFIG.sessionDir, {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920,1080"
      ],
      viewport: { width: 1920, height: 1080 },
    });
    browserLaunched = true;

    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeout);
    page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

    // Enable console logging from page
    page.on('console', msg => {
      if (msg.type() === 'error') {
        log("warn", "Page console error", { text: msg.text() });
      }
    });

    log("info", "Navigating to URL");
    
    const response = await page.goto(CONFIG.url, {
      waitUntil: "domcontentloaded",  // Faster than networkidle
      timeout: CONFIG.navigationTimeout,
    });

    log("info", "Page loaded", { 
      status: response?.status(), 
      url: page.url() 
    });

    // Check for login redirect
    if (page.url().includes('login') || page.url().includes('auth')) {
      throw new Error("Authentication required - page redirected to login");
    }

    // Wait for app to hydrate (React/Angular boot time)
    log("info", "Waiting for app to hydrate...");
    await page.waitForTimeout(5000);

    // Wait for network to settle (SPA data fetching)
    try {
      await page.waitForLoadState("networkidle", { timeout: 30000 });
    } catch (e) {
      log("warn", "Network idle timeout, continuing anyway");
    }

    // Find the data container
    log("info", "Searching for data container...");
    const container = await findDataContainer(page);
    
    if (!container) {
      // Save debug screenshot
      await page.screenshot({ 
        path: path.join(CONFIG.screenshotDir, `no_container_${Date.now()}.png`),
        fullPage: true 
      });
      throw new Error("No data container found - check selectors");
    }

    // Wait for rows to populate
    await page.waitForSelector(container.rows, { timeout: CONFIG.timeout });
    
    // Ensure data is loaded (not just empty rows)
    await page.waitForFunction((rowSelector) => {
      const rows = document.querySelectorAll(rowSelector);
      if (rows.length === 0) return false;
      // Check if first row has text content
      const firstRow = rows[0];
      return firstRow.innerText?.trim().length > 0;
    }, container.rows, { timeout: CONFIG.timeout });

    log("info", "Extracting data", { type: container.type });

    // Get headers
    const headers = await extractHeaders(page, container.cells);
    log("info", "Headers found", { headers: headers?.length || 0 });

    // Extract row data
    const data = await page.$$eval(
      container.rows,
      (rows, cellSelector) => {
        return rows.map(row => {
          const cells = row.querySelectorAll(cellSelector);
          return Array.from(cells).map(cell => {
            // Try multiple ways to get text
            return cell.innerText?.trim() || 
                   cell.textContent?.trim() || 
                   cell.getAttribute('title') || 
                   cell.getAttribute('aria-label') || 
                   "";
          }).filter(text => text.length > 0);
        }).filter(row => row.length > 0);
      },
      container.cells
    );

    if (data.length === 0) {
      throw new Error("No data extracted - rows may be empty");
    }

    log("info", "Data extracted", { rows: data.length, sample: data[0] });

    // Create Excel file
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `slb_data_${timestamp}.xlsx`;
    const tempPath = path.join(CONFIG.outputDir, `.tmp_${filename}`);
    const finalPath = path.join(CONFIG.outputDir, filename);

    // Prepare worksheet data
    const worksheetData = headers ? [headers, ...data] : data;

    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(worksheetData);

    // Auto-size columns
    const colWidths = worksheetData[0].map((_, colIndex) => {
      const maxLength = Math.max(
        ...worksheetData.map(row => String(row[colIndex] || '').length)
      );
      return { wch: Math.min(maxLength + 2, 60) };
    });
    ws['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws, "Operations Data");
    XLSX.writeFile(wb, tempPath);
    
    // Atomic rename
    await fs.rename(tempPath, finalPath);

    log("info", "Excel file created", { 
      path: finalPath,
      rows: data.length,
      columns: data[0]?.length || 0
    });

    await context.close();
    
    return { 
      success: true, 
      file: finalPath, 
      rows: data.length,
      type: container.type 
    };

  } catch (error) {
    log("error", "Scrape failed", { 
      error: error.message,
      attempt: retryCount + 1,
      browserLaunched
    });

    // Capture error screenshot
    if (context) {
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          const screenshotPath = path.join(
            CONFIG.screenshotDir,
            `error_${Date.now()}.png`
          );
          await pages[0].screenshot({ path: screenshotPath, fullPage: true });
          log("info", "Error screenshot saved", { path: screenshotPath });
        }
        await context.close().catch(() => {});
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Retry logic
    if (retryCount < CONFIG.maxRetries - 1) {
      log("info", "Retrying...", { delayMs: CONFIG.retryDelay });
      await new Promise(r => setTimeout(r, CONFIG.retryDelay));
      return scrapeWithRetry(retryCount + 1);
    }

    throw error;
  }
}

// Main execution
(async () => {
  try {
    await ensureDirs();
    console.log("🚀 Starting SLB scraper...");
    console.log("Output directory:", path.resolve(CONFIG.outputDir));
    
    const result = await scrapeWithRetry();
    
    console.log("\n✅ SUCCESS!");
    console.log("File saved to:", result.file);
    console.log("Rows extracted:", result.rows);
    console.log("Table type detected:", result.type);
    
    process.exit(0);
  } catch (error) {
    console.error("\n❌ FAILED:", error.message);
    console.error("Check screenshots/ folder for debug images");
    process.exit(1);
  }
})();