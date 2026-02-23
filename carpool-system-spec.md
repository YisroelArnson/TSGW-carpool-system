# Carpool Dismissal System Specification

This document is a language-agnostic specification for building a real-time carpool dismissal system for Torah School of Greater Washington. It is designed to be implementable from scratch by any developer or coding agent.

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Data Model](#2-data-model)
3. [Parent Page](#3-parent-page)
4. [Classroom Display](#4-classroom-display)
5. [UI and Branding](#5-ui-and-branding)
6. [Spotter Dashboard](#6-spotter-dashboard)
7. [Admin Dashboard](#7-admin-dashboard)
8. [Realtime Architecture](#8-realtime-architecture)
9. [Daily Lifecycle](#9-daily-lifecycle)
10. [Security and Access Control](#10-security-and-access-control)
11. [Out of Scope (V2)](#11-out-of-scope-v2)
12. [Definition of Done](#12-definition-of-done)

---

## 1. Overview and Goals

### 1.1 Problem Statement

The school's current carpool dismissal process has a built-in delay. A parent arrives in the parking lot, the spotter logs their carpool number on an iPad using a Google Sheet, the classroom sees the update, and only then does the student begin walking out. By the time the child reaches the car, the parent has been waiting in line -- and every car behind them waits too. With approximately 300 students dismissed each afternoon, even small per-car delays compound into a slow, frustrating process for everyone.

The core bottleneck is that the student only starts moving after the parent is already on-site. If the classroom had advance notice that a parent was on the way, the student could be sent out earlier -- or be waiting outside when the car arrives.

### 1.2 Design Principles

**Advance notice over arrival logging.** The system's primary value is shifting the trigger from "parent arrived" to "parent is on the way." Every design decision should preserve or improve this lead time.

**Zero friction for parents.** No app install, no account creation, no login. A bookmarked web page with a cached carpool number and a single tap. The fewer steps, the higher the adoption rate.

**Backward compatible.** Parents without smartphones must be fully supported. The parking lot spotter can manually enter carpool numbers exactly as they do today. The new system adds a faster path; it does not remove the existing one.

**Realtime classroom updates.** Classroom displays must update within seconds of a check-in, without page refreshes. Teachers glance at a screen and tell the student to go. No buttons, no acknowledgment, no extra work for teachers.

**Simple to maintain.** The school does not have a dedicated IT staff. The system must be manageable through a straightforward admin dashboard with CSV import for bulk data entry. No command-line operations, no server maintenance.

### 1.3 Architecture Overview

The system consists of four web-based interfaces (plus a classroom hub page) sharing a single Supabase backend:

```
+-------------------------------------------------------+
|  Supabase (PostgreSQL + Realtime WebSockets)          |
|  +----------+  +---------+  +--------+  +----------+ |
|  | families |  | classes |  | students|  |daily_stat| |
|  +----------+  +---------+  +--------+  +----------+ |
+-------------------------------------------------------+
      ^               ^             ^             ^
      |               |             |             |
+----------+  +-------------+  +--------+  +----------+
| Admin    |  | Classroom   |  | Parent |  | Spotter  |
| Dashboard|  | Hub + Disp. |  | Page   |  | Dashboard|
+----------+  +-------------+  +--------+  +----------+
   (staff)     (projectors)     (phones)    (iPad)
```

All four interfaces are static web pages served from a hosting provider. They communicate directly with Supabase using the JavaScript client library. There is no custom backend server.

---

## 2. Data Model

### 2.1 Core Records

```
RECORD Family:
    id              : UUID                  -- primary key, auto-generated
    carpool_number  : Integer UNIQUE        -- the number parents use to check in
    parent_names    : String                -- parent/guardian names (display only)
    contact_info    : String | None         -- phone/email, optional, for admin reference
    created_at      : Timestamp             -- auto
    updated_at      : Timestamp             -- auto
```

```
RECORD Class:
    id              : UUID                  -- primary key
    name            : String                -- e.g., "3A", "5B", "Rabbi Cohen"
    display_order   : Integer               -- for sorting in admin and display views
    created_at      : Timestamp             -- auto
```

```
RECORD Student:
    id              : UUID                  -- primary key
    first_name      : String                -- student's first name
    last_name       : String                -- student's last name
    family_id       : UUID                  -- FK -> Family.id
    class_id        : UUID                  -- FK -> Class.id
    created_at      : Timestamp             -- auto
    updated_at      : Timestamp             -- auto
```

```
RECORD DailyStatus:
    id              : UUID                  -- primary key
    student_id      : UUID                  -- FK -> Student.id
    date            : Date                  -- the date this status applies to
    status          : StatusEnum            -- current status
    called_at       : Timestamp | None      -- null until status becomes CALLED
    called_by       : String | None         -- "parent" or "spotter"
    created_at      : Timestamp             -- auto

    CONSTRAINT unique_student_date : UNIQUE(student_id, date)
```

### 2.2 Enumerations

```
ENUM StatusEnum:
    WAITING         -- default; no parent signal received
    CALLED          -- parent has signaled "on the way"; student should head out
```

### 2.3 Relationships

```
Family 1 --- * Student          -- a family has one or more students
Class  1 --- * Student          -- a class has many students
Student 1 --- 0..1 DailyStatus  -- one status per student per day (created on first check-in)
```

The `carpool_number` lives on the `Family` record because siblings share a single number. When a parent checks in with their number, all students in that family are looked up, and the parent selects which ones to call.

---

## 3. Parent Page

### 3.1 Route

```
GET /
```

### 3.2 Behavior

The parent page is the primary entry point for parents checking in from their phone. It must be fast, simple, and require no authentication.

**Step 1: Number Entry**

On first visit, the page displays a numeric input field prompting the parent to enter their carpool number. After a successful check-in, the number is stored in browser `localStorage`.

On subsequent visits, if a cached number exists, the page displays a prompt:

```
"Welcome back! Use carpool #[NUMBER]?"
    [Yes]    [Change Number]
```

Tapping "Yes" proceeds immediately with the cached number. Tapping "Change Number" clears the cache and returns to the input field.

**Step 2: Student Selection**

After the number is confirmed, the system looks up the family by `carpool_number` and retrieves all students linked to that family.

```
FUNCTION load_students(carpool_number: Integer) -> List<Student>:
    family = QUERY families WHERE carpool_number == carpool_number
    IF family is NONE:
        DISPLAY "Carpool number not found. Please check your number."
        RETURN empty list
    students = QUERY students WHERE family_id == family.id
    RETURN students
```

If the family has one student, the page displays:

```
"Send [STUDENT_NAME] out?"
    [Send]
```

If the family has multiple students, the page displays each student's name with an individual button, plus an "All" button:

```
"Who are you picking up?"
    [All]
    [Student A]
    [Student B]
    [Student C]
```

**Step 3: Check-In**

When the parent taps a student button or "All", the system upserts a `DailyStatus` row for each selected student:

```
FUNCTION check_in(student_ids: List<UUID>, caller: String):
    today = SCHOOL_TODAY("America/New_York")
    FOR EACH student_id IN student_ids:
        UPSERT daily_status:
            student_id  = student_id
            date        = today
            status      = CALLED
            called_at   = NOW()
            called_by   = caller
        ON CONFLICT (student_id, date) DO UPDATE
    DISPLAY confirmation screen
```

The `caller` parameter is `"parent"` when a parent checks in from the parent page, and `"spotter"` when the spotter enters a number on the spotter dashboard.

**Step 4: Confirmation**

After check-in, the page displays a simple confirmation:

```
"Done! [STUDENT_NAME(S)] called."
    [Done]
```

Tapping "Done" returns to the number entry screen (with the cached number ready for next use).

### 3.3 Error States

| Condition | Behavior |
|-----------|----------|
| Invalid carpool number (not found) | Display "Carpool number not found. Please check your number." |
| Network failure | Display "Unable to connect. Please check your connection and try again." with a retry button. |
| Student already called today | Silently succeed (upsert is idempotent). Show confirmation as normal. |

---

## 4. Classroom Display

### 4.1 Routes

```
GET /classroom                -- Classroom Hub: grid of all classes with dismissal progress
GET /classroom/:classId       -- Individual Classroom: student grid for a single class
```

The hub page at `/classroom` displays all classes as a navigable grid. Clicking a class card navigates to `/classroom/:classId`. The `classId` parameter is the UUID of the class. Each classroom bookmarks its own individual URL.

### 4.2 Classroom Hub

The classroom hub is a top-level page that provides an at-a-glance view of dismissal progress across all classes. It is useful for administrators, front office staff, or anyone who wants to monitor the overall state of dismissal without looking at individual classroom projectors.

**Layout**

The hub displays a grid of class cards, one per class, sorted by `Class.display_order`. Each card shows the class name and a dismissal progress count.

```
+---------------------+  +---------------------+  +---------------------+
|                     |  |                     |  |                     |
|   Class 3A          |  |   Class 3B          |  |   Class 4A          |
|   4 / 10            |  |   10 / 10           |  |   0 / 8             |
|                     |  |   (faded)            |  |                     |
+---------------------+  +---------------------+  +---------------------+
+---------------------+  +---------------------+
|                     |  |                     |
|   Class 5A          |  |   Class 5B          |
|   7 / 12            |  |   2 / 11            |
|                     |  |                     |
+---------------------+  +---------------------+
```

**Progress count**

Each card displays the count of students with status `CALLED` out of the total number of students in that class, formatted as `[called] / [total]`. The counts are derived from the same `daily_status` data used by the individual classroom displays.

```
RECORD ClassHubCard:
    class_id        : UUID
    class_name      : String
    total_students  : Integer       -- count of students in this class
    called_count    : Integer       -- count of students with CALLED status today
```

```
FUNCTION compute_hub_cards() -> List<ClassHubCard>:
    classes = QUERY classes ORDER BY display_order
    today = CURRENT_DATE()
    cards = List<ClassHubCard>

    FOR EACH class IN classes:
        students = QUERY students WHERE class_id == class.id
        statuses = QUERY daily_status WHERE student_id IN students.ids AND date == today AND status == CALLED
        card = ClassHubCard(
            class_id       = class.id,
            class_name     = class.name,
            total_students = LENGTH(students),
            called_count   = LENGTH(statuses)
        )
        cards.APPEND(card)

    RETURN cards
```

**Class completion visual state**

When `called_count == total_students` (all students in the class have been called), the card must display a faded appearance to indicate that dismissal is complete for that class. The fade should apply to both the card background and the text, reducing their opacity or shifting to a muted color. The card must still be readable and clickable, but visually distinct from cards that still have students waiting.

| Condition | Visual Treatment |
|-----------|-----------------|
| `called_count < total_students` | Normal appearance (default card style) |
| `called_count == total_students` | Faded/muted appearance on both card and text (e.g., reduced opacity to ~50%, or shift to a light gray palette) |

**Navigation**

Each card is clickable. Clicking a card navigates to `/classroom/:classId` for that class's individual student grid display.

**Realtime updates**

The hub subscribes to the same `daily_status` realtime channel used by classroom displays (Section 7.2). On each event, it recalculates the `called_count` for the affected class and updates the card. The hub must maintain a client-side mapping of `student_id` to `class_id` so it can determine which card to update when a status event arrives.

```
FUNCTION init_classroom_hub():
    -- Load all classes, students, and today's statuses
    classes = QUERY classes ORDER BY display_order
    all_students = QUERY students
    today = SCHOOL_TODAY("America/New_York")
    all_statuses = QUERY daily_status WHERE date == today AND status == CALLED

    -- Build lookup maps
    student_to_class = Map<UUID, UUID>          -- student_id -> class_id
    class_student_counts = Map<UUID, Integer>    -- class_id -> total students
    class_called_counts = Map<UUID, Integer>     -- class_id -> called count

    FOR EACH student IN all_students:
        student_to_class[student.id] = student.class_id
        class_student_counts[student.class_id] += 1

    FOR EACH status IN all_statuses:
        class_id = student_to_class[status.student_id]
        class_called_counts[class_id] += 1

    RENDER hub grid(classes, class_student_counts, class_called_counts)

    -- Subscribe to changes
    SUBSCRIBE TO daily_status CHANGES:
        ON INSERT OR UPDATE (payload):
            old_called = (payload.old.status == CALLED) ? 1 : 0
            new_called = (payload.new.status == CALLED) ? 1 : 0
            delta = new_called - old_called
            target_date = payload.new.date OR payload.old.date
            target_student_id = payload.new.student_id OR payload.old.student_id

            IF target_date == today AND delta != 0:
                class_id = student_to_class[target_student_id]
                class_called_counts[class_id] += delta
                UPDATE hub card for class_id
                -- Check if class is now complete
                IF class_called_counts[class_id] == class_student_counts[class_id]:
                    APPLY fade effect to card for class_id
```

### 4.3 Individual Classroom Display

**Behavior**

The classroom display is designed to run on a projector or wall-mounted screen. It shows a grid of all students in the class and updates in real time as parents check in.

**Layout**

The display shows a grid of student cards. Each card contains the student's first and last name. The grid should be large enough to read from across a classroom.

```
+----------------+  +----------------+  +----------------+
|                |  |                |  |                |
|  Cohen, Avi    |  |  Levy, Moshe   |  |  Klein, Dov    |
|                |  |                |  |                |
+----------------+  +----------------+  +----------------+
+----------------+  +----------------+  +----------------+
|                |  |  ////////////  |  |                |
|  Rosen, Eli    |  |  Gold, Shmuel  |  |  Fried, Yaakov |
|                |  |  (CALLED)      |  |                |
+----------------+  +----------------+  +----------------+
```

**Student card states:**

| Status | Visual Treatment |
|--------|-----------------|
| `WAITING` | Default/neutral appearance (e.g., white or light gray background) |
| `CALLED` | Green background, clearly distinct from waiting state |

**Realtime subscription**

On page load, the display:

1. Fetches all students in the class (by `class_id`)
2. Fetches today's `daily_status` rows for those students
3. Renders the grid with current statuses
4. Subscribes to realtime changes on the `daily_status` table

```
FUNCTION init_classroom_display(class_id: UUID):
    students = QUERY students WHERE class_id == class_id ORDER BY last_name, first_name
    today = CURRENT_DATE()
    statuses = QUERY daily_status WHERE student_id IN students.ids AND date == today

    -- Build initial state map
    status_map = Map<UUID, StatusEnum>
    FOR EACH student IN students:
        status_map[student.id] = WAITING
    FOR EACH row IN statuses:
        status_map[row.student_id] = row.status

    RENDER grid(students, status_map)

    -- Subscribe to changes
    SUBSCRIBE TO daily_status CHANGES:
        ON INSERT OR UPDATE (payload):
            IF payload.student_id IN students.ids AND payload.date == today:
                status_map[payload.student_id] = payload.status
                UPDATE grid card for payload.student_id
```

**No teacher interaction required.** The display is purely informational. The teacher sees a name light up green and verbally tells the student to go. No buttons, no dismissal, no acknowledgment.

### 4.4 Display Considerations

The display should optimize for readability on a projector:

- Large font sizes (student names must be readable from the back of the room)
- High contrast between waiting and called states
- No unnecessary UI chrome (no navigation, no headers beyond the class name)
- The class name should appear at the top of the page as a simple label

---

## 5. UI and Branding

All pages in the carpool system must follow the Torah School of Greater Washington (TSGW) visual identity. The design should feel like a natural extension of the school's website (tsgw.org), not a separate third-party tool.

### 5.1 Color Palette

The color palette is derived from the school's website branding and tuned for a clean, light UI (no dark mode). Dark surfaces are reserved for projector-only contexts.

| Token | Hex | Usage |
|-------|-----|-------|
| `brand-maroon` | `#6B2D5B` | Primary brand color. Use for the slim header bar, primary buttons, and small accents. Avoid large solid blocks outside the header. |
| `brand-gold` | `#C4975C` | Warm accent. Use for secondary buttons, focus states, links, and small highlights. |
| `brand-dark-slate` | `#2C3E50` | Dark accent reserved for projector/classroom display backgrounds only. Do not use as a page background on parent/spotter/admin pages. |
| `surface-white` | `#FFFFFF` | Card surfaces, input fields, and primary content panels. |
| `surface-ivory` | `#F8F6F3` | Page background (default). Slightly warm rather than pure white. |
| `surface-sand` | `#EFE9E2` | Alternate section background or subtle panel differentiation. |
| `border-light` | `#E2DED8` | Dividers, card borders, and table gridlines. |
| `text-dark` | `#2B2B2B` | Primary body text on light backgrounds. |
| `text-muted` | `#6A6762` | Secondary/supporting text. |
| `status-called` | `#4CAF50` | Green for the CALLED status on student cards and confirmation states. Must be clearly distinguishable from the maroon and gold palette. |

### 5.2 Typography

| Role | Font | Weight | Usage |
|------|------|--------|-------|
| Headings | Serif (Playfair Display or similar) | Bold | Page titles, section headings, class names on displays. Uppercase for major headings. |
| Body | Sans-serif (system font stack or Open Sans) | Regular | Body text, student names, form labels, dashboard content. |
| UI elements | Sans-serif | Medium/Semibold | Buttons, navigation items, status labels. |

The school's website uses bold uppercase serif headings on dark backgrounds with generous spacing. The carpool system should follow this pattern on parent-facing pages and the classroom hub. Classroom projector displays and the spotter dashboard may prioritize readability over brand styling, using larger sans-serif text.

### 5.3 Design Patterns

**Light first.** Default to `surface-ivory` pages with `surface-white` cards. Use `brand-maroon` and `brand-gold` sparingly for emphasis, not as large backgrounds.

**Subtle sectioning.** Use `surface-sand` or thin `border-light` dividers to separate sections rather than heavy color blocks. If a full-width band is needed, prefer `surface-sand` over maroon or dark slate.

**Minimal chrome.** No heavy borders, drop shadows, or busy UI elements. Use soft borders and gentle elevation (1px borders or light shadow only if required).

**Generous whitespace.** Headings and content blocks have ample spacing. Controls should feel breathable and easy to tap.

**Brand strip.** Include a slim full-width `brand-maroon` bar at the top with the school name or "TSGW Carpool" as a subtle identifier. Keep the rest of the page light.

### 5.4 Page-Specific Styling

**Parent Page**

The parent page is the most "public-facing" page and should most closely match the school's website feel. Use `surface-ivory` for the page background and `surface-white` cards for the number input and student selection. Use `brand-maroon` for the header bar and primary action buttons, and `brand-gold` for secondary actions and focus states. The confirmation screen can use `status-called` green to reinforce the "done" state.

**Classroom Hub**

Class cards should use `surface-white` with a thin `border-light` outline and the class name in the serif heading font. The progress count (`4 / 10`) should be clear and large. Completed class cards (all students called) should fade to reduced opacity (~50%) as specified in Section 4.2. Dark backgrounds are not used on the hub view.

**Classroom Display (Projector)**

Readability is the priority over brand aesthetics. Use a dark background (`brand-dark-slate` or near-black) with high-contrast student name cards. Waiting cards should be neutral (dark gray or muted), and called cards should be `status-called` green. The class name at the top can use the serif heading font in `brand-maroon` or `brand-gold` for brand presence without sacrificing legibility.

**Spotter Dashboard**

Functional and fast. A slim `brand-maroon` header bar for brand identity. The rest of the page stays light (`surface-ivory` background, `surface-white` cards) with a prominent number input field. Use `brand-gold` for interactive elements and focus states, and reserve darker tones for text only.

**Admin Dashboard**

Professional and utilitarian. Slim `brand-maroon` header bar with the school name and a logout button. Tables and forms use clean sans-serif styling on `surface-white` panels. Use `border-light` for table gridlines and `brand-gold` for action buttons and links.

### 5.5 Responsive Considerations

| Page | Primary Device | Design Priority |
|------|---------------|----------------|
| Parent Page | Mobile phone | Mobile-first. Must work well on small screens. Large tap targets. |
| Classroom Hub | Projector, tablet, or desktop | Optimized for landscape/wide screens. Cards should fill available width. |
| Classroom Display | Projector | Fixed landscape layout. Maximum text size. No scrolling. |
| Spotter Dashboard | iPad / tablet | Tablet-optimized. Number input accessible with one hand. List scrollable. |
| Admin Dashboard | Laptop / desktop | Desktop-first. Tables and forms need screen width. Functional on tablet. |

---

## 6. Spotter Dashboard

### 6.1 Route

```
GET /spotter
```

### 6.2 Behavior

The spotter dashboard is for the staff member standing in the parking lot with an iPad. It serves two purposes: quick manual check-in for parents without smartphones, and a status overview of all students.

**Authentication and session persistence**

The spotter dashboard must require staff authentication. The iPad should stay signed in across daily use without requiring login every day.

- Spotter signs in once with a staff account (Supabase Auth)
- Session persistence remains active for multi-week use on the same device
- "Remember this device" is enabled by default on the spotter login flow
- If the iPad browser is closed/reopened, the existing session is reused automatically
- If the session expires or is revoked, the spotter is redirected to login
- A visible logout button is still provided

**Quick number entry**

At the top of the page, a prominent numeric input field with a submit button:

```
+------------------------------------------+
|  Carpool #: [________]  [Check In]       |
+------------------------------------------+
```

When the spotter enters a number and submits:

```
FUNCTION spotter_check_in(carpool_number: Integer):
    family = QUERY families WHERE carpool_number == carpool_number
    IF family is NONE:
        DISPLAY "Number not found: [NUMBER]"
        RETURN

    students = QUERY students WHERE family_id == family.id
    check_in(students.ids, "spotter")        -- reuse the same check_in function
    DISPLAY brief confirmation: "[STUDENT_NAMES] called"
    CLEAR input field                        -- ready for the next number
```

The input field should auto-focus after each submission so the spotter can immediately type the next number.

**Student status overview**

Below the number entry, a list or grid of all students with their current status:

```
RECORD SpotterStudentView:
    student_name    : String        -- "Last, First"
    class_name      : String        -- the class the student belongs to
    carpool_number  : Integer       -- from the family
    status          : StatusEnum    -- WAITING or CALLED
```

The overview must support:

- **Search/filter** by student name or carpool number
- **Sort** by name, class, or status
- **Manual status toggle** -- the spotter can tap a student row to toggle their status between WAITING and CALLED

**Realtime updates**

The spotter dashboard subscribes to the same `daily_status` realtime channel as the classroom displays, but without filtering by class. All student status changes appear immediately.

---

## 7. Admin Dashboard

### 7.1 Route

```
GET /admin
```

### 7.2 Access Control

The admin dashboard is protected by Supabase Auth. Only authenticated users can access admin functionality. There is no self-registration -- admin accounts are created manually through the Supabase dashboard by the system administrator.

**Authentication flow**

```
FUNCTION init_admin_page():
    session = supabase.auth.getSession()
    IF session is NONE:
        RENDER login form (email, password)
    ELSE:
        RENDER admin dashboard

FUNCTION handle_login(email: String, password: String):
    result = supabase.auth.signInWithPassword(email, password)
    IF result.error is not NONE:
        DISPLAY "Invalid email or password."
        RETURN
    RENDER admin dashboard

FUNCTION handle_logout():
    supabase.auth.signOut()
    RENDER login form
```

**Account provisioning**

Admin accounts are created directly in the Supabase dashboard (Authentication > Users > Add User). The system does not expose any registration or invite flow. The number of admin accounts is expected to be small (1-3 staff members).

**Session management**

The Supabase client library handles JWT storage and refresh automatically. If a session expires while the admin is using the dashboard, the page should redirect to the login form. The admin dashboard should include a visible logout button.

### 7.3 Behavior

The admin dashboard provides CRUD operations for all core data and a visual overview of the school's carpool configuration.

**6.3.1 Student Management**

A table or list of all students, showing:

| Column | Source |
|--------|--------|
| Student name | `Student.first_name`, `Student.last_name` |
| Class | `Class.name` (via `Student.class_id`) |
| Family | `Family.parent_names` (via `Student.family_id`) |
| Carpool # | `Family.carpool_number` (via `Student.family_id`) |

Actions: Add student, Edit student (name, class, family assignment), Delete student.

**6.3.2 Family Management**

A table of all families, showing:

| Column | Source |
|--------|--------|
| Carpool # | `Family.carpool_number` |
| Parent names | `Family.parent_names` |
| Contact info | `Family.contact_info` |
| Students | List of students in this family |

Actions: Add family, Edit family, Delete family (with confirmation if students are linked), Assign carpool number.

The admin dashboard must prevent duplicate carpool numbers. When adding or editing a family, the system validates:

```
FUNCTION validate_carpool_number(number: Integer, exclude_family_id: UUID | None) -> Boolean:
    existing = QUERY families WHERE carpool_number == number
    IF existing is NONE:
        RETURN true
    IF exclude_family_id is not NONE AND existing.id == exclude_family_id:
        RETURN true     -- editing the same family, number unchanged
    RETURN false        -- duplicate
```

**6.3.3 Class Management**

A table of all classes with student counts. Actions: Add class, Edit class name, Delete class (with confirmation if students are assigned), Reorder classes.

**6.3.4 Visual Overview**

A view that organizes all students by class, showing each class as a group with its students listed, along with their family and carpool number. This gives administrators a bird's-eye view of the entire carpool configuration.

**6.3.5 CSV Import**

The admin dashboard must support bulk import of student data from a CSV file. The expected CSV format:

```
student_first_name, student_last_name, class_name, carpool_number, parent_names
```

Import logic:

```
FUNCTION import_csv(csv_data: List<Row>):
    results = { students_created: 0, families_created: 0, classes_created: 0, errors: [] }

    FOR EACH row IN csv_data:
        TRY:
            -- Find or create class
            class = QUERY classes WHERE name == row.class_name
            IF class is NONE:
                class = INSERT INTO classes (name = row.class_name)
                results.classes_created += 1

            -- Find or create family
            family = QUERY families WHERE carpool_number == row.carpool_number
            IF family is NONE:
                family = INSERT INTO families (
                    carpool_number = row.carpool_number,
                    parent_names   = row.parent_names
                )
                results.families_created += 1

            -- Create student
            INSERT INTO students (
                first_name = row.student_first_name,
                last_name  = row.student_last_name,
                family_id  = family.id,
                class_id   = class.id
            )
            results.students_created += 1

        CATCH error:
            results.errors.APPEND("Row [row_number]: [error.message]")

    DISPLAY results summary
```

After import, the admin should see a summary: "Imported X students, created Y families, created Z classes. N errors." with error details if any.

---

## 8. Realtime Architecture

### 8.1 Technology

The system uses Supabase Realtime, which provides WebSocket-based subscriptions to PostgreSQL table changes. Clients subscribe to changes on the `daily_status` table and receive events when rows are inserted or updated.

### 8.2 Subscription Model

All realtime-dependent pages (classroom hub, classroom displays, spotter dashboard) subscribe to the same underlying channel:

```
SUBSCRIBE TO postgres_changes ON daily_status:
    events: INSERT, UPDATE
    schema: public
    table:  daily_status
```

**Classroom hub** filters events to update the affected class card's called count:

```
ON EVENT (payload):
    old_called = (payload.old.status == CALLED) ? 1 : 0
    new_called = (payload.new.status == CALLED) ? 1 : 0
    delta = new_called - old_called
    IF payload.new.date == today AND delta != 0:
        class_id = student_to_class[payload.new.student_id]
        class_called_counts[class_id] += delta
        UPDATE card for class_id
```

**Classroom displays** filter events client-side:

```
ON EVENT (payload):
    IF payload.student_id IN this_class_student_ids AND payload.date == today:
        UPDATE UI
```

**Spotter dashboard** receives all events without filtering.

### 8.3 Event Flow

```
Parent taps "On the Way"
    |
    v
Supabase client UPSERT -> daily_status row (status: CALLED)
    |
    v
PostgreSQL processes the write
    |
    v
Supabase Realtime broadcasts INSERT or UPDATE event
    |
    +---> Classroom Hub (updates called count for affected class card)
    |
    +---> Classroom Display (filters by class) -> student card turns green
    |
    +---> Spotter Dashboard (no filter) -> student status updates
```

### 8.4 Reconnection

If a WebSocket connection drops (network interruption, device sleep), the client must:

1. Detect the disconnection
2. Attempt to reconnect (Supabase client handles this automatically)
3. On reconnection, re-fetch current state from the database to catch any events missed during the outage
4. Re-subscribe to the realtime channel

```
FUNCTION on_reconnect(page_type: String, class_student_ids: List<UUID> | None):
    today = SCHOOL_TODAY("America/New_York")
    IF page_type == "classroom_hub":
        -- Hub: re-fetch all statuses and recompute all card counts
        statuses = QUERY daily_status WHERE date == today AND status == CALLED
        RECOMPUTE all class_called_counts from statuses
        UPDATE all hub cards
    ELSE IF page_type == "classroom_display" AND class_student_ids is not NONE:
        -- Classroom display: re-fetch only this class
        statuses = QUERY daily_status WHERE student_id IN class_student_ids AND date == today
        UPDATE UI with fresh statuses
    ELSE:
        -- Spotter dashboard: re-fetch everything
        statuses = QUERY daily_status WHERE date == today
        UPDATE UI with fresh statuses
```

---

## 9. Daily Lifecycle

### 9.1 Status Reset

Student statuses must reset daily. The system does not delete old rows -- instead, it relies on date-scoped queries:

- The canonical school timezone is `America/New_York`
- All queries for current status use `WHERE date = SCHOOL_TODAY("America/New_York")`
- When a new day begins, there are no `daily_status` rows for that date, so all students appear as `WAITING`
- Old rows remain in the table for historical reference

No scheduled job is needed for the reset. The date filter handles it naturally.

### 9.2 First Check-In of the Day

When the first parent checks in for a given student on a given day, the `UPSERT` creates a new `daily_status` row with the school-local date in `America/New_York`. Subsequent check-ins for the same student on the same day update the existing row (idempotent).

### 9.4 Timezone Implementation Rule

All "today" computations must be generated in the backend with the school timezone (`America/New_York`) rather than the device local timezone.

Reference SQL expression:

```
(now() AT TIME ZONE 'America/New_York')::date
```

### 9.3 History

The `daily_status` table accumulates rows over time (approximately 300 students x 180 school days = ~54,000 rows per year). This is trivial for PostgreSQL and provides a natural audit log. The admin dashboard may optionally expose historical queries in a future version.

---

## 10. Security and Access Control

### 10.1 Supabase Keys

The system uses a single client-side key:

| Key | Used By | Permissions |
|-----|---------|-------------|
| `anon` key | All pages (Parent, Classroom, Spotter, Admin) | Governed by RLS policies (see Section 9.2) |

The `service_role` key is never used in client-side code. All admin operations are performed through the `anon` key by an authenticated user, with RLS policies granting elevated permissions based on the user's JWT.

### 10.2 Row Level Security (RLS)

RLS policies distinguish between unauthenticated (anonymous) and authenticated (admin) access:

**Anonymous access (no login):**

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| `families` | Yes | No | No | No |
| `students` | Yes | No | No | No |
| `classes` | Yes | No | No | No |
| `daily_status` | Yes | Yes | Yes | No |

**Authenticated access (logged-in admin):**

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| `families` | Yes | Yes | Yes | Yes |
| `students` | Yes | Yes | Yes | Yes |
| `classes` | Yes | Yes | Yes | Yes |
| `daily_status` | Yes | Yes | Yes | Yes |

RLS policies check `auth.role()` to distinguish between the two tiers. The anonymous policies use `auth.role() = 'anon'` and the admin policies use `auth.role() = 'authenticated'`. Example policy pseudocode:

```
-- Anonymous: read-only on students
CREATE POLICY "anon_select_students" ON students
    FOR SELECT
    TO anon
    USING (true)

-- Authenticated: full access on students
CREATE POLICY "admin_all_students" ON students
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true)

-- Anonymous: read and write on daily_status
CREATE POLICY "anon_select_daily_status" ON daily_status
    FOR SELECT
    TO anon
    USING (true)

CREATE POLICY "anon_insert_daily_status" ON daily_status
    FOR INSERT
    TO anon
    WITH CHECK (true)

CREATE POLICY "anon_update_daily_status" ON daily_status
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true)
```

### 10.3 Security Considerations

**No service role key in the browser.** The `service_role` key is never embedded in any client-side code. Admin capabilities are enforced server-side by Postgres RLS based on the authenticated user's JWT. Even if someone inspects the admin page source, they only find the `anon` key.

**Low-risk check-in surface.** The `anon` key allows check-ins (INSERT/UPDATE on `daily_status`). Someone who knows a carpool number could trigger a false check-in. In practice, carpool numbers are only known to families, and a false check-in is merely an inconvenience (student walks out, parent hasn't arrived yet). This is acceptable for V1.

**Anon data exposure.** The `anon` key allows SELECT on all tables, meaning student names, class assignments, family carpool numbers, parent names, and contact info are queryable by anyone with the Supabase project URL and anon key. This data is not publicly searchable (requires deliberate API queries), but it is not locked down. This is accepted for V1 as a reasonable tradeoff for simplicity.

**V2 mitigation.** A per-family PIN could be added as an optional second factor for check-ins. This is documented in Section 11 as a V2 feature.

### 10.4 Security Hardening Plan (Supersedes Broad Anon Reads)

The V1 implementation plan should avoid broad anonymous table reads and instead expose only the minimum data needed per page.

**RLS posture**

- Anonymous users: no direct `SELECT` on `families`, `students`, or `classes`
- Anonymous users: no direct `SELECT` on `daily_status`
- Anonymous users: only allowed to execute narrowly scoped RPC/functions for parent check-in flow
- Authenticated spotter/admin users: access according to staff role policies

**RPC/function surface for anonymous parent flow**

- `get_family_students(carpool_number)` -> returns only the student IDs and names for that family
- `submit_parent_check_in(carpool_number, student_ids)` -> validates ownership and upserts today's `daily_status`

**Spotter access**

- `/spotter` requires staff authentication
- Use persistent Supabase sessions so spotter stays signed in for weeks on the same iPad
- Session reuse across browser restarts is required unless explicitly logged out or revoked

---

## 11. Out of Scope (V2)

The following features are intentionally excluded from V1. Each includes the extension point where it could be added.

**Staggered dismissal times.** Different grades or classes dismissed at different times. Extension point: add a `dismissal_time` field to the `Class` record and gate check-ins to a configurable window around that time on the parent page.

**Pickup complete status.** A third status (`PICKED_UP`) indicating the student has left with the parent. Extension point: add `PICKED_UP` to `StatusEnum` and a "Mark picked up" action on the spotter dashboard. Classroom display would show a third visual state.

**Per-family PIN.** A 4-digit PIN as a second authentication factor for check-in. Extension point: add a `pin` field to `Family` and a PIN entry step on the parent page after number entry.

**Analytics and reporting.** Dashboards showing average pickup times, busiest windows, historical trends. Extension point: query the `daily_status` history table and render charts in a new admin sub-page.

**Notification sounds.** An audible alert on the classroom display when a student is called. Extension point: play a short sound on the classroom display page when a student transitions to `CALLED`.

**Absent student marking.** A way to mark students as absent so they are hidden or grayed out on classroom displays. Extension point: add an `absent` boolean to `DailyStatus` or a separate `absences` table, set from the admin or spotter dashboard.

**Multi-school support.** Running the system for multiple schools from a single deployment. Extension point: add a `school_id` to all tables and scope all queries by school.

---

## 12. Definition of Done

### 12.1 Data Model

- [ ] `families` table exists with `id`, `carpool_number` (unique), `parent_names`, `contact_info`, `created_at`, `updated_at`
- [ ] `classes` table exists with `id`, `name`, `display_order`, `created_at`
- [ ] `students` table exists with `id`, `first_name`, `last_name`, `family_id` (FK), `class_id` (FK), `created_at`, `updated_at`
- [ ] `daily_status` table exists with `id`, `student_id` (FK), `date`, `status`, `called_at`, `called_by`, `created_at`
- [ ] `daily_status` has a unique constraint on `(student_id, date)`
- [ ] RLS policies enforce: anon has no broad table reads; anon access is limited to approved RPC/functions for parent check-in flow
- [ ] RLS policies enforce: authenticated users have full CRUD on all tables
- [ ] The `service_role` key is not used in any client-side code

### 12.2 Parent Page

- [ ] Page loads with a numeric input field for carpool number
- [ ] After a successful check-in, the carpool number is stored in `localStorage`
- [ ] On return visit with cached number, page shows "Welcome back! Use carpool #[N]?" with Yes/Change options
- [ ] Entering a valid carpool number shows the family's students
- [ ] Single-student family: displays one "Send" button
- [ ] Multi-student family: displays individual student buttons plus an "All" button
- [ ] Tapping a student button upserts a `daily_status` row with status `CALLED` and `called_by = "parent"`
- [ ] Tapping "All" upserts rows for all students in the family
- [ ] Confirmation screen displays after check-in
- [ ] Invalid carpool number shows an error message
- [ ] Re-checking-in a student who is already `CALLED` today succeeds silently (idempotent upsert)

### 12.3 Classroom Hub and Display

**Classroom Hub (`/classroom`)**

- [ ] Page loads at `/classroom` and displays a grid of all classes sorted by `display_order`
- [ ] Each class card shows the class name and a progress count formatted as `[called] / [total]`
- [ ] Progress counts reflect today's `daily_status` data (students with status `CALLED` out of total students in the class)
- [ ] When all students in a class are called (`called_count == total_students`), the card displays a faded/muted appearance on both the card and text
- [ ] Cards with remaining waiting students display in a normal, non-faded style
- [ ] Clicking a class card navigates to `/classroom/:classId` for that class
- [ ] Progress counts update in real time as parents check in (without page refresh)
- [ ] After WebSocket reconnection, hub re-fetches all statuses and recomputes all card counts
- [ ] At the start of a new day, all cards show `0 / [total]` with no fade effect

**Individual Classroom Display (`/classroom/:classId`)**

- [ ] Page loads at `/classroom/:classId` and displays a grid of all students in that class
- [ ] Students are sorted by last name, then first name
- [ ] Students with status `WAITING` (or no status row today) display in a neutral/default style
- [ ] Students with status `CALLED` display with a green background
- [ ] When a parent checks in on a different device, the classroom display updates within seconds without page refresh
- [ ] The display shows no interactive elements (no buttons, no input fields)
- [ ] The class name is displayed at the top of the page
- [ ] Text is large enough to read from the back of a classroom on a projector

### 12.4 Spotter Dashboard

- [ ] `/spotter` requires staff authentication before dashboard content is shown
- [ ] Spotter session persists on device for multi-week use (no daily login requirement)
- [ ] Page loads at `/spotter` with a numeric input field at the top after authentication
- [ ] Entering a valid carpool number and submitting checks in all students for that family with `called_by = "spotter"`
- [ ] Input field clears and re-focuses after each submission
- [ ] Invalid carpool number shows an error message
- [ ] Below the input, all students are listed with name, class, carpool number, and status
- [ ] Student list supports search/filter by name or carpool number
- [ ] Student list supports sorting by name, class, or status
- [ ] Spotter can manually toggle a student's status by tapping/clicking their row
- [ ] Student statuses update in real time as check-ins happen from any source

### 12.5 Admin Dashboard

- [ ] Unauthenticated visitors to `/admin` see a login form (email and password)
- [ ] Logging in with valid admin credentials grants access to the admin dashboard
- [ ] Logging in with invalid credentials shows an error message
- [ ] The admin dashboard includes a visible logout button
- [ ] After logout, the user is returned to the login form and cannot access admin features
- [ ] If the session expires, the page redirects to the login form
- [ ] Admin accounts are provisioned manually through the Supabase dashboard (no self-registration)
- [ ] Admin can view, add, edit, and delete students
- [ ] Admin can view, add, edit, and delete families
- [ ] Admin can view, add, edit, and delete classes
- [ ] Duplicate carpool numbers are rejected with a clear error message
- [ ] Admin can view all students organized by class with family and carpool number
- [ ] CSV import accepts a file with columns: `student_first_name`, `student_last_name`, `class_name`, `carpool_number`, `parent_names`
- [ ] CSV import creates families and classes that don't already exist
- [ ] CSV import displays a summary of results (students created, families created, classes created, errors)
- [ ] Deleting a family with linked students shows a confirmation warning
- [ ] Deleting a class with assigned students shows a confirmation warning

### 12.6 UI and Branding

- [ ] All pages include a slim header bar in `brand-maroon` (`#6B2D5B`) with school name or "TSGW Carpool"
- [ ] Color palette matches the spec: maroon, dark slate, gold, off-white, and green for called status
- [ ] Major headings use a serif font (Playfair Display or similar), body text uses sans-serif
- [ ] Parent page is mobile-first with large tap targets
- [ ] Classroom display uses a dark background with high-contrast student cards optimized for projector readability
- [ ] Classroom hub cards use the brand palette and fade to ~50% opacity when all students are called
- [ ] Spotter dashboard is tablet-optimized with a prominent number input
- [ ] Admin dashboard is desktop-first with clean table and form styling
- [ ] Pages have generous whitespace and minimal UI chrome consistent with the school website aesthetic

### 12.7 Realtime

- [ ] Classroom hub applies transition-based counting (`WAITING->CALLED = +1`, `CALLED->WAITING = -1`, `CALLED->CALLED = 0`) to prevent drift
- [ ] Classroom hub counts remain correct after repeated idempotent updates (no overcount)
- [ ] Classroom displays receive status updates within seconds of a check-in
- [ ] Spotter dashboard receives status updates within seconds of a check-in
- [ ] After a WebSocket disconnection and reconnection, each page re-fetches current state and resumes realtime updates
- [ ] Multiple classroom displays for different classes can run simultaneously without interference
- [ ] The classroom hub and individual classroom displays can run simultaneously without interference

### 12.8 Daily Lifecycle

- [ ] All "today" reads/writes use backend school-local date in `America/New_York` (not device-local date)
- [ ] At the start of a new day in `America/New_York` (no `daily_status` rows for school-local today), all students appear as `WAITING` on all displays
- [ ] Previous days' status rows remain in the database (not deleted)
- [ ] Check-ins create new rows for today's date; yesterday's data is unaffected

### 12.9 Cross-Interface Parity Matrix

| Test Case | Parent Page | Spotter Dashboard | Classroom Hub |
|-----------|-------------|-------------------|---------------|
| Check in a single student | [ ] | [ ] | N/A |
| Check in multiple students (All) | [ ] | [ ] | N/A |
| Invalid carpool number shows error | [ ] | [ ] | N/A |
| Status change appears on classroom display in real time | [ ] | [ ] | [ ] |
| Status change appears on spotter dashboard in real time | [ ] | [ ] | N/A |
| Idempotent re-check-in succeeds silently | [ ] | [ ] | [ ] |
| Class completion triggers fade effect on hub card | [ ] | [ ] | [ ] |

### 12.10 Integration Smoke Test

```
-- 1. Setup: seed test data
family = INSERT INTO families (carpool_number = 100, parent_names = "Test Parent")
class  = INSERT INTO classes (name = "Test Class 3A")
student_a = INSERT INTO students (first_name = "Avi", last_name = "Cohen", family_id = family.id, class_id = class.id)
student_b = INSERT INTO students (first_name = "Dov", last_name = "Cohen", family_id = family.id, class_id = class.id)

-- 2. Verify initial state
today = CURRENT_DATE()
statuses = QUERY daily_status WHERE date == today AND student_id IN [student_a.id, student_b.id]
ASSERT LENGTH(statuses) == 0

-- 3. Verify classroom hub initial state
hub_cards = compute_hub_cards()
test_card = hub_cards.find(c -> c.class_id == class.id)
ASSERT test_card.total_students == 2
ASSERT test_card.called_count == 0
-- Card should NOT be faded (not all students called)

-- 4. Parent checks in student_a
UPSERT daily_status (student_id = student_a.id, date = today, status = CALLED, called_at = NOW(), called_by = "parent")

-- 5. Verify student_a is called, student_b is still waiting
status_a = QUERY daily_status WHERE student_id == student_a.id AND date == today
ASSERT status_a.status == CALLED
ASSERT status_a.called_by == "parent"
status_b = QUERY daily_status WHERE student_id == student_b.id AND date == today
ASSERT status_b is NONE     -- no row yet means WAITING

-- 6. Verify hub shows partial progress
hub_cards = compute_hub_cards()
test_card = hub_cards.find(c -> c.class_id == class.id)
ASSERT test_card.called_count == 1
ASSERT test_card.total_students == 2
-- Card should NOT be faded (1 of 2 called)

-- 7. Spotter checks in via carpool number (both students)
family_lookup = QUERY families WHERE carpool_number == 100
ASSERT family_lookup.id == family.id
students = QUERY students WHERE family_id == family_lookup.id
ASSERT LENGTH(students) == 2
FOR EACH s IN students:
    UPSERT daily_status (student_id = s.id, date = today, status = CALLED, called_at = NOW(), called_by = "spotter")

-- 8. Verify both students are now called
status_a = QUERY daily_status WHERE student_id == student_a.id AND date == today
status_b = QUERY daily_status WHERE student_id == student_b.id AND date == today
ASSERT status_a.status == CALLED
ASSERT status_b.status == CALLED
ASSERT status_b.called_by == "spotter"

-- 9. Verify hub shows class complete with fade
hub_cards = compute_hub_cards()
test_card = hub_cards.find(c -> c.class_id == class.id)
ASSERT test_card.called_count == 2
ASSERT test_card.total_students == 2
ASSERT test_card.called_count == test_card.total_students
-- Card SHOULD be faded (all students called)

-- 10. Verify idempotent re-check-in
UPSERT daily_status (student_id = student_a.id, date = today, status = CALLED, called_at = NOW(), called_by = "parent")
status_a = QUERY daily_status WHERE student_id == student_a.id AND date == today
ASSERT status_a.status == CALLED    -- still called, no error

-- 11. Verify date isolation (simulate next day)
tomorrow = today + 1 DAY
statuses_tomorrow = QUERY daily_status WHERE date == tomorrow
ASSERT LENGTH(statuses_tomorrow) == 0    -- clean slate for tomorrow
-- Hub should show 0 / 2 for test class, no fade

-- 12. Verify carpool number uniqueness
TRY:
    INSERT INTO families (carpool_number = 100, parent_names = "Duplicate Family")
    FAIL("Should have raised a uniqueness violation")
CATCH error:
    ASSERT error CONTAINS "unique" OR error CONTAINS "duplicate"
    PASS
```

---

## Appendix A: CSV Import Format Reference

### Expected Columns

| Column | Required | Description |
|--------|----------|-------------|
| `student_first_name` | Yes | Student's first name |
| `student_last_name` | Yes | Student's last name |
| `class_name` | Yes | Name of the class (e.g., "3A"). Created if it doesn't exist. |
| `carpool_number` | Yes | Integer carpool number. Family created if number doesn't exist. |
| `parent_names` | Yes | Parent/guardian names. Used when creating a new family. |

### Example CSV

```
student_first_name,student_last_name,class_name,carpool_number,parent_names
Avi,Cohen,3A,101,David and Sarah Cohen
Dov,Cohen,5B,101,David and Sarah Cohen
Moshe,Levy,3A,102,Yosef and Rivka Levy
Shmuel,Gold,4A,103,Chaim and Miriam Gold
```

Note: Avi and Dov Cohen share carpool number 101. The import creates one family record and links both students to it.

---

## Appendix B: Design Decision Rationale

**Why a web page instead of a native app?** Adoption is the biggest risk. If parents have to download an app from the App Store, a significant percentage won't. A bookmarked web page works on any phone with a browser, requires no installation, and can be shared as a simple link in a school email.

**Why localStorage instead of accounts?** A login system adds friction (forgotten passwords, reset flows, support burden) for minimal security benefit. The carpool number is already a shared secret between the school and the family. Caching it in localStorage gives a one-tap experience on return visits. The worst case of someone clearing their browser data is that they re-enter a 3-digit number.

**Why Supabase direct instead of a custom backend?** The system's data model is simple CRUD plus realtime subscriptions -- exactly what Supabase provides out of the box. A custom Node.js backend would add deployment complexity, maintenance burden, and an additional failure point, all without adding meaningful functionality. Supabase's RLS provides sufficient access control, and the JavaScript client library handles realtime subscriptions natively.

**Why a single "On the Way" status instead of multiple tiers?** An earlier design considered three tiers: "On the Way," "Nearby," and "5 Minutes Away." This was simplified to a single status because: (a) parents are unlikely to reliably distinguish between tiers while driving, (b) a single tap is faster than choosing a tier, and (c) the classroom only needs one signal -- "send the student out." More granularity adds complexity without improving the core outcome.

**Why upsert instead of insert for daily_status?** Idempotency. If a parent taps the button twice, or the spotter also enters their number, the system should not error or create duplicate rows. An upsert on the `(student_id, date)` unique constraint ensures exactly one status row per student per day, and repeated check-ins simply update the existing row.

**Why Supabase Auth instead of a simple password gate?** A password gate protects the UI but not the data. The admin dashboard needs the ability to create, edit, and delete records in all tables. With a password gate, the service role key (which bypasses all RLS) must be embedded in client-side JavaScript, where anyone who inspects the page source can extract it. Supabase Auth lets the admin dashboard use the same `anon` key as every other page, with RLS policies granting elevated permissions only when a valid authenticated session (JWT) is present. The service role key never leaves the server.

**Why no deletion of old daily_status rows?** Keeping historical rows is free (54K rows/year is trivial for PostgreSQL) and provides a natural audit log. Date-scoped queries (`WHERE date = CURRENT_DATE()`) make old rows invisible to the UI without requiring cleanup jobs. If storage ever becomes a concern, a simple `DELETE WHERE date < [cutoff]` can be run manually.
