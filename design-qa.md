# DemoDB profile tools — visual QA

final result: passed

## Source and implementation

- Source visual truth: `docs/design/profile-tools/approved-concept.png` (1004 × 1573), plus the user's correction that meanings belong **below tables**.
- Implementation: `docs/design/profile-tools/tools-desktop.png` and `meanings-desktop.png`, 1280 × 720 CSS/pixel viewport at density 1; mobile counterparts are 375 × 812 at density 1.
- State: Chinook profile, light theme. Desktop captures are two scrolled content regions; the concept is a taller full-page composition. Comparison assessed corresponding content regions rather than treating the unequal frames as pixel-identical.
- Source and both desktop captures were opened together for comparison; mobile captures were separately inspected.

## Findings and fidelity surfaces

No actionable P0/P1/P2 findings remain.

- Typography: preserves the live site's display family, tight headings, readable 14px body, and monospace utility links.
- Spacing/layout: three separated product columns on desktop; stacked rows on phones. The native table grid precedes meanings, as requested. No horizontal overflow at 375px.
- Colors/tokens: existing pale background, olive actions, navy headings and teal links. The existing theme tokens are retained.
- Assets: real MIT-licensed Tabler database, schema and terminal icons; no screenshot or generated graph is used as a functional UI.
- Copy/content: all three product names and actions are visible. QueryDock says Coming soon. Meaning rows use authored definitions and bindings, distinguish shared/local concepts, and list the actual entities rather than the mock's illustrative six. The complete interactive graph is reached through CodeGrapher rather than the mock's static illustrative graph strip.

## Expected versus observed evidence

- Tools desktop: expected three balanced product entries with visible actions; observed aligned entries, separators and intact links.
- Meanings desktop: expected meanings after recordsets; observed the final table-card row immediately above the meanings heading and definition list.
- Tools mobile: expected vertically stacked entries; observed readable rows without clipping.
- Meanings mobile: expected definitions and mappings below tables; observed wrapped copy and usable links without overflow.

## Verification

- Static output tests cover placement, graph assets and integrity pins for all eight profiles.
- Browser check at 375px confirmed no page errors, no horizontal overflow, table-before-meaning order, and a visible concept link.
- Primary DataTug and download actions retain their existing edition-specific routes. MeaningGraph dataset/core destinations were inspected in the browser.
- CodeGrapher graph rendering, table/concept selection, definition navigation, meanings toggle, search and reload are covered in Chromium, Firefox and WebKit using the real Chinook snapshot.

## Comparison history

Round 1 passed after the implementation adopted the user's table-before-meaning correction. No visual fix iteration was required by this comparison. A separate adversarial code review found local MeaningGraph references; those are fixed and covered by regression tests.

## Follow-up polish

None required for this scope.
