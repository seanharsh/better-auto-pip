# Better Auto PiP

![Better Auto PiP Demo](assets/promo-banner.png)

Automatically enable Picture-in-Picture for videos when switching tabs or collapsing Vivaldi panels. Works with YouTube, Netflix, Plex, Twitch, and more.

## Features

- **Tab Switching**: Automatically enters PiP when you switch away from a video tab
- **Vivaldi Panel Collapse**: Enters PiP when you collapse a Vivaldi panel containing a video
- **Per-Site Controls**: Enable/disable features for specific websites
- **Custom Sites**: Add any other website yourself (Options → Custom Sites); your browser asks you to allow access to each site
- **Customizable**: Adjust timing, delays, and behavior to your preferences

## Supported Sites

- YouTube
- Netflix
- Plex
- Twitch
- Hulu
- Vimeo
- Dailymotion
- Crunchyroll
- ESPN
- Microsoft Teams
- Google Meet

Not on the list? Open the extension's **Options**, enter the site under **Custom Sites** and click **Add site**. Your browser will ask you to allow access to that site. If the video plays in an embedded player from a different website, add that website as well.

Prefer not to add sites one by one? Turn on **Allow on all sites** in Options. Your browser asks once for access to all websites, and you can turn it off at any time. With it on, automatic Picture-in-Picture works on every site, including videos inside embedded players (an iframe from another website).

### Allowing automatic Picture-in-Picture for a site

Your browser only pops a video out by itself on sites you watch often or have allowed, and extensions can't change that setting. If Better Auto PiP shows **"Automatic Picture-in-Picture is off for (site)"** when you come back to a tab, click **Allow for this site** and set **Automatic picture-in-picture** to **Allow** on the settings page that opens. You only need to do this once per site. Click **Don't ask again** to stop the message for that site. Until then, the **Trigger Picture-in-Picture** shortcut (Cmd+Shift+P / Ctrl+Shift+P by default) works at any time while a video is playing.

## Installation

### From Chrome Web Store
[Better Auto PiP on Chrome Web Store](https://chromewebstore.google.com/detail/better-auto-pip/fhlnhgbimopgpeemkifjgeepoinamikl)

### Manual Installation (Development)
1. Clone or download this repository
2. Open Chrome/Vivaldi and navigate to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `src` folder

## Usage

1. Install the extension
2. Navigate to a supported video site
3. Start playing a video
4. Switch tabs or collapse the panel (Vivaldi only)
5. Video automatically enters Picture-in-Picture mode

## Settings

Access settings by clicking the extension icon or right-clicking and selecting "Options":

- Enable/disable the extension globally
- Set the delay before PiP when a panel closes (Vivaldi only)
- Adjust tab switch delay
- Per-site enable/disable controls
- Add or remove custom sites (each site is allowed separately; removing a site also revokes its access)
- Allow on all sites (optional, off by default)

## Vivaldi Panel Auto-PiP

Your browser only lets a page start Picture-in-Picture within a few seconds of a click or key press inside it. Clicking Vivaldi's panel button doesn't count, because that click goes to Vivaldi, not to the page in the panel. So whether the video pops out when you close a panel depends on how you close it:

- **With the keyboard (works every time):** close the panel with Vivaldi's **Panel** shortcut (**Settings → Keyboard → View → Panel**, `Cmd+Option+P` / `F4` by default) while the panel has focus. The key press counts as input in the panel, so the video pops out.
- **With the mouse:** click anywhere in the panel, for example on the video, then close the panel within a few seconds.
- **At any time:** press the **Trigger Picture-in-Picture** shortcut (`Cmd+Shift+P` / `Ctrl+Shift+P` by default, set in `chrome://extensions/shortcuts`). It finds the video in an open web panel even while a normal tab is in front. Don't give it the same key as Vivaldi's Panel shortcut: only one of them runs.

If the video can't pop out when a panel closes, Better Auto PiP explains this once, the next time you open the panel.

## Notes on Chrome's Built-in Auto-PiP

Chrome 134+ has a built-in auto-PiP feature driven by the Media Session API. When enabled, Chrome may enter PiP on tab switches *before* this extension's code runs. Consequences:

- The **Tab Switch Delay** setting only applies when the extension drives PiP. If Chrome's native auto-PiP fires first, PiP appears instantly regardless of your delay.
- If you've disabled the extension for a site but PiP still activates, it's Chrome's native behavior. The extension will detect this and **auto-exit PiP** for sites where it's been disabled.
- To disable Chrome's built-in auto-PiP entirely, visit `chrome://flags` and toggle off **Auto picture in picture for video playback**.

## License

MIT License - See LICENSE file for details

## Author

**SeanHarsh**
- GitHub: https://github.com/seanharsh/Better-Auto-PiP

## Privacy

This extension does not collect, store, or transmit any user data. All settings are stored locally on your device.