# Visual references and what is borrowed

No Apple branding, marks or assets are used. These are properties of materials and layout, applied to a study tool.

## 1. Apple Human Interface Guidelines, "Materials" (Liquid Glass)
Source read in a browser on 2026-11-08: https://developer.apple.com/design/human-interface-guidelines/materials

| Property in the guidance | How it is applied here |
|---|---|
| Glass is a distinct functional layer for controls and navigation that floats above the content layer. | Glass only on: the top bar, the player's floating control bar, the heads-up notice, popovers. Never on the transcript, moment cards or page background. |
| Do not use glass in the content layer; use standard materials there. | Reading surfaces (transcript, moment cards, setup panel) are solid, crisp surfaces. |
| Use glass sparingly, only for the most important functional elements. | Four glass elements total, each over something that changes behind it. |
| Clear variant over media (photos/video); dark dimming layer about 35% where the content under it is bright. | Player controls use a dark clear glass over the video plus a bottom scrim gradient, so contrast holds on white slides. |
| Regular variant (blur and luminosity adjustment) when there is a lot of text. | Top bar and popovers use a lighter, blurrier, more opaque variant. |
| Accessibility settings that reduce transparency change the material. | `prefers-reduced-transparency` and `prefers-contrast: more` switch every glass surface to opaque; `@supports not (backdrop-filter)` does the same. |
| Thicker material for contrast of fine text, thinner for context. | Text-bearing popovers use the thick (more opaque) mix; the control bar uses thin. |

Visual treatment taken from the same material language (not stated as numbers by Apple, so chosen and tuned in the
browser): a 1px specular edge (lighter at the top-left), a faint inner highlight, soft two-layer shadow, concentric
corner radii (controls sit inside a container with radius = inner radius + padding).

## 2. Media and study interfaces (design patterns, not copied layouts)
- **Native media players (QuickTime, Apple TV, AVKit):** transport controls float over the picture, are compact, hide
  clutter, keep one clear primary control (play), and the picture is the centre of the screen. Borrowed: floating
  control bar on the video, one prominent play control, scrim for legibility, time and seek in one row.
- **Lecture-capture players with a side panel (the usual transcript + chapters pattern in tools such as Panopto or
  YouTube's theatre mode):** the video is primary and a tabbed side panel holds transcript and navigation, so
  reading and watching do not compete. Borrowed: a single secondary panel with an explicit tab selector
  (Transcript, Moments, Attention) instead of stacking every section in a sidebar.

These two are described from the established pattern, not from a page fetched during this work. Only the Apple page
above was read directly.
