---
{
  "name": "ProduDash",
  "description": "A compact local-first merchant workspace with shared blue selection and native system appearance.",
  "colors":
    {
      "bg": "#ffffff",
      "sidebar": "#f5f5f7",
      "surface": "#ffffff",
      "surface-raised": "#ececef",
      "surface-hover": "#e5e5ea",
      "border": "#d9d9de",
      "border-subtle": "#e5e5ea",
      "border-strong": "#b8b8c0",
      "text": "#1d1d1f",
      "text-secondary": "#64646b",
      "text-muted": "#64646b",
      "accent": "#007aff",
      "accent-strong": "#005bbf",
      "accent-surface": "#d9eafe",
      "selected-text": "#003e80",
      "on-accent": "#ffffff",
      "action-bg": "#0063d1",
      "success": "#216e37",
      "success-surface": "#e7f4e9",
      "warning": "#805500",
      "warning-surface": "#fff3d6",
      "danger": "#d70015",
      "danger-surface": "#ffebed",
      "disabled": "#73737b",
      "media-stage": "#111113",
      "dark-bg": "#211f23",
      "dark-sidebar": "#28272a",
      "dark-surface": "#211f23",
      "dark-surface-raised": "#302e33",
      "dark-surface-hover": "#3a373d",
      "dark-border": "#434047",
      "dark-border-subtle": "#353238",
      "dark-border-strong": "#625e69",
      "dark-text": "#f4f2f5",
      "dark-text-secondary": "#b1adb5",
      "dark-text-muted": "#b1adb5",
      "dark-accent": "#0a84ff",
      "dark-action-bg": "#0066cc",
      "dark-accent-strong": "#7dbbff",
      "dark-accent-surface": "#173a61",
      "dark-selected-text": "#d6eaff",
      "dark-success": "#83dfa0",
      "dark-success-surface": "#233b2b",
      "dark-warning": "#f6cd76",
      "dark-warning-surface": "#40341d",
      "dark-danger": "#ff7973",
      "dark-danger-surface": "#47282b",
      "dark-disabled": "#a19ca8",
      "glass-chrome": "rgb(247 247 255 / 52%)",
      "dark-glass-chrome": "rgb(38 38 43 / 60%)",
      "glass-content": "rgb(255 255 255 / 62%)",
      "dark-glass-content": "rgb(28 28 33 / 66%)",
      "glass-button": "rgb(252 252 255 / 23%)",
      "dark-glass-button": "rgb(56 56 64 / 32%)",
      "glass-rim": "rgb(255 255 255 / 72%)",
      "dark-glass-rim": "rgb(255 255 255 / 13%)",
      "glass-backdrop-start": "#a8ccfa",
      "dark-glass-backdrop-start": "#0f1a38",
      "glass-backdrop-end": "#f0bdcc",
      "dark-glass-backdrop-end": "#40143d",
      "glass-text-secondary": "#45454e",
      "dark-glass-text-secondary": "#c4c0c8"
    },
  "typography":
    {
      "headline":
        {
          "fontFamily": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          "fontSize": "20px",
          "fontWeight": 700,
          "lineHeight": "26px",
          "letterSpacing": "-0.02em"
        },
      "title":
        {
          "fontFamily": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          "fontSize": "16px",
          "fontWeight": 650,
          "lineHeight": "22px",
          "letterSpacing": "-0.015em"
        },
      "body":
        {
          "fontFamily": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          "fontSize": "13px",
          "fontWeight": 400,
          "lineHeight": 1.4
        },
      "message":
        {
          "fontFamily": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          "fontSize": "14px",
          "fontWeight": 400,
          "lineHeight": "20px"
        },
      "label": { "fontFamily": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', "fontSize": "11px" }
    },
  "rounded": { "control": "6px", "panel": "16px", "pill": "999px" },
  "spacing": { "space-4": "4px", "space-8": "8px", "space-12": "12px", "space-16": "16px", "space-24": "24px", "space-32": "32px" },
  "components":
    {
      "button-primary":
        {
          "textColor": "{colors.on-accent}",
          "rounded": "{rounded.control}",
          "padding": "0 12px",
          "height": "30px",
          "backgroundColor": "{colors.action-bg}"
        },
      "button-ghost":
        {
          "textColor": "{colors.text}",
          "rounded": "{rounded.control}",
          "padding": "0 12px",
          "height": "30px",
          "backgroundColor": "{colors.surface-raised}"
        },
      "button-text": { "textColor": "{colors.accent-strong}", "rounded": "{rounded.control}", "padding": "0 8px", "height": "28px" },
      "button-danger":
        {
          "textColor": "{colors.danger}",
          "rounded": "{rounded.control}",
          "padding": "0 12px",
          "height": "30px",
          "backgroundColor": "{colors.danger-surface}"
        },
      "input-field":
        { "backgroundColor": "{colors.surface}", "textColor": "{colors.text}", "rounded": "{rounded.control}", "padding": "6px 9px" },
      "navigation-selected":
        {
          "backgroundColor": "{colors.accent-surface}",
          "textColor": "{colors.selected-text}",
          "rounded": "{rounded.control}",
          "padding": "0 10px"
        },
      "status-badge":
        {
          "backgroundColor": "{colors.surface-raised}",
          "textColor": "{colors.text-secondary}",
          "rounded": "{rounded.pill}",
          "padding": "3px 7px"
        },
      "panel": { "backgroundColor": "{colors.surface}", "textColor": "{colors.text}", "rounded": "{rounded.panel}", "padding": "20px" },
      "panel-glass":
        { "backgroundColor": "{colors.glass-content}", "textColor": "{colors.text}", "rounded": "{rounded.panel}", "padding": "20px" },
      "studio-tab-selected":
        { "backgroundColor": "{colors.surface}", "textColor": "{colors.text}", "rounded": "{rounded.control}", "padding": "7px 14px" }
    }
}
---

# Design System: ProduDash

## Overview

**Creative North Star: "The Shared macOS Workspace"**

ProduDash uses a compact, calm working interface adapted from the owner’s shared macOS Figma kit. Solid surfaces, restrained borders and a single blue selection language connect commerce operations, conversations and the media editor. This name describes the implemented direction; it does not introduce a new visual concept.

System-following solid light and dark appearances carry the same hierarchy. The approved optional Glass Light and Glass Dark variants extend this system with translucent materials from the kit’s Native Fidelity Lab; the solid themes remain available. Local system typography and bundled artwork keep the interface self-contained. Native window chrome, readable status text and explicit approval controls remain part of the working surface.

**Key Characteristics:**

- Compact system typography and controls.
- Solid defaults and optional glass surfaces with shared blue selection.
- Reserved space for Juanito and real editing controls.

This document records the implementation in `src/styles.css`, `src/appearance.css`, `src/renderer/appearance.js` and `src/renderer/ui-patterns.js`, constrained by `PRODUCT.md`. Figma provenance and workflow verification live in `docs/figma-redesign.md`; the approved iMovie/Numbers extension and its verification evidence are recorded in `docs/ui-expansion.md`. Frontmatter is normative for values; unprefixed color keys describe light appearance, and `dark-` keys contain dark appearance overrides, resolved by the OS in System mode or by the explicit appearance choice. Tokens without an override retain their light value. The CSS custom property names match these keys after removing `dark-`, except `glass-text-secondary`, which overrides `--text-secondary` and `--text-muted` only in glass mode.

## Colors

A clear blue family sits against cool light neutrals or warm charcoal neutrals, with distinct semantic surfaces.

### Primary

- **Shared Blue** (`accent` / `dark-accent`): caret, native control accent and selection boundary.
- **Action Blue** (`action-bg` / `dark-action-bg`): filled primary actions paired with `on-accent`.
- **Strong Blue** (`accent-strong` / `dark-accent-strong`): text actions and keyboard focus outlines.
- **Blue Selection Wash** (`accent-surface` / `dark-accent-surface`): selected rows and navigation, paired with `selected-text`.

### Neutral

- **Canvas / Solid Panel** (`bg`, `surface` and their dark counterparts): content foundation.
- **Sidebar / Raised / Hover** (`sidebar`, `surface-raised`, `surface-hover` and dark counterparts): shell and interactive layering.
- **Ink / Secondary Ink** (`text`, `text-secondary`, `text-muted` and dark counterparts): primary content and supporting context. Secondary and muted intentionally share a value in each appearance.
- **Divider / Subtle Divider / Strong Stroke** (`border`, `border-subtle`, `border-strong` and dark counterparts): panel separation and control boundaries.
- **Disabled Ink** (`disabled` and dark counterpart): unavailable controls and placeholders.
- **Media Stage** (`media-stage`): dark video canvas in both appearances.

Success green, warning amber and danger red each pair foreground and surface tokens. They communicate status with text and do not become section identity colors.

**The Shared Blue Rule.** Use the shared blue family for selection and primary actions across all sections; preserve semantic status colors with visible text.

### Optional glass palette

`glass-chrome`, `glass-content`, `glass-button` and `glass-rim` record the actual light tints; their `dark-` counterparts record the dark tints. Use the matching `glass-text-secondary` override for supporting text. Primary actions, selected rows and semantic statuses retain the existing blue and status tokens.

The glass backdrop is a 140.55deg gradient from `glass-backdrop-start` at 14.286% to `glass-backdrop-end` at 85.714%, using the matching dark stops in Glass Dark. These stops reproduce the kit’s blue-to-rose studies; the working media stage remains opaque.

## Typography

**Display Font:** Local system stack, shared with body; no separate display face.
**Body Font:** `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `system-ui`, `sans-serif`.

**Character:** Compact system type supports dense operational scanning. Weight and spacing distinguish headings without oversized editorial typography.

### Hierarchy

- **Headline** (`headline`): page heading.
- **Title** (`title`): section heading.
- **Body** (`body`): content and controls; controls inherit the body family and size.
- **Message** (`message`): conversation text.
- **Label** (`label`): small metadata; badge labels use semibold weight. Field labels use a distinct slightly larger semibold treatment (12px, 600).

Section descriptions stop at the implemented reading measure (68ch). Table cells use tabular numerals. Preserve actual letter spacing from frontmatter.

**The Local Type Rule.** Use the existing local system font stack; introduce no runtime font service.

## Layout

The shell has a sticky native drag region (44px high) and a sticky navigation column (208px). Workspace side padding is 24px; the shared spacing scale supplies the repeated rhythm. Existing panels use 20px padding and grouped attention regions use 16px. Do not force every measured inset onto the scale.

The Electron minimum is 1120×760. Effective CSS widths may be narrower under zoom: use shrinking grid tracks, wrapping toolbars and local scroll containers instead of whole-window horizontal overflow. The timeline intentionally scrolls internally. In Projects, preview and inspector occupy the upper editor grid; the timeline and transcript span its full width. Library media uses a responsive tile grid with a separate detail pane. Property groups wrap into columns with a 300px preferred minimum, bounded by the available width.

- At 1560px and above, an open Juanito panel occupies a reserved right column (340px) and sticks below chrome (60px).
- Below that threshold, Juanito occupies the first workspace row and content follows in the next row.
- At 1320px and below, dashboard, split, Studio and queue grids become single columns; editor grids stack and template/filter forms reduce columns.
- At 1180px and below, navigation narrows to 190px, workspace side padding becomes 16px, the library stacks and the topbar wraps.
- At 980px and below, navigation narrows to 172px; Inbox, project browsing and forms stack. Conversation/project lists use bounded internal scrolling (240px maximum height).

Preserve the seven primary sections and five Studio tabs. Shared toolbar and tab markup comes from `ui-patterns.js`; use those helpers when extending views. Native Electron window controls remain native, including platform-specific chrome behavior. macOS is the validated platform in the redesign evidence; native Windows title-bar behavior still requires Windows verification.

**The Reserved Space Rule.** Place Juanito in the workspace grid and his launcher in the sidebar footer so neither covers approval or timeline controls.

## Elevation & Depth

Depth comes primarily from solid tonal layers and strokes. Routine panels remain flat; small tab shadows establish the selected segmented control and the existing dialog shadow separates modal content. Avoid applying a modal shadow to every container.

### Optional material recipes

Glass is enabled only by `data-material="glass"`. Chrome material applies to native drag-region chrome, sidebar, Juanito panel and topbar; content material applies to panels, attention groups and project browser/editor/inspector containers; button material applies to enabled ghost buttons, icon buttons and the Juanito launcher. The topbar gains a 16px top margin, 16px inset, one-pixel rim and the existing panel radius.

CSS blur sigma is half the Figma blur radius: Chrome 22.5px → **11.25px**, Button 15px → **7.5px**, Content 45px → **22.5px**. Use `backdrop-filter: blur(...)` with the corresponding fill and rim, plus the scoped glass shadow. This recipe extends the solid depth model only for glass appearances.

Honor `prefers-reduced-transparency: reduce`: chrome becomes opaque `sidebar`, content becomes opaque `surface`, buttons become opaque `surface-raised`, and all three blur tokens become 0px. The same opaque fills apply when `backdrop-filter` is unsupported. Fields, media, semantic statuses and approval controls retain their readable working surfaces in every appearance.

### Shadow Vocabulary

- **Modal separation:** `--shadow` supplies the dialog depth, with a stronger alpha in dark appearance; exact values are in the sidecar.
- **Glass surface:** `inset 0 1px 1px rgb(255 255 255 / 10%), 0 8px 24px rgb(0 0 0 / 18%)`, scoped to glass chrome and content containers.
- **Glass button:** `inset 0 1px 1px rgb(255 255 255 / 20%), 0 3px 9px rgb(0 0 0 / 14%)`, scoped to enabled glass button roles.
- **Selected tab:** a small fixed shadow distinguishes the active Studio tab.
- **Juanito reaction:** the existing local reaction popover has its own shadow; retain its scope rather than treating it as general elevation.

## Shapes

Gently rounded controls use `rounded.control`; larger bordered groups use `rounded.panel`. Badges and search fields use pill silhouettes (`rounded.pill`). One-pixel strokes define ordinary controls and containers; tiny status dots remain circular. Preserve media clipping and timeline geometry rather than rounding every surface alike.

## Components

### Buttons

Compact, direct and stable. Primary, ghost, text and danger variants use the frontmatter primitives; buttons have medium weight and a compact control line height (17px). Primary uses Action Blue, ghost uses a raised neutral surface, text uses Strong Blue on transparent, and danger uses the semantic danger pair. Hover does not translate these buttons; ghost moves to the hover surface and text to selection wash. Disabled buttons use raised neutral fill, disabled ink and a standard border.

All keyboard-operable controls retain the shared focus outline (2px Strong Blue, 2px offset). Pending actions retain their label with an inline spinner. Use the existing compact variant where needed (28px minimum height, 12px text).

### Chips

Status badges are compact pills with semibold metadata, an optional dot and visible status text. Success, warning and danger variants pair their semantic foreground, border and surface. A status badge is not inherently a button.

### Cards / Containers

Solid panels use a subtle border and the panel radius. Attention groups use sidebar tone. Preserve section headings and the established inset rhythm; solid panels stay flat. In glass appearances, the same container geometry uses the content material recipe and its scoped shadow; inner fields and media keep opaque foundations.

### Inputs / Fields

Fields use a solid surface, strong stroke and control radius. Standard text fields retain a minimum height (30px) and frontmatter padding. Focus changes the border to Shared Blue and keyboard focus adds the shared outline. Disabled fields retain full opacity with disabled ink. Search fields are pill-shaped. Retain visible labels and associate validation/error text with its field.

### Navigation

Rows use compact system text, a leading local icon and a minimum height (34px). Default text is secondary; hover uses a raised surface. Active selection uses Blue Selection Wash, selected ink and semibold weight. Preserve local vector icon assets and the sidebar footer launcher. Studio uses wrapping segmented tabs with the selected solid surface and small shadow; `aria-selected`, roving focus, arrow keys and Home/End remain functional.

### Appearance selector

The sidebar offers exactly **System**, **Light**, **Dark**, **Glass Light** and **Glass Dark**. System is the default solid theme and follows OS changes. All explicit choices override OS appearance; Glass Light and Glass Dark also select glass material. Apply the allowlisted device-local `produdash.appearance` local-storage preference before CSS loads, falling back to System for an invalid or absent value. If storage is unavailable, selections still work for the current session.

Switch root appearance/material attributes without rerendering content so drafts, focus and playback persist. Appearance never changes workspace data, workspace schema, credentials or IPC contracts.

### Media library and project timeline

The Library uses iMovie-style media tiles with actual indexed thumbnails, a duration overlay, source metadata, visible availability status and a blue selected border. Missing thumbnails retain the existing format fallback. Selection remains a native button with `aria-pressed`; the detail pane keeps the existing source actions and metadata.

Group source/edited preview modes separately from playback transport, retaining frame stepping and the labeled seek slider. The existing interactive SVG timeline spans the editor width beneath the preview and inspector. Its ruler describes edited time; cut titles retain source ranges, with visible cut labels and durations when space permits. Indexed source thumbnails are illustrative backdrops reused across cuts, not generated per-cut filmstrips. Preserve the real segment, transcript, marker, asset, treatment and playhead geometry and the accessible cut list.

Timeline zoom runs from 1× to 4× and grows SVG width inside the scroll container while retaining its fixed height. Cut selection remains keyboard operable with a visible focus stroke. Keep the separately prepared waveform explicitly labeled **Source waveform**; it describes the source, not the edited output.

### Property groups and commerce data

Numbers-style property groups use a compact heading and aligned label/control rows separated by subtle rules. Apply the shared property-group helper to project composition settings and template creation. Retain native inputs, selects, textareas and checkboxes with their existing names, values, constraints, disabled states and consent boundaries.

Orders and Analytics use compact read-only tables with scoped column headers, tabular numbers, right-aligned amounts and alternating neutral row fills. Tables scroll inside their own wrapper. Orders remain snapshot records rather than editable spreadsheet cells.

Dashboard and Analytics share the SVG revenue-bar presentation while each supplies its own series and definition. Preserve zero, negative and unavailable values, currency, source/freshness information and comparison limits. More than eight periods use a horizontally scrollable chart region. Compact chart labels are supplemented by exact accessible data: Dashboard has a screen-reader table and Analytics has its visible period/revenue table. No invented series, decorative curves or imported sample commerce data belong in production views.

### Juanito and editing surfaces

Retain Juanito’s bundled artwork, visible history, consent, name customization and event-driven states. His panel is a bordered sidebar surface with its own scrolling, using chrome material only in glass appearances. Conversation messages use the message typography role. Preserve working media, transcript, timeline and inspector controls instead of replacing them with decorative mockups.

Control changes use the implemented short transitions; timings and easing are recorded in the sidecar. Honor `prefers-reduced-motion`: transitions and animations reduce to 1ms and one iteration, with idle/reaction transforms suppressed by the existing rules. Background updates must retain current-record draft input, focus/selection, disclosure, scroll and playback state.

## Do's and Don'ts

### Do:

- **Do** default to System, honor explicit appearance choices and preserve the shared blue hierarchy.
- **Do** use the scoped chrome/content/button recipes for glass and opaque fallback surfaces when transparency is reduced or blur unavailable.
- **Do** keep keyboard focus visible, tab selection semantic, and state labels readable.
- **Do** reflow panels at narrow effective widths and keep timeline scrolling inside its own container.
- **Do** preserve native window controls, bundled Juanito artwork and local system typography.

### Don't:

- **Don't** substitute family-specific yellow or red accents for shared blue selection.
- **Don't** add whole-window horizontal overflow or overlay Juanito on working controls.
- **Don't** remove status text, approval boundaries, consent disclosures or unavailable states to simplify a layout.
- **Don't** introduce remote runtime font or media dependencies.
