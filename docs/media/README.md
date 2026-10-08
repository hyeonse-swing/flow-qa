# Local demo screenshots

`flow-qa-demo.png` shows the English Scenario screen after loading the bundled to-do suite: three cases, three requirements, and no open questions. `flow-qa-report.png` shows the detailed report from a real Chromium run with all three cases passed and their recorded steps. Both are direct Playwright screenshots of the local UI; they are not composites or mock results.

Regenerate them from the repository root with Node.js 24, installed dependencies (`npm ci`), and Playwright Chromium:

```sh
flow-qa browser install
node scripts/capture-demo.mjs
```

The script creates a fresh temporary workspace and local demo app, blocks external model or service requests, and asserts the UI and saved JSON both report three passes. It also fails on browser page errors. The temporary workspace and servers are removed when the run ends. The example does not verify model quality or an external authenticated app.
