# 1. Install dependencies
npm init -y
npm install playwright
npx playwright install chromium

# 2. Run setup (as Administrator)
.\setup-task.ps1

# 3. Test manually first
node scraper.js

# 4. Check Task Scheduler
taskschd.msc