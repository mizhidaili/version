# Version development acceptance matrix

This document tracks implementation evidence against the current product
contract. It is a development and release-readiness checklist, not publication
documentation.

Status values:

- `done`: implemented and accepted for the explicitly named scope.
- `partial`: implemented, but an important edge or environment remains open.
- `missing`: a required artifact is known not to exist.
- `public API limitation`: Obsidian exposes no stable public integration; the
  safe fallback is named.
- `not verified`: configured or intended, but not acceptance-tested.

## Data and identity

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Every version is an independent supported vault file | done | Supported members are Markdown (including `.excalidraw.md`), Canvas, and legacy `.excalidraw`; records live outside file contents. Version-created blanks are Markdown. |
| Membership is never inferred from filenames | done | `VersionIndex` resolves only explicit series records. Iteration 018 verifies that `欢迎.md` remains V4 and filename syntax does not create a false gap. |
| Member identity is conservative | done | Records store path, last-known name, and a ctime hint; same-path replacements and identity mismatches fail open instead of being silently adopted. |
| Arbitrary names and folders | done | Slots retain real member paths and filenames; V1's real filename represents the series in the File Explorer. |
| Plugin disable leaves every supported member visible and readable | done | Iteration 013 disabled Version on a real Markdown/Canvas/Excalidraw series: rail, badge, and hiding disappeared; all members remained ordinary files. Evidence is macOS desktop, Obsidian 1.13.4. |
| Missing or invalid relationship fails open | done | Only healthy groups are hidden and decorated; unresolved/invalid groups expose their files and repair entry. |
| Rename/move while enabled updates identity-bound paths | partial | Rename handling is serialized and identity-checked; live happy paths and failure-focused model tests pass. Destructive collision, mid-batch failure, and rollback application matrices remain open. |
| Rename/move while disabled is not guessed | done | A missing stored path remains unresolved; filename similarity never silently re-adopts a file. |
| V1 cannot disappear while other members remain hidden | done | A series without a resolvable V1 is incomplete and therefore not aggregated. |
| Dissolve a series without changing member files | done | Explicit confirmation removes relationship data only; every supported member remains intact. |

## Version management

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Vault folder tree and search | done | The manager builds the real nested folder tree from every available supported member type. |
| Drag an existing supported file into a version slot | done | Staged custom Pointer Events drag updates the draft only; no file or registry write occurs before Done. |
| Drag two occupied slots to swap | done | Pointer drag swaps draft assignments while version numbers remain fixed; ordinary clicks do not swap. |
| Drag a member back to the library | done | Only the staged assignment is cleared; the real file is preserved and V1 must first be replaced. |
| Missing member shown as a repairable assignment | done | The last-known member is retained in its numbered slot and cannot be overwritten by the compact add menu. |
| Add pending blank version | done | A Markdown file is created only during Done; clicking a numbered gap stages a default editable filename. |
| Cancel leaves no changes | done | No relationship persistence or blank creation occurs before commit. |
| File/path collisions validated before commit | done | Draft slots and pending Markdown paths are preflighted and revalidated during registry commit. |
| V1 replacement and one-member series | done | V1 cannot be cleared directly. Reducing an existing series to V1 requires dissolution confirmation; a new series requires two assigned files. |
| Manage/create without an active file | done | The command opens a series picker or an empty management canvas. |
| Keyboard/assistive alternative to pointer drag | done | Enter/Space supports pick-up/drop, Escape cancels, focus targets remain stable, and changes are announced. |
| Physical touch/mobile management workflow | not verified | Official mobile emulation passes iPad portrait/landscape layout, same-leaf switching, 44px touch targets, aggregation, and disable/re-enable fail-open behavior. Physical iPad touch acceptance and Android remain unverified. |

## Editor and File Explorer

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| V1 represents the series in the File Explorer | done | A healthy group hides V2+ and badges the real V1 row. |
| Visible V1 representative retains the active marker for V2+ | done | Iteration 021 mirrors Obsidian's native `is-active` feedback onto the visible V1 title only while another registered member is active. Opening an unmanaged file, refreshing, or disabling Version removes the mirror without changing the hidden member's native state. |
| File Explorer failure restores visibility | done | The V1 row must resolve before any member row is hidden; invalid/incomplete groups fail open. |
| Same leaf switches exact registered member files | done | The rail calls `leaf.openFile` for real Markdown, Canvas, or Excalidraw members. |
| Every opened member keeps its real tab and inline title | done | No virtual or unified title replacement is active. |
| Markdown, Canvas, and Excalidraw rails grow from the top | done | Iteration 021 measures a 24px top anchor for Markdown and Canvas. Excalidraw starts at 80px to clear its overflowing native top toolbar, rather than using the former centered offset; the existing horizontal gutter remains reserved for visual-editor controls. |
| Long vertical rail is usable and discoverable | done | Iteration 020 tests the current candidate at a 405×764 desktop viewport with 24 buttons: V1–V5 are complete, V6 has zero visible intersection, the down cue remains visible, and the rail scrolls to exact registered targets. Earlier Iteration 018 theme/position evidence used the previous stylesheet payload. |
| V1–V99 limit | done | Index, manager, and creation paths enforce 1–99. |
| Add a new maximum or chosen numeric gap | partial | Real multi-gap menu is runtime-verified; 94 simultaneous gaps and V99 are model-tested. The full 99-item visual menu edge remains automated/static rather than complete live UI acceptance. |
| New blank Markdown filename is editable before creation | done | Manager blanks and the editor-rail plus validate the final real filename before writing. |
| File Explorer aggregation/badge through public API | public API limitation | Obsidian exposes no public row-hide or badge API; Version isolates a DOM compatibility layer and fails open. |
| Reveal a hidden V2+ row in the native File Explorer | public API limitation | No public API can temporarily reveal or retarget that row. Fallback: **Show Vn in Version management…** locates, highlights, and focuses the exact member. |

## Links and backlinks

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Overall link targets V1 with an independent alias | done | The link picker uses native `generateMarkdownLink`; V1 remains the real target. |
| Exact-version link targets the real member | done | Version selection and displayed alias remain independent. |
| Version link command shows one topic, then Overall/V1… | done | The explicit **Insert Version link** command is runtime-verified. |
| Reliably replace or outrank the core `[[` suggester | public API limitation | Suggester priority is not public. The explicit Version link command is the stable fallback. |
| Obsidian-styled rendered previews with nested links | done | Version-owned surfaces use public `MarkdownRenderer`, host classes/variables, delayed top-level hover, nested previews, and format-aware visual fallbacks; they do not claim Obsidian's private popover stack. |
| Theme-level backlink calculation | done | Resolved links are aggregated across every registered member path. |
| Aggregate the native core Backlinks pane itself | public API limitation | No supported API replaces the core pane's current-file target set; Version provides its own stable aggregate view/command. |

## Safety and file operations

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Version multi-member trash requires explicit buffered choice | done | The series-level entry starts empty; an exact V2+ entry preselects only that member for review. Native labelled checkboxes and the final destructive CTA remain explicit. V1 is not offered in this aggregate trash selector. |
| Delete one member releases its exact slot | done | Version-owned trash releases the selected V2+ slot before touching the real file. Native/external deletion applies the same numbered-slot rule: middle numbers become gaps, the maximum disappears, and V1 deletion dissolves the relationship so survivors remain ordinary visible files. |
| Move a whole series with preflight and best-effort rollback | partial | Planning covers every member and collision; writes are serialized and completed physical moves are rolled back on failure. Destructive collision, mid-batch failure, rollback-success, and rollback-failure runtime cases remain open; this is not claimed atomic. |
| Select one version for file actions | done | A lightweight two-column surface combines exact member selection with text-only scoped actions. It has no persistent preview pane; filename-only hover uses a deliberate 650 ms delay. Excalidraw delegates to native Page Preview. |
| Import a recovered Markdown copy without overwrite | done | Manual import creates root `basename2.md`, then increments. It does not move the Trash object back, restore timestamps/metadata, or restore Version membership. |
| Native menus remain available on a real file | done | Version appends through the public `file-menu` event. Iteration 013 verifies unmanaged Markdown/Canvas, V1, opened hidden Canvas, and opened hidden Excalidraw. |
| Clone every native/third-party menu item for a hidden member | public API limitation | No public enumeration/retargeting API exists. Version exposes bounded common actions; opening the exact real file restores its true native/third-party menu. |
| Windows/Linux native menu smoke | not verified | macOS `file-menu` events and callbacks pass; physical Windows/Linux native-system-menu interaction has not been accepted. |

## Language, appearance, and runtime verification

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| English, Simplified Chinese, Danish, and Japanese UI | done | 217 typed keys have exact key and placeholder parity across all four locales. |
| Human-native Danish/Japanese publication proofread | not verified | Engineering and focused linguistic Judges pass; independent native publication proofread remains advisable before release. |
| Theme variables and pinned compatibility matrix | partial | Iterations 013/018 pass Default and AnuPpuccin 1.5.0 light/dark, Dataview 0.5.68, Excalidraw 2.26.3, and Style Settings 1.0.9. This is a pinned matrix, not universal future-theme/plugin compatibility. |
| Offline, no telemetry, no account | done | Static audit finds no network, telemetry, registration, or account code. |
| README matches current architecture and API boundaries | done | Bilingual README documents explicit registration, mixed formats, real filenames, fail-open behavior, disable/data-loss behavior, and current public API fallbacks. |
| Final publication README contract | partial | Community install route, public support URL, chosen license, verified minimum app version, and final platform declaration remain pending. |
| Automated model/registry/i18n tests | done | Current `npm test` passes 215 model assertions and 217 keys across four locales. It is not a substitute for an Obsidian lifecycle runner. |
| Runtime acceptance in Version Dev, macOS, Obsidian 1.13.4 | done | Cumulative evidence covers core workflows, mixed formats, menus, themes/plugins, long rail, lifecycle disable/re-enable, and adversarial states. iPad-sized mobile emulation also passes the bounded checks listed below; physical iPadOS, Android, Windows/Linux, and arbitrary future integrations remain outside this claim. |
| Separate three-file clean-vault smoke on Obsidian 1.11.5 | partial | Iteration 017 loaded, enabled, disabled, and re-enabled an older exact bundle (`main.js` `914a…`, `styles.css` `62e5…`, manifest `dc1a…`) with no console/network errors. The current candidate now requires Obsidian 1.13.4 and has different exact assets; the old smoke is historical evidence only and cannot freeze the current release payload. |

## Release readiness

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Current community runtime assets build | partial | Current assets build and static audits pass (`main.js` `fb4900c0f9d673522730ba10a7abc52c387ad963d1e9f548f7e6b68bf257ae41`, `styles.css` `7697cf4cca55bf2d146afd2f89021839c61f605cb0ca1fff66a62345fd5650be`, manifest `2ba42db0fc7cf32a1f66402e5bf580e7546a07b205544c436a2f3138763e53ee`). The same three files are staged byte-for-byte in the independent iPad test vault. Earlier iterations supply feature-scoped live visual-editor, File Explorer, and transaction-safety evidence, not a complete clean-install/uninstall chain for these exact hashes. |
| Frozen current three-file clean install/disable/uninstall | not verified | Repeat on the exact immutable candidate, then repeat from uploaded Release assets; verify all mixed members remain ordinary and accessible after disable/uninstall. |
| `minAppVersion: 1.13.4` | done | `manifest.json` and `versions.json` now match the exact Obsidian desktop version used for the current acceptance cycle; no older minimum is claimed. |
| Mobile availability (`isDesktopOnly: false`) | partial | Official mobile emulation passes the core iPad layout, switch, aggregation, and lifecycle paths. Physical iPad acceptance is prepared in a separate vault; Android remains explicitly untested. |
| Root open-source license | done | Root `LICENSE` contains the MIT License with copyright `2026 Ikue`. |
| Public source repository | missing | No accepted immutable public source revision/repository chain exists. |
| Exact-version tag and GitHub Release | missing | No public tag/Release contains the exact three runtime assets. |
| `Version` name / `version` ID availability | not verified | Recheck immediately before submission; the generic name may require reviewer discussion, but must not be silently changed. |
| Community reviewer acceptance | not verified | No Community Plugins submission has been made, as required by the current development scope. |
