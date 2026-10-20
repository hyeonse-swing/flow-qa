# User-configured iOS and Android targets

Mobile targets require Flow QA `0.2.0` or later and Node.js 24.8 or later. The web demo remains a browser demo; it is not proof of a mobile run.

## Write cases now, connect an app later

Choose **Mobile** on the scenario screen, describe the flow, and generate or download a planning prompt. You do not need to register an app or device to author, validate, compile, or save cases. A mobile suite has `"platform": "mobile"`; existing suites without a platform remain web suites.

With the installed CLI:

```sh
npm install -g @ihyeon/flow-qa@0.2.3
flow-qa init ./my-qa
# Write your mobile flow in my-qa/flows/my-flow.md first.
flow-qa plan flows/my-flow.md --platform mobile --prompt-only --workspace ./my-qa
```

Use your chosen AI tool to produce JSON from the prompt, then review and save it under `my-qa/cases/`. Alternatively, configure a planner and omit `--prompt-only`. Neither option needs the target app's source code. Product behavior and accessible element names must still be supplied; unknown expectations remain questions.

## Register an app when ready

In **Connections**, select **iOS** or **Android**, then enter a target name, the installed app's bundle/package ID, and an explicit device name or ID. Register multiple targets to use one mobile suite on both platforms when their accessible labels and expected behavior agree. Use separate suites where the two apps behave differently.

CLI examples below contain placeholders; replace them with your own app and devices:

```sh
flow-qa connect my-ios --platform ios --bundle-id com.example.app --device "QA iPhone" --workspace ./my-qa
flow-qa connect my-android --platform android --bundle-id com.example.app --device emulator-5554 --workspace ./my-qa
flow-qa run cases/my-flow.json --target my-ios --workspace ./my-qa
flow-qa run cases/my-flow.json --target my-android --workspace ./my-qa
```

Saving a target only writes configuration. It does not contact a model, boot a device, install an app, or start a test. You can update a saved target by saving the same target name again. The UI checks the reviewed app, platform, and device before dispatching a run; changed settings require another review.

For an iOS simulator, prepare Xcode, an installed simulator runtime, a booted simulator, and a simulator build of the app installed on it. For Android, prepare the Android SDK and a booted emulator or an authorized connected device with the app installed. Physical iOS devices additionally need pairing, Developer Mode, and signing of the upstream automation runner. Follow the [mobile engine's setup instructions](https://e2e.tester.army/docs/mobile#physical-devices) for device-specific requirements.

Flow QA does not download SDKs, create or boot simulators, or install application builds. A missing or unavailable selected device blocks the run; a saved target is not evidence of a working device or app. For physical device IDs that the underlying engine resolves by name, the device name must be unique after case and whitespace normalization; ambiguous selection blocks the run. Chromium is only required for web targets.

## Native steps

| Step | Behavior |
| --- | --- |
| `launchApp` | Launch the app registered in the selected target |
| `click` | Tap an accessible element |
| `fill` | Enter text in an accessible input |
| `back` | Use the engine's app back navigation |
| `swipe` | Swipe the viewport `up`, `down`, `left`, or `right` |
| `assertVisible`, `assertText` | Check accessible elements and their text |
| `act`, `assertAgent` | Use the separately configured agent model for an action or judgment |

The compiler launches the configured app at the start of each runnable case unless the first step is already `launchApp`. It does not clear app data or create login state. A launch is not a fresh account/session. The web-only `open` path and `assertUrl` steps are rejected in mobile suites, and native steps are rejected in web suites.

Native `testId` locators use iOS accessibility identifiers or Android resource IDs. Accessibility exposure depends on the app framework. Fixed steps need no model; natural-language steps require a compatible tool/image-capable agent. A WebView's exposed native controls may be usable, but this path does not provide a browser DOM session or prove JavaScript bridge behavior.

## Results and proof boundaries

Mobile reports record platform, app ID, and device rather than a fabricated URL. They use the same case statuses, attempt details, and approved screenshot/text evidence handling as web reports. Comparing different apps, platforms, or configured devices does not produce a direct regression verdict.

Configuration, compilation, mocked runtime tests, and browser UI tests establish the integration behavior. Successful iOS and Android execution still requires recorded results on the user's chosen devices and apps. Flow QA does not supply app-specific cases, accounts, build artifacts, or a device farm.
