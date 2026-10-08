# Local demo recording

`flow-qa-demo.mp4` (about 67 seconds), `flow-qa-demo.png`, and `flow-qa-demo.vtt` were made from the real English-default local UI and English to-do demo app with Playwright. Three cases ran in Chromium without a model. The recorder checks for three `passed` cases in both the UI report and saved JSON before producing the video. Near the end it switches the UI to Korean and back to English; the user's cases stay unchanged. Its bottom captions explain the recording; they are not part of the product UI. The poster is the actual 11-second video frame showing the English scenario title and three-case summary.

The video is attached to the [GitHub alpha release](https://github.com/hyeonse-swing/flow-qa/releases/tag/v0.1.0-alpha.1), not included in the Git source or npm package.

Reproduction requires Node.js 24, `npm ci`, installed Playwright Chromium, and a local FFmpeg binary. Run from the repository root:

```sh
FLOWQA_FFMPEG=/path/to/ffmpeg node scripts/record-demo.mjs
```

The script uses a temporary workspace and local ports, and blocks external model or service requests. It does not report a successful recording unless all three cases pass. Review the video and its visible data before sharing it.
