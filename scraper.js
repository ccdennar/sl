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
  timeout: 60000,
  maxRetries: 3,
  retryDelay: 5000,
};

// Ensure directories exist
async function ensureDirs() {
  for (const dir of [CONFIG.outputDir, CONFIG.screenshotDir]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Structured logging
function log(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  console.log(JSON.stringify(entry));
}

// Extract headers from the table
async function extractHeaders(page) {
  try {
    const headers = await page.$$eval("table thead th", (ths) =>
      ths.map((th) => th.innerText.trim())
    );
    return headers.length > 0 ? headers : null;
  } catch {
    return null;
  }
}

async function scrapeWithRetry(retryCount = 0) {
  let context;
  
  try {
    log("info", "Launching browser", { attempt: retryCount + 1 });
    
    context = await chromium.launchPersistentContext(CONFIG.sessionDir, {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeout);

    log("info", "Navigating to target URL");
    
    const response = await page.goto(CONFIG.url, {
      waitUntil: "networkidle",
      timeout: CONFIG.timeout,
    });

    if (!response || !response.ok()) {
      throw new Error(`HTTP ${response?.status() || 'no response'}`);
    }

    log("info", "Waiting for table data");
    
    await page.waitForSelector("table tbody tr", { timeout: CONFIG.timeout });
    
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll("table tbody tr");
      return rows.length > 0 && rows[0].querySelector("td")?.innerText?.trim() !== "";
    }, { timeout: CONFIG.timeout });

    log("info", "Extracting data");
    
    // Try to get headers first
    const headers = await extractHeaders(page);
    
    // Extract table data
    const data = await page.$$eval("table tbody tr", (rows) =>
      rows.map((row) =>
        Array.from(row.querySelectorAll("td")).map((cell) => 
          cell.innerText.trim()
        )
      ).filter((row) => row.some(cell => cell.length > 0))
    );

    if (data.length === 0) {
      throw new Error("No data extracted - table may be empty");
    }

    // Create Excel workbook
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `data_${timestamp}.xlsx`;
    const tempPath = path.join(CONFIG.outputDir, `.tmp_${filename}`);
    const finalPath = path.join(CONFIG.outputDir, filename);

    // Prepare worksheet data
    const worksheetData = headers ? [headers, ...data] : data;
    
    // Create workbook and worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(worksheetData);
    
    // Auto-adjust column widths
    const colWidths = worksheetData[0].map((_, colIndex) => {
      const maxLength = Math.max(
        ...worksheetData.map(row => String(row[colIndex] || '').length)
      );
      return { wch: Math.min(maxLength + 2, 50) }; // Cap at 50 chars
    });
    ws['!cols'] = colWidths;

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, "Scraped Data");
    
    // Write to temp file first (atomic write)
    XLSX.writeFile(wb, tempPath);
    await fs.rename(tempPath, finalPath);

    log("info", "Scrape successful", { 
      rows: data.length, 
      columns: headers?.length || data[0]?.length,
      file: filename,
      path: finalPath
    });

    await page.close();
    await context.close();
    
    return { success: true, rows: data.length, file: finalPath };

  } catch (error) {
    log("error", "Scrape failed", { 
      error: error.message, 
      stack: error.stack,
      attempt: retryCount + 1 
    });

    if (context) {
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          const screenshotPath = path.join(
            CONFIG.screenshotDir,
            `error_${Date.now()}.png`
          );
          await pages[0].screenshot({ path: screenshotPath, fullPage: true });
          log("info", "Screenshot saved", { path: screenshotPath });
        }
        await context.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }

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
    const result = await scrapeWithRetry();
    log("info", "Process completed", { file: result.file });
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    log("fatal", "Scrape failed permanently", { error: error.message });
    process.exit(1);
  }
})();