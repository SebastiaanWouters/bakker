# Spatial Design

## Spacing Systems

### Use 4pt Base, Not 8pt

8pt systems are too coarse—you'll frequently need 12px (between 8 and 16). Use 4pt for granularity: 4, 8, 12, 16, 24, 32, 48, 64, 96px.

### Name Tokens Semantically

In Tailwind v4, spacing utilities derive dynamically from a single `--spacing` variable. Customize via `@theme`:

```css
@theme {
  --spacing: 0.25rem; /* Base unit (4px) */
}
```

Use `gap` instead of margins for sibling spacing—it eliminates margin collapse and cleanup hacks.

## Grid Systems

### The Self-Adjusting Grid

Use `grid-cols-[repeat(auto-fit,minmax(280px,1fr))]` for responsive grids without breakpoints. Columns are at least 280px, as many as fit per row, leftovers stretch. For complex layouts, use named grid areas (`grid-template-areas`) and redefine them at breakpoints.

## Visual Hierarchy

### The Squint Test

Blur your eyes (or screenshot and blur). Can you still identify:
- The most important element?
- The second most important?
- Clear groupings?

If everything looks the same weight blurred, you have a hierarchy problem.

### Hierarchy Through Multiple Dimensions

Don't rely on size alone. Combine:

| Tool | Strong Hierarchy | Weak Hierarchy |
|------|------------------|----------------|
| **Size** | 3:1 ratio or more | <2:1 ratio |
| **Weight** | Bold vs Regular | Medium vs Regular |
| **Color** | High contrast | Similar tones |
| **Position** | Top/left (primary) | Bottom/right |
| **Space** | Surrounded by white space | Crowded |

**The best hierarchy uses 2-3 dimensions at once**: A heading that's larger, bolder, AND has more space above it.

### Cards Are Not Required

Cards are overused. Spacing and alignment create visual grouping naturally. Use cards only when content is truly distinct and actionable, items need visual comparison in a grid, or content needs clear interaction boundaries. **Never nest cards inside cards**—use spacing, typography, and subtle dividers for hierarchy within a card.

## Container Queries

Viewport queries are for page layouts. **Container queries are for components**. Tailwind v4 has first-class container query support:

```html
<!-- Mark the container -->
<div class="@container">
  <!-- Use @sm, @md, @lg variants for container-based breakpoints -->
  <div class="grid gap-4 @md:grid-cols-[120px_1fr]">
    <!-- ... -->
  </div>
</div>
```

Define custom container breakpoints in your theme:

```css
@theme {
  --container-3xs: 16rem;
  --container-2xs: 18rem;
}
```

**Why this matters**: A card in a narrow sidebar stays compact, while the same card in a main content area expands—automatically, without viewport hacks.

## Optical Adjustments

Text at `margin-left: 0` looks indented due to letterform whitespace—use negative margin (`-0.05em`) to optically align. Geometrically centered icons often look off-center; play icons need to shift right, arrows shift toward their direction.

### Touch Targets vs Visual Size

Buttons can look small but need large touch targets (44px minimum). Use padding or pseudo-elements:

```css
.icon-button {
  width: 24px;  /* Visual size */
  height: 24px;
  position: relative;
}

.icon-button::before {
  content: '';
  position: absolute;
  inset: -10px;  /* Expand tap target to 44px */
}
```

## Depth & Elevation

Create semantic z-index scales (dropdown → sticky → modal-backdrop → modal → toast → tooltip) instead of arbitrary numbers. Define custom shadows in your theme:

```css
@theme {
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-elevation-1: 0 1px 3px rgb(0 0 0 / 0.1);
  --shadow-elevation-2: 0 4px 6px rgb(0 0 0 / 0.1);
}
```

**Key insight**: Shadows should be subtle—if you can clearly see it, it's probably too strong.

---

**Avoid**: Arbitrary spacing values outside your scale. Making all spacing equal (variety creates hierarchy). Creating hierarchy through size alone - combine size, weight, color, and space.
