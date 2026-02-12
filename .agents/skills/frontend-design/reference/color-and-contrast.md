# Color & Contrast

## Color Spaces: Use OKLCH

**Stop using HSL.** Use OKLCH (or LCH) instead. It's perceptually uniform, meaning equal steps in lightness *look* equal—unlike HSL where 50% lightness in yellow looks bright while 50% in blue looks dark. Tailwind v4's default palette uses OKLCH.

```css
/* Define custom colors in @theme */
@theme {
  /* OKLCH: lightness (0-1), chroma (0-0.4+), hue (0-360) */
  --color-primary: oklch(0.6 0.15 250);      /* Blue */
  --color-primary-light: oklch(0.85 0.08 250); /* Same hue, lighter */
  --color-primary-dark: oklch(0.35 0.12 250);  /* Same hue, darker */
}
```

Use as `bg-primary`, `text-primary-light`, etc.

**Key insight**: As you move toward white or black, reduce chroma (saturation). High chroma at extreme lightness looks garish. A light blue at 85% lightness needs ~0.08 chroma, not the 0.15 of your base color.

## Building Functional Palettes

### The Tinted Neutral Trap

**Pure gray is dead.** Add a subtle hint of your brand hue to all neutrals:

```css
@theme {
  /* Dead grays */
  --color-gray-100: oklch(0.95 0 0);     /* No personality */
  --color-gray-900: oklch(0.15 0 0);

  /* Warm-tinted grays (add brand warmth) */
  --color-gray-100: oklch(0.95 0.01 60);  /* Hint of warmth */
  --color-gray-900: oklch(0.15 0.01 60);

  /* Cool-tinted grays (tech, professional) */
  --color-gray-100: oklch(0.95 0.01 250); /* Hint of blue */
  --color-gray-900: oklch(0.15 0.01 250);
}
```

The chroma is tiny (0.01) but perceptible. It creates subconscious cohesion between your brand color and your UI.

### Palette Structure

A complete system needs:

| Role | Purpose | Example |
|------|---------|---------|
| **Primary** | Brand, CTAs, key actions | 1 color, 3-5 shades |
| **Neutral** | Text, backgrounds, borders | 9-11 shade scale |
| **Semantic** | Success, error, warning, info | 4 colors, 2-3 shades each |
| **Surface** | Cards, modals, overlays | 2-3 elevation levels |

**Skip secondary/tertiary unless you need them.** Most apps work fine with one accent color. Adding more creates decision fatigue and visual noise.

### The 60-30-10 Rule (Applied Correctly)

This rule is about **visual weight**, not pixel count:

- **60%**: Neutral backgrounds, white space, base surfaces
- **30%**: Secondary colors—text, borders, inactive states
- **10%**: Accent—CTAs, highlights, focus states

The common mistake: using the accent color everywhere because it's "the brand color." Accent colors work *because* they're rare. Overuse kills their power.

## Contrast & Accessibility

### WCAG Requirements

| Content Type | AA Minimum | AAA Target |
|--------------|------------|------------|
| Body text | 4.5:1 | 7:1 |
| Large text (18px+ or 14px bold) | 3:1 | 4.5:1 |
| UI components, icons | 3:1 | 4.5:1 |
| Non-essential decorations | None | None |

**The gotcha**: Placeholder text still needs 4.5:1. That light gray placeholder you see everywhere? Usually fails WCAG.

### Dangerous Color Combinations

These commonly fail contrast or cause readability issues:

- Light gray text on white (the #1 accessibility fail)
- **Gray text on any colored background**—gray looks washed out and dead on color. Use a darker shade of the background color, or transparency
- Red text on green background (or vice versa)—8% of men can't distinguish these
- Blue text on red background (vibrates visually)
- Yellow text on white (almost always fails)
- Thin light text on images (unpredictable contrast)

### Never Use Pure Gray or Pure Black

Pure gray (`oklch(0.5 0 0)`) and pure black (`#000`) don't exist in nature—real shadows and surfaces always have a color cast. Even a chroma of 0.005-0.01 is enough to feel natural without being obviously tinted. (See tinted neutrals example above.)

### Testing

Don't trust your eyes. Use tools:

- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- Browser DevTools → Rendering → Emulate vision deficiencies
- [Polypane](https://polypane.app/) for real-time testing

## Theming: Light & Dark Mode

### Dark Mode Is Not Inverted Light Mode

You can't just swap colors. Dark mode requires different design decisions:

| Light Mode | Dark Mode |
|------------|-----------|
| Shadows for depth | Lighter surfaces for depth (no shadows) |
| Dark text on light | Light text on dark (reduce font weight) |
| Vibrant accents | Desaturate accents slightly |
| White backgrounds | Never pure black—use dark gray (oklch 12-18%) |

```css
/* Define surface colors in your theme */
@theme {
  --color-surface-1: oklch(0.15 0.01 250);
  --color-surface-2: oklch(0.20 0.01 250);  /* "Higher" = lighter */
  --color-surface-3: oklch(0.25 0.01 250);
}

/* Override for dark mode using Tailwind's dark variant or custom variant */
.dark {
  --color-surface-1: oklch(0.15 0.01 250);
  --color-surface-2: oklch(0.20 0.01 250);
  --color-surface-3: oklch(0.25 0.01 250);
}
```

### Token Hierarchy

Use two layers: primitive tokens (`--color-blue-500`) and semantic tokens. Reference primitives with `var()`:

```css
@theme {
  --color-primary: var(--color-blue-500);
}
```

For dark mode, override semantic tokens via the `dark` variant or CSS custom properties—primitives stay the same.

## Alpha Is A Design Smell

Heavy use of transparency (rgba, hsla) usually means an incomplete palette. Alpha creates unpredictable contrast, performance overhead, and inconsistency. Define explicit overlay colors for each context instead. Exception: focus rings and interactive states where see-through is needed.

---

**Avoid**: Relying on color alone to convey information. Creating palettes without clear roles for each color. Using pure black (#000) for large areas. Skipping color blindness testing (8% of men affected).
