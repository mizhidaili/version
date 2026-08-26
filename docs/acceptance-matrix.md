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

The current follow-up candidate is local-only. Source inspection, model tests,
and static compatibility checks are recorded separately from live Obsidian UI
acceptance. Evidence from earlier iterations remains historical and does not by
itself accept the changed File Explorer, creation, backlink, or rail UI.

## Data and identity

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Every version is an independent supported vault file | done | Supported members are Markdown (including `.excalidraw.md`), Canvas, and legacy `.excalidraw`; records live outside file contents. The follow-up creation service prepares independent Markdown, Canvas, or Excalidraw files without adding a format field to the registry. |
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
| Add pending blank version | partial | A numbered gap stages an editable filename and Markdown/Canvas/Excalidraw format; no file is written before Done. Model/static checks cover staging and shared preparation, while live mixed-format management acceptance remains pending. |
| Cancel leaves no changes | done | Pending names and formats remain draft assignments; no relationship persistence or blank creation occurs before commit. |
| File/path collisions validated before commit | done | Every pending format is prepared and path-checked before the first write, planned paths are checked against one another, and paths are revalidated at creation. |
| V1 replacement and one-member series | done | V1 cannot be cleared directly. Reducing an existing series to V1 requires dissolution confirmation; a new series requires two assigned files. |
| Manage/create without an active file | done | The command opens a series picker or an empty management canvas. |
| Keyboard/assistive alternative to pointer drag | done | Enter/Space supports pick-up/drop, Escape cancels, focus targets remain stable, and changes are announced. |
| Physical touch/mobile management workflow | not verified | Earlier mobile emulation covered the previous candidate. The changed format controls, host-level rail lane, and File Explorer behavior still require current iPad-size emulation; physical iPad touch acceptance and Android remain unverified. |

## Editor and File Explorer

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| V1 represents the series in the File Explorer | done | A healthy group hides V2+ and badges the real V1 row. |
| Visible V1 representative retains the active marker for V2+ | done | Iteration 021 mirrors Obsidian's native `is-active` feedback onto the visible V1 title only while another registered member is active. Opening an unmanaged file, refreshing, or disabling Version removes the mirror without changing the hidden member's native state. |
| File Explorer folding, virtualization, and failure visibility | partial | A healthy group now hides every mounted non-V1 by registered path even while the V1 DOM row is absent; V1 decoration resumes after remount. Invalid/incomplete groups still fail open. Model/static checks cover the plan and `data-path` observation; live folder folding, row reuse, reordering, and restart acceptance remain pending. |
| Same leaf switches exact registered member files | done | The rail calls `leaf.openFile` for real Markdown, Canvas, or Excalidraw members. |
| Every opened member keeps its real tab and inline title | done | No virtual or unified title replacement is active. |
| Markdown, Canvas, and Excalidraw rails grow from the top | partial | The follow-up CSS centralizes one outer-edge anchor, top anchor, 32px face-and-hit width, and 96px height. Every supported public content host reserves `face width - 1px overlap`, so the painted face reaches the outer pane divider while the one-pixel overlap removes the host seam at its inner edge. No private drawing descendant is selected or restyled. After a real disable/enable reload on Obsidian 1.13.7 with dark AnuPpuccin, Markdown V1, Canvas V2, and Excalidraw V4 active fills all occupied screenshot x=1040..1066; after subtracting the 109px slot step, their active tops normalize to y=93..94. At the Excalidraw V4 midline, white content continued through x=1038, x=1039 was light antialias rather than a dark seam, the face began at x=1040, and its outer antialias at x=1067 directly met the divider/sidebar beginning at x=1068. Canvas controls remained visibly left of the face, and the adjacent Excalidraw library control was opened and closed successfully. Other themes, zoom levels, scrollbar modes, narrow panes, and iPad remain pending; the narrower horizontal hit width especially needs touch acceptance. |
| Long vertical rail is usable and discoverable | partial | The follow-up rail hides its own scrollbar, leaves gaps pointer-inert, and retains calculated up/down continuation cues. Iteration 020 exercised an older stylesheet; the changed candidate still needs long-document and 30/99-version live checks. |
| V1–V99 limit | done | Index, manager, and creation paths enforce 1–99. |
| Add a new maximum or chosen numeric gap | partial | Real multi-gap menu is runtime-verified; 94 simultaneous gaps and V99 are model-tested. The full 99-item visual menu edge remains automated/static rather than complete live UI acceptance. |
| New blank filename and format are editable before creation | partial | The manager and editor-rail creation modal expose Markdown, Canvas, and Excalidraw before writing. The default follows the open member, and the shared service validates the resulting real path/content. Live UI acceptance remains pending. |
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
| Theme-level backlink calculation | partial | Resolved links are grouped one row per real source path and attributed to the registry-mapped target versions with per-version counts, without guessing from aliases. Model tests cover path attribution and numeric ordering; current modal rendering/click acceptance remains pending. |
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
| English, Simplified Chinese, Danish, and Japanese UI | done | 223 typed keys have exact key and placeholder parity across all four locales, including format selection and localized Excalidraw dependency failures. |
| Human-native Danish/Japanese publication proofread | not verified | Engineering and focused linguistic Judges pass; independent native publication proofread remains advisable before release. |
| Theme variables and pinned compatibility matrix | partial | Static checks confirm Version-scoped selectors, Obsidian color variables, no reviewed class collisions, one shared public-host outer-edge lane, and no Canvas/Excalidraw private-descendant selectors against the pinned plugins/theme. The current rail candidate now has targeted dark AnuPpuccin Markdown/Canvas/Excalidraw screenshots, pixel checks, and an adjacent Excalidraw toolbar click check; light/default/other community themes, zoom, scrollbar-mode, and iPad-size acceptance remain pending. |
| Offline, no telemetry, no account | done | Static audit finds no network, telemetry, registration, or account code. |
| README matches current architecture and API boundaries | partial | The bilingual README preserves independent-file readability, explicit membership, mixed-format support, and fail-open behavior. It has not yet been revised as final publication evidence for the changed follow-up UI, so the acceptance matrix remains authoritative for current-candidate gates. |
| Final publication README contract | partial | Community install route, public support URL, chosen license, verified minimum app version, and final platform declaration remain pending. |
| Automated model/registry/i18n tests | done | Current `npm test` passes its model/registry suite and verifies 223 keys across four locales. The exact model assertion total is emitted by the runner rather than duplicated here. This is not a substitute for an Obsidian lifecycle runner. |
| Current follow-up candidate runtime UI | not verified | Version Dev was disabled and re-enabled with the current bundle. Targeted Markdown/Canvas/Excalidraw switching passed the fixed face-coordinate, common top-anchor, no-inner-gap, and toolbar-separation screenshot checks. The changed creation controls, backlink target lines, folded-folder/remount behavior, native-scrollbar interaction, overflow cues, and the wider theme/zoom/iPad rail matrix still await final human acceptance. Earlier cumulative UI evidence is historical only for those remaining gates. |
| Separate three-file clean-vault smoke on Obsidian 1.11.5 | partial | Iteration 017 loaded, enabled, disabled, and re-enabled an older exact bundle (`main.js` `914a…`, `styles.css` `62e5…`, manifest `dc1a…`) with no console/network errors. The current candidate now requires Obsidian 1.13.4 and has different exact assets; the old smoke is historical evidence only and cannot freeze the current release payload. |

## Release readiness

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Current community runtime assets build | partial | The integrated local candidate passes `npm run build`, the model/i18n suite, lint, and the pinned static compatibility audit. The enabled Version Dev vault's schema-3 registry resolves 2 series / 8 members across Markdown, Canvas, and Excalidraw Markdown with matching file identities, while `data.json` and all version metadata remain unchanged. A live Obsidian reload and targeted rail geometry check pass; the remaining UI matrix is still pending, so this is not a frozen release payload. |
| Frozen current three-file clean install/disable/uninstall | not verified | Repeat on the exact immutable candidate, then repeat from uploaded Release assets; verify all mixed members remain ordinary and accessible after disable/uninstall. |
| `minAppVersion: 1.13.4` | done | `manifest.json` and `versions.json` now match the exact Obsidian desktop version used for the current acceptance cycle; no older minimum is claimed. |
| Mobile availability (`isDesktopOnly: false`) | partial | The manifest remains mobile-capable, but the changed follow-up UI still requires current iPad-size emulation and physical iPad acceptance. Android remains explicitly untested. |
| Root open-source license | done | Root `LICENSE` contains the MIT License with copyright `2026 Ikue`. |
| Public source repository | missing | No accepted immutable public source revision/repository chain exists. |
| Exact-version tag and GitHub Release | missing | No public tag/Release contains the exact three runtime assets. |
| `Version` name / `version` ID availability | not verified | Recheck immediately before submission; the generic name may require reviewer discussion, but must not be silently changed. |
| Community reviewer acceptance | not verified | No Community Plugins submission has been made, as required by the current development scope. |
