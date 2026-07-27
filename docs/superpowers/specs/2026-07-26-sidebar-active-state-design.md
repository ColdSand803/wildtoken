# Sidebar active-state design

## Goal

Make the selected item in the left navigation read as a full-width destination rather than a narrow indicator, without changing navigation behaviour.

## Chosen approach

Use a visually wider active tab paired with the existing directional accent rule:

- Desktop sidebar: retain the left accent edge and extend the selected tab 16px from the rail into the work stage, without changing the rail or content layout.
- Narrow screens: preserve the existing bottom-edge accent so the state still matches the horizontal navigation direction.
- Keep hover and `:focus-visible` visually distinct from selected state; selection must not rely on colour alone because the persistent accent edge remains.

## Scope

Change only the CSS rules for `.nav-link.active` and its Ark/Endfield theme overrides, plus their CSS contract test. Do not modify markup, routing, spacing of neighbouring content, or the selected-view JavaScript.

## Verification

Review the rendered admin page at desktop sidebar and narrow bottom-navigation breakpoints. Confirm the active background occupies the link's available width, while hover and keyboard focus remain legible.
