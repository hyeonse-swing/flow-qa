# Third-party components and fonts

Flow QA uses [tester-army/e2e](https://github.com/tester-army/e2e), `@e2e-dev/web` for browser tests, and `@e2e-dev/mobile` for native iOS and Android tests. Those packages are licensed under Apache-2.0 and retain their upstream LICENSE and NOTICE files in their installed distributions. The mobile engine uses [agent-device](https://github.com/callstack/agent-device), licensed under MIT. Flow QA adds the flow specification, schema validation, orchestration, report interpretation, and local UI; it does not claim authorship of the execution engines.

Flow QA uses `@hyeonse/design-system` version 0.4.8 from the [Hyeonse Design System release archive](https://design-system.hyeonse.dev/releases/hyeonse-design-system-0.4.8.tgz) during development and packaging. The Flow QA npm tarball includes copies of its `tokens.css`, `components.css`, and `preferences.js` files alongside its MIT `LICENSE`; it does not include the design-system package or its other dependencies. Installed consumers do not need Git or the design-system source archive. Source checkout installation fetches the versioned public archive over HTTPS.

The local DM Sans and Noto Sans KR font files were copied from that repository's `docs/assets/fonts/` at commit `38978c6a86f422fc0e63e919f600bc2dd3451e5c`. Their licenses are preserved in [DM Sans license](licenses/DM-Sans-LICENSE.txt) and [Noto Sans KR license](licenses/Noto-Sans-KR-LICENSE.txt).

The Korean font is a subset and does not cover every Korean character. The UI falls back to installed Korean/system fonts for missing glyphs. No external font service is contacted.
