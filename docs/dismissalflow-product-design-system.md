# DismissalFlow Product Design System

This document describes the visual and interaction direction for the DismissalFlow product interface. It is intentionally page-agnostic. It should guide dashboards, classroom displays, parent check-in flows, admin tools, and future product surfaces without prescribing a specific page layout.

The mock-up at `mockups/operations-dashboard.html` may be used as a visual reference for tone, density, color, spacing, and component treatment. It should not be copied as production structure, routing, data flow, or final UI architecture.

## Product Tone

DismissalFlow should feel like calm school operations software.

The marketing site can be playful and illustrative. The product itself should be quieter, more functional, and easier to scan during repeated daily use. The interface should still feel warm and approachable, but it should never feel cartoonish, decorative, or distracting.

The product UI should communicate:

- The dismissal is under control.
- Important work is visible immediately.
- Exceptions are easy to find.
- Actions are clear and reversible where appropriate.
- Parents, teachers, staff, and administrators each see only what they need.

## Design Principles

### Operational Clarity

Prioritize immediate understanding over visual novelty. Staff should know what needs attention without reading a dense interface. Classrooms should know which students should leave with a quick glance. Parents should be able to check in without learning a system.

### Warm Restraint

Use the DismissalFlow palette and rounded softness, but keep the working UI restrained. The app should borrow warmth from the landing page, not its illustration-heavy style.

### Role-Specific Simplicity

Every role has a different tolerance for complexity.

- Parents need a short mobile flow.
- Teachers need large, readable status tiles.
- Staff need fast queue actions.
- Administrators need organized density and auditability.

### Consistent State Language

Colors should have stable operational meanings. Avoid using status colors for decoration.

### Dense Enough, Not Busy

The product should support repeated real-world use. Surfaces can be information-rich, but hierarchy, spacing, and state treatment must make them calm to scan.

## Color System

Use these core tokens:

```css
--navy: #17243A;
--charcoal: #30343B;
--ivory: #FAF7F1;
--cream: #FFF4E6;
--aqua: #BFE5E3;
--coral: #F26D5B;
--green: #2E7D50;
--amber: #F2B84B;
--line: #E8DFD2;
--muted: #68707C;
--panel: #FFFDF8;
--soft: #F4EEE4;
```

### Usage

Use `--ivory` for main page backgrounds.

Use `--panel`, white, and cream surfaces for cards, forms, dashboards, and containers.

Use `--navy` for headings, navigation, primary structure, and strong text.

Use `--green` only for success, called, ready, dismissed, approved, complete, or live states.

Use `--amber` for waiting, pending, in progress, get ready, or needs follow-up soon.

Use `--coral` for mismatch, blocked, urgent, destructive, or attention-needed states.

Use `--aqua` for selected states, calm emphasis, secondary accents, and soft focus backgrounds.

Avoid using coral as the default product primary action. Coral can remain a marketing accent, but product actions should generally use navy or state-specific green.

## Typography

Use a readable sans-serif app typeface.

Recommended stack:

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Avoid decorative or editorial fonts inside the product interface. Save those for the marketing site.

Recommended hierarchy:

- Page titles: 18-22px, 700 weight
- Section titles: 15-17px, 700 weight
- Body text: 14-15px
- Labels and metadata: 12-13px, 600-750 weight
- Large operational numbers: 28-34px, 700 weight

Use uppercase sparingly. It works best for compact labels, status captions, or table headers, not primary content.

## Shape, Spacing, And Surfaces

The product should use modest rounding.

- Panels and cards: 8px radius
- Buttons and inputs: 6-8px radius
- Badges and status chips: 7px radius, or pill shape only when the component is truly a chip

Prefer borders over heavy shadows:

```css
border: 1px solid var(--line);
box-shadow: none;
```

Small shadows may be used for overlays, popovers, or draggable layers, but not as the default card style.

Recommended spacing:

- Page padding: 16-24px
- Panel padding: 14-18px
- Grid gaps: 10-16px
- Compact row gaps: 6-8px

Fixed-format operational elements should have stable dimensions so state changes do not shift layout.

## Iconography

Use simple functional icons, preferably from `lucide`.

Icons should be:

- Consistent in size
- Legible at small scale
- Paired with labels when meaning is not obvious
- Used to reinforce actions, not decorate surfaces

Common icon meanings:

- Users/group: families, students, staff
- Book/class: classes and classrooms
- Shield/check: pickup permissions
- Upload: CSV import
- Clock: waiting or elapsed time
- Check: ready, called, dismissed, approved
- Alert/bell: exception or attention

## Component Language

### App Shell

The app shell should be quiet and predictable.

Common shell elements may include:

- Product or school identity
- Current dismissal session
- Live status
- Current time
- Role-specific navigation
- Primary session action when relevant

Navigation should be clear, compact, and consistent across admin/staff views. Active states should use green or aqua treatment, not heavy decoration.

### Panels And Cards

Panels should organize work, not act as decorative blocks.

A good product panel has:

- Clear title
- Optional short subtitle
- One primary purpose
- Stable spacing
- Clear empty/loading/error states

Avoid placing cards inside cards unless the inner cards represent repeated items or distinct records.

### Stat Cards

Use stat cards for operational totals and live counts.

Stat cards should include:

- Short label
- Large number
- Optional icon or small progress line
- State color only when meaningful

Do not overload stat cards with long explanations.

### Rows And Lists

Rows should be optimized for scanning.

Useful row elements:

- Primary identifier
- Secondary context
- Status
- Timestamp or elapsed time
- Action area

Rows that support repeated operational work should keep action placement consistent.

### Buttons

Button hierarchy should be restrained.

- Primary operational action: navy or state green
- Secondary action: cream/white with border
- Attention/destructive action: coral, used sparingly
- Hold/pending action: amber-tinted treatment

Button labels should be direct verbs, such as `Call`, `Dismiss`, `Hold`, `Check in`, `Import`, `Review`.

### Badges And Chips

Use chips for compact selections, labels, and status metadata.

Examples:

- Student chips
- Room labels
- Pickup permission states
- Recurring carpool labels
- Live status

Chips should remain readable and should not replace clear layout hierarchy.

## State System

Use the following meanings consistently:

| State | Meaning |
| --- | --- |
| Green | Ready, called, dismissed, approved, live, complete |
| Amber | Waiting, pending, get ready, in progress, follow-up soon |
| Coral | Mismatch, blocked, urgent, attention needed |
| Grey | Inactive, neutral, not yet called, unavailable |
| Navy | Primary structure, strong text, default action emphasis |

Do not create multiple competing meanings for the same color.

## Role-Specific Guidance

### Parent Experience

The parent experience should feel almost consumer-simple.

Principles:

- One task per screen
- Large touch targets
- Minimal required reading
- No admin language
- No unnecessary accounts, menus, or dashboards

Typical elements:

- School name
- Child selection
- Authorized pickup context
- Primary `Check in` action
- Clear confirmation state

### Classroom Experience

The classroom experience must work from across the room.

Principles:

- Large student tiles
- Clear called/waiting states
- Minimal controls
- High contrast
- No dense admin details

Teachers should be able to glance at the display and know which students should head out.

### Staff Experience

The staff experience is live operations.

Principles:

- Queue-first layout
- Exceptions surfaced clearly
- Fast row actions
- Permission issues visible before dismissal
- Stable layouts that do not jump during updates

Staff screens should make the next action obvious.

### Admin Experience

The admin experience can be denser, but must remain organized.

Principles:

- Clear navigation
- Bulk data workflows are explicit
- Imports, rosters, families, classes, and permissions have distinct homes
- Live dismissal status is visible without burying setup tools
- Audit and review states are easy to find

Admin screens should reduce spreadsheet dependence, not recreate spreadsheet clutter.

## Motion And Feedback

Motion should be subtle and functional.

Use motion for:

- Live updates arriving
- Student status changing
- Queue row insertion
- Confirmation after an action
- Alert surfacing

Avoid decorative motion inside the product. Landing page motion can be playful; product motion should reduce uncertainty.

Recommended motion:

- 120-200ms transitions
- Small opacity/translate changes
- Gentle highlight pulse for live updates
- No bouncing, overshooting, or playful character motion

Respect reduced-motion preferences.

## Accessibility

The product must not rely on color alone.

Each status should have at least one additional cue:

- Text label
- Icon
- Position
- Badge
- Pattern or progress treatment

Use sufficient contrast for operational text, especially classroom displays and staff queue actions.

Touch targets should be large enough for mobile parent flows and staff tablet use.

## Responsive Behavior

Desktop admin/staff views may use:

- Left navigation
- Central work surface
- Right rail for alerts or activity

Tablet views should keep the main operational surface central and move secondary panels below or into tabs.

Mobile views should be role-specific. Parent flows should be mobile-first. Staff/admin mobile views should prioritize one task at a time rather than squeezing dense dashboards into narrow columns.

## Product UI Anti-Patterns

Avoid:

- 3D illustrations inside working dashboards
- Heavy shadows and floating card stacks
- Decorative blobs, orbs, or gradients
- Purple SaaS gradient styling
- Marketing-style hero typography inside the product
- Excessive pill shapes
- Dense spreadsheet grids as the primary interaction
- Coral as generic primary action color
- Unclear status colors
- Tiny unreadable labels
- Animations that slow down live operations

## Implementation Notes

Use this design system as the source of truth for product UI direction.

Use `mockups/operations-dashboard.html` only as a visual reference. It demonstrates an intended feel, not a production architecture.

Do not treat the mock-up as:

- Final page structure
- Final component boundaries
- Final routing
- Final data model
- Final interaction behavior
- A file to copy directly into production

Implement real product screens using the existing project structure, current data flows, and role-specific needs.
