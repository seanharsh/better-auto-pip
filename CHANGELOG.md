# Changelog

All notable changes to Better Auto PiP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Planned features go here

### Changed

- Planned changes go here

### Fixed

- Planned fixes go here

## [v0.2.1] - 2026-01-21

### Changed

- Major code refactoring for improved functionality and performance (thanks @thomasboyle)
- Simplified background service worker architecture
- Streamlined content script with better state management
- Added configurable DEBUG flag for logging

## [v0.2.0] - 2026-01-07

### Added
- Floating toggle button on video pages for quick enable/disable per site
- Separate controls for tab switching vs panel collapse (Vivaldi partially working)
- Browser toolbar popup with quick enable/disable toggle
- Notification banner when PiP is blocked due to missing user interaction
- Media Session API handler for more reliable tab-switching PiP (Chrome 134+)
- Better Vivaldi browser detection
- Enhanced panel detection for Vivaldi web panels
- Separate icon sets: toolbar icons (optimized for light/dark mode) and logo icons

### Changed
- Improved icon visibility in both light and dark browser themes
- Enhanced user interaction tracking for better PiP gesture handling
- Improved tab switch detection with fallback mechanisms

### Fixed
- Icon visibility issues in dark mode browser toolbars
- Tab switching PiP reliability using Media Session API
- Panel detection accuracy in Vivaldi browser

### Technical
- Renamed icon files to `icon{size}-toolbar.png` and `icon{size}-logo.png` for clarity
- Added SVG-based floating toggle icon
- Implemented MediaSessionHandler for Chrome 134+ automatic PiP support

## [v0.1.0] - 2025-12-31

### Added
- Initial release of Better Auto PiP
- Automatic Picture-in-Picture when switching tabs
- Panel collapse detection (Vivaldi browser)
- Support for 12+ video streaming sites:
  - YouTube, Netflix, Plex, Twitch, Hulu
  - Google Meet, Microsoft Teams
  - ESPN, Vimeo, Dailymotion, Crunchyroll
- Configurable debounce and tab switch delays
- Per-site enable/disable controls
- "Arm" feature for temporarily bypassing blocked PiP
- Exit PiP when returning to tab/panel (optional)
- Customizable panel collapse thresholds for Vivaldi

### Technical
- Chrome Manifest V3
- Service worker architecture

[Unreleased]: https://github.com/seanharsh/Better-Auto-PiP/compare/v0.2.1...HEAD
[v0.2.1]: https://github.com/seanharsh/Better-Auto-PiP/compare/v0.2.0...v0.2.1
[v0.2.0]: https://github.com/seanharsh/Better-Auto-PiP/compare/v0.1.0...v0.2.0
[v0.1.0]: https://github.com/seanharsh/Better-Auto-PiP/releases/tag/v0.1.0