const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");

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

async function scrapeWithRetry(retryCount = 0) {
  let context;
  
  try {
    log("info", "Launching browser", { attempt: retryCount + 1 });
    
    context = await chromium.launchPersistentContext(CONFIG.sessionDir, {
      headless: true, // Set to false only for debugging
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await context.newPage();
    
    // Set default timeout
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
    
    // Wait for specific table to be present and not empty
    await page.waitForSelector("table tbody tr", { timeout: CONFIG.timeout });
    
    // Additional wait for dynamic data to populate
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll("table tbody tr");
      return rows.length > 0 && rows[0].querySelector("td")?.innerText?.trim() !== "";
    }, { timeout: CONFIG.timeout });

    log("info", "Extracting data");
    
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

    // Atomic write: write to temp file, then rename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `data_${timestamp}.json`;
    const tempPath = path.join(CONFIG.outputDir, `.tmp_${filename}`);
    const finalPath = path.join(CONFIG.outputDir, filename);

    await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fs.rename(tempPath, finalPath); // Atomic operation

    log("info", "Scrape successful", { 
      rows: data.length, 
      file: filename,
      bytes: JSON.stringify(data).length 
    });

    await page.close();
    await context.close();
    
    return { success: true, rows: data.length };

  } catch (error) {
    log("error", "Scrape failed", { 
      error: error.message, 
      stack: error.stack,
      attempt: retryCount + 1 
    });

    // Capture screenshot for debugging
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
    const result = await scrapeWithRetry();
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    log("fatal", "Scrape failed permanently", { error: error.message });
    process.exit(1);
  }
})();