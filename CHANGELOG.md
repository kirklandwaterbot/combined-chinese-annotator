# Changelog

## 0.2.4 — 2026-09-26

- Fixed copied Chinese text in Google/Office editors being sent directly to the English voice; the English command now resolves and speaks its English definitions first, with dedicated diagnostic events when lookup succeeds or fails.
- Made copied-text detection resilient when Google editors swallow the normal `copy` event: the extension now also records the `Ctrl+C` keyboard signal and has a Chinese-only clipboard fallback that rejects stale non-Chinese clipboard content.
- Allowed the explicit English read-aloud command to speak copied English text when Google suppresses its copy signal; Chinese-only protection remains in place for Mandarin, Cantonese, Reader, and stroke-order actions.
- Added the 20-by-20 PinJyut quick-action logo to Google/Office canvas selections: it appears from the editor selection/copy signal, anchors near the selection pointer, and attempts to copy the hidden editor selection before running an action.
- Added cross-frame F12 diagnostics for the Google/Office selection logo, including listener delivery, selection state, pointer anchor, overlay availability, rendered visibility and dimensions, copy signals, and explicit skip reasons without logging selected or copied text.
- Added a DOM-visible `cross-frame-v2` diagnostic revision marker and made the established general Google/Office diagnostic event emit the selection-logo report too, so stale or inactive content scripts can be identified directly.

## 0.2.3 — 2026-09-25

- Added optional Azure Neural speech for Firefox with configurable English, Mandarin, and Cantonese voices, test controls, permission handling, and sanitized diagnostics.
- Added a 20-by-20 high-resolution selection shortcut that opens the extension's quick-action menu and stays dismissed after scrolling until text is selected again.
- Added an explicit Cantonese, Mandarin, or English Reader speech selector; playback controls now name the active language, reflect valid states, and English mode reads English definitions.
- Made dictionary windows draggable within the viewport and added explicit Cantonese, Mandarin, and English-definition listening with the configured voice for each language.
- Added customizable selected-text speech shortcuts with distinct Cantonese, Mandarin, and English defaults, duplicate detection, and reset controls in Speech settings.
- Added Google/Office copied-text compatibility so read-aloud, Reader, and stroke-order actions work with canvas editors after the user explicitly copies a selection; native menu speech commands now remain visible there.
- Made Google/Office copied-text compatibility and the Azure Neural engine the defaults, with a settings migration for existing 0.2.3 installations.
- Added privacy-safe Google/Office F12 diagnostics for runtime initialization, shortcuts, native context-menu delivery, text-source resolution, clipboard status, action dispatch, Azure configuration, voice selection, playback lifecycle, and failures.
- Prevented stale clipboard text (including copied console commands) from being spoken: canvas-editor actions now require a recent Ctrl+C observed in the same tab, and Mandarin/Cantonese reject copied text with no Chinese characters.
- Improved stroke-order data loading, rendering diagnostics, dark-mode speed labels, and Simplified/Traditional switching without resetting the active character.
- Restored conversion, speech, and stroke-order actions immediately after an extension reload through content-runtime recovery.
- Removed the unsupported Firefox Android manifest ID that caused a manifest warning.

## 0.2.2 — 2026-08-20

- Removed the companion caption overlay, caption observer, and related global and site-specific controls.
- Kept provider caption nodes, including YouTube captions, native and unchanged.
- Added regression coverage preventing the removed caption surface from returning.
- Replaced the review-rating button's dynamic HTML assignment with safe DOM construction.

## 0.2.1 — 2026-08-04

- Added adaptive, full-stack, primary-only, and popup-only annotation layouts with narrow-container safeguards.
- Added fail-closed compact-UI protection using pre-annotation geometry, non-reflowing popup markup, and an overflow fallback for titles, cards, menus, links, overlays, and clamped text.
- Added BCP-47-aware non-Chinese block filtering, Chinese-variety and nested-language handling, force-site profiles, scale/spacing controls, and a configurable peek key.
- Moved learning overlays into Shadow DOM and expanded dictionary phrase candidates, variants, readings, senses, classifiers, references, contexts, and custom overrides.
- Migrated vocabulary to versioned IndexedDB with context deduplication, local SRS, Words filters, review shortcuts, undo, complete backups, and CSV/TSV import.
- Added full-page Reader mode, speech controls/highlighting, and hostname-based site profiles.
- Added reproducible pinned CC-CEDICT generation and 64 on-demand compact stroke shards retaining all 9,574 characters.
- Updated Firefox/Chrome packaging, tests, privacy documentation, attribution, and source-review metadata.

Difficulty/HSK-threshold annotation hiding and frequency indicators remain excluded by design.
