(function adminPage() {
  const {
    mustClient,
    show,
    requireAuth,
    csvToArrays,
    escapeHtml,
    schoolTodayISO,
    fetchSchoolToday,
    familyDisplayName,
    normalizeText,
    CARPOOL_WEEKDAYS,
    normalizeWeekdays,
    formatWeekdays
  } = window.carpoolUtils || {};
  if (!mustClient) return;

  const PERMANENT_END_DATE = "9999-12-31";
  const IMPORT_EDITABLE_FIELDS = [
    "carpool_number",
    "student_first_name",
    "student_last_name",
    "class_name",
    "parent_one_title",
    "parent_one_first_name",
    "parent_one_last_name",
    "parent_two_title",
    "parent_two_first_name",
    "parent_two_last_name",
    "notification_email",
    "notification_enabled"
  ];
  const REQUIRED_IMPORT_FIELDS = ["carpool_number", "student_first_name", "student_last_name", "class_name"];
  const IMPORT_HEADER_ALIASES = {
    lastname: "student_last_name",
    studentlastname: "student_last_name",
    firstname: "student_first_name",
    studentfirstname: "student_first_name",
    grade: "grade",
    class: "class_name",
    classname: "class_name",
    classgroup: "class_name",
    carpool: "carpool_number",
    carpoolnumber: "carpool_number",
    carpoolno: "carpool_number",
    carpoolnum: "carpool_number",
    carpoolid: "carpool_number",
    parentnames: "legacy_parent_names",
    parent1title: "parent_one_title",
    parent1firstname: "parent_one_first_name",
    parent1lastname: "parent_one_last_name",
    parent2title: "parent_two_title",
    parent2firstname: "parent_two_first_name",
    parent2lastname: "parent_two_last_name",
    notificationemail: "notification_email",
    familyemail: "notification_email",
    parentemail: "notification_email",
    email: "notification_email",
    notificationsenabled: "notification_enabled",
    notificationenabled: "notification_enabled",
    alerts: "notification_enabled",
    alertsenabled: "notification_enabled",
    student_first_name: "student_first_name",
    student_last_name: "student_last_name",
    class_name: "class_name",
    carpool_number: "carpool_number",
    parent_one_title: "parent_one_title",
    parent_one_first_name: "parent_one_first_name",
    parent_one_last_name: "parent_one_last_name",
    parent_two_title: "parent_two_title",
    parent_two_first_name: "parent_two_first_name",
    parent_two_last_name: "parent_two_last_name",
    notification_email: "notification_email",
    notification_enabled: "notification_enabled"
  };

  const state = {
    today: schoolTodayISO(),
    classes: [],
    families: [],
    students: [],
    dailyStatus: [],
    pickupAuthorizations: [],
    pickupAuthorizationStudents: [],
    pickupAuthorizationAudit: [],
    carpoolPresets: [],
    carpoolPresetStudents: [],
    currentTab: "today",
    channel: null,
    refreshTimer: null,
    todayAttemptSearch: "",
    todayGridWaitingOnly: false,
    todayGridFullscreen: false,
    todayGridFitTimer: null,
    importPreview: {
      fileName: "",
      rows: [],
      headerIssues: [],
      classOrderHints: [],
      parseError: "",
      resultHtml: "No import run in this session."
    },
    modal: {
      mode: null,
      entityId: null
    }
  };

  const sortState = {
    today:    { col: null, dir: "asc" },
    students: { col: null, dir: "asc" },
    families: { col: null, dir: "asc" },
    classes:  { col: null, dir: "asc" },
    permissions: { col: null, dir: "asc" },
    presets: { col: null, dir: "asc" }
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setNodeMessage(nodeId, text, klass) {
    const node = el(nodeId);
    if (!node) return;
    node.className = klass || "";
    node.textContent = text;
    show(nodeId, Boolean(text));
  }

  function familyLabel(family) {
    return `#${family.carpool_number} - ${familyDisplayName(family)}`;
  }

  function classLabel(cls) {
    return cls.name;
  }

  function studentLabel(student) {
    return `${student.last_name}, ${student.first_name}`;
  }

  function weekdayCheckboxesHtml(selectedDays) {
    const selected = new Set(normalizeWeekdays(selectedDays || []));
    return (CARPOOL_WEEKDAYS || []).map((day) => {
      const checked = selected.has(day.key) ? "checked" : "";
      return `<label class="checkbox-option">
        <input type="checkbox" data-preset-weekday value="${escapeHtml(day.key)}" ${checked} />
        <span class="checkbox-option-row">
          <span class="checkbox-option-main">
            <span class="checkbox-option-toggle" aria-hidden="true"></span>
            <span class="checkbox-option-copy">
              <span class="checkbox-option-name">${escapeHtml(day.label)}</span>
              <span class="checkbox-option-meta">${escapeHtml(day.short)}</span>
            </span>
          </span>
        </span>
      </label>`;
    }).join("");
  }

  async function currentActorLabel(client, fallback) {
    try {
      const { data } = await client.auth.getUser();
      return data?.user?.email || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function checkInSourceLabel(record) {
    const source = record?.called_by || "";
    const actor = record?.checked_in_by || "";
    const sourceLabel = source ? source.charAt(0).toUpperCase() + source.slice(1) : "";
    if (!source && !actor) return "-";
    if (!actor || actor.toLowerCase() === source.toLowerCase()) return sourceLabel || actor;
    if (!source) return actor;
    return `${sourceLabel}: ${actor}`;
  }

  function cleanValue(value) {
    return String(value || "").trim();
  }

  function importKey(value) {
    return cleanValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function normalizedClassName(value) {
    return cleanValue(value).replace(/\s+/g, " ");
  }

  function canonicalCarpool(value) {
    const text = cleanValue(value);
    return /^\d+$/.test(text) ? String(Number(text)) : text;
  }

  function normalizedStudentName(value) {
    return normalizeText(value);
  }

  function personDisplayName(firstName, lastName) {
    return [cleanValue(firstName), cleanValue(lastName)].filter(Boolean).join(" ");
  }

  function familyNamePayload(prefix, data) {
    return {
      [`${prefix}_title`]: cleanValue(data?.[`${prefix}_title`]) || null,
      [`${prefix}_first_name`]: cleanValue(data?.[`${prefix}_first_name`]) || null,
      [`${prefix}_last_name`]: cleanValue(data?.[`${prefix}_last_name`]) || null
    };
  }

  function notificationEnabledFromValue(value, defaultValue = true) {
    if (typeof value === "boolean") return value;
    const text = cleanValue(value).toLowerCase();
    if (!text) return defaultValue;
    if (["false", "no", "n", "0", "off", "disabled"].includes(text)) return false;
    return true;
  }

  function familyPayloadFromValues(values, options = {}) {
    const includeNotification = options.includeNotification !== false;
    const payload = {
      carpool_number: Number(values.carpool_number),
      ...familyNamePayload("parent_one", values),
      ...familyNamePayload("parent_two", values),
      contact_info: cleanValue(values.contact_info) || null
    };

    if (includeNotification) {
      payload.notification_email = cleanValue(values.notification_email) || null;
      payload.notification_enabled = notificationEnabledFromValue(values.notification_enabled, true);
    }

    return payload;
  }

  function sameFamilyData(a, b) {
    const fields = [
      "parent_one_title",
      "parent_one_first_name",
      "parent_one_last_name",
      "parent_two_title",
      "parent_two_first_name",
      "parent_two_last_name"
    ];
    if (Object.prototype.hasOwnProperty.call(b || {}, "notification_email")) fields.push("notification_email");
    if (Object.prototype.hasOwnProperty.call(b || {}, "notification_enabled")) fields.push("notification_enabled");
    return fields.every((field) => {
      if (field === "notification_enabled") {
        return notificationEnabledFromValue(a?.[field], true) === notificationEnabledFromValue(b?.[field], true);
      }
      return cleanValue(a?.[field]) === cleanValue(b?.[field]);
    });
  }

  function legacyParentParts(value) {
    const pieces = String(value || "")
      .split(/\s*(?:&|\/| and )\s*/i)
      .map((part) => cleanValue(part))
      .filter(Boolean)
      .slice(0, 2);

    return pieces.map((piece) => {
      const words = piece.split(/\s+/).filter(Boolean);
      if (words.length <= 1) {
        return { first: piece, last: "" };
      }
      return {
        first: words.slice(0, -1).join(" "),
        last: words.slice(-1).join("")
      };
    });
  }

  function applyLegacyParentNames(row) {
    if (!cleanValue(row.legacy_parent_names)) return row;
    const [one, two] = legacyParentParts(row.legacy_parent_names);
    if (one) {
      row.parent_one_first_name = row.parent_one_first_name || one.first;
      row.parent_one_last_name = row.parent_one_last_name || one.last;
    }
    if (two) {
      row.parent_two_first_name = row.parent_two_first_name || two.first;
      row.parent_two_last_name = row.parent_two_last_name || two.last;
    }
    return row;
  }

  function canonicalImportRow(sourceRowNumber, values) {
    const row = {
      row_number: sourceRowNumber,
      skipped: false,
      errors: [],
      planned_action: "",
      carpool_number: cleanValue(values.carpool_number),
      student_first_name: cleanValue(values.student_first_name),
      student_last_name: cleanValue(values.student_last_name),
      class_name: cleanValue(values.class_name),
      grade: cleanValue(values.grade),
      parent_one_title: cleanValue(values.parent_one_title),
      parent_one_first_name: cleanValue(values.parent_one_first_name),
      parent_one_last_name: cleanValue(values.parent_one_last_name),
      parent_two_title: cleanValue(values.parent_two_title),
      parent_two_first_name: cleanValue(values.parent_two_first_name),
      parent_two_last_name: cleanValue(values.parent_two_last_name),
      notification_email: cleanValue(values.notification_email),
      notification_enabled: cleanValue(values.notification_enabled),
      legacy_parent_names: cleanValue(values.legacy_parent_names)
    };
    return applyLegacyParentNames(row);
  }

  function expectedHeader(field) {
    return field.replaceAll("_", " ");
  }

  function familyFieldsFromRow(row, options = {}) {
    const includeBlankNotification = Boolean(options.includeBlankNotification);
    const fields = {
      parent_one_title: row.parent_one_title,
      parent_one_first_name: row.parent_one_first_name,
      parent_one_last_name: row.parent_one_last_name,
      parent_two_title: row.parent_two_title,
      parent_two_first_name: row.parent_two_first_name,
      parent_two_last_name: row.parent_two_last_name
    };
    if (includeBlankNotification || cleanValue(row.notification_email)) {
      fields.notification_email = cleanValue(row.notification_email) || null;
    }
    if (includeBlankNotification || cleanValue(row.notification_enabled)) {
      fields.notification_enabled = notificationEnabledFromValue(row.notification_enabled, true);
    }
    return fields;
  }

  function hydrateFamily(family) {
    return {
      ...family,
      display_name: familyDisplayName(family)
    };
  }

  function hydrateStudent(student) {
    const family = student.families ? hydrateFamily(student.families) : null;
    return {
      ...student,
      families: family
    };
  }

  function editIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path>
    </svg>`;
  }

  function trashIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M19 6l-1 14H6L5 6"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
    </svg>`;
  }

  function bellIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M15 17H9"></path>
      <path d="M10 21h4"></path>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"></path>
    </svg>`;
  }

  function editActionButton(datasetAttr, value, label) {
    return `<button class="icon-action-btn" type="button" ${datasetAttr}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
      ${editIconSvg()}
    </button>`;
  }

  function deleteActionButton(datasetAttr, value, label) {
    return `<button class="icon-action-btn danger" type="button" ${datasetAttr}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
      ${trashIconSvg()}
    </button>`;
  }

  function bellActionButton(datasetAttr, value, label) {
    return `<button class="icon-action-btn" type="button" ${datasetAttr}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
      ${bellIconSvg()}
    </button>`;
  }

  function formatDateLabel(value) {
    if (!value || value === PERMANENT_END_DATE) return "Permanent";
    return value;
  }

  function authorizationStudentIds(authId) {
    return state.pickupAuthorizationStudents
      .filter((row) => row.authorization_id === authId)
      .map((row) => row.student_id);
  }

  function presetStudentIds(presetId) {
    return state.carpoolPresetStudents
      .filter((row) => row.preset_id === presetId)
      .map((row) => row.student_id);
  }

  function studentsForFamily(familyId) {
    return state.students
      .filter((student) => student.family_id === familyId)
      .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
  }

  function authorizationIsActive(auth) {
    return !auth.is_revoked && state.today >= auth.starts_on && state.today <= auth.ends_on;
  }

  function eligiblePresetStudents(ownerFamilyId) {
    const studentById = new Map(state.students.map((student) => [student.id, student]));
    const familyById = new Map(state.families.map((family) => [family.id, family]));
    const eligible = new Map();

    studentsForFamily(ownerFamilyId).forEach((student) => {
      eligible.set(student.id, {
        student,
        sourceFamily: familyById.get(ownerFamilyId),
        sourceLabel: "Own Student"
      });
    });

    state.pickupAuthorizations
      .filter((auth) => auth.receiving_family_id === ownerFamilyId && authorizationIsActive(auth))
      .forEach((auth) => {
        authorizationStudentIds(auth.id).forEach((studentId) => {
          const student = studentById.get(studentId);
          if (!student) return;
          eligible.set(student.id, {
            student,
            sourceFamily: familyById.get(student.family_id),
            sourceLabel: "Authorized Pickup"
          });
        });
      });

    return Array.from(eligible.values()).sort((a, b) =>
      a.student.last_name.localeCompare(b.student.last_name) || a.student.first_name.localeCompare(b.student.first_name)
    );
  }

  function sortedBy(arr, col, dir, valFn) {
    if (!col) return arr;
    return [...arr].sort((a, b) => {
      const va = valFn(a);
      const vb = valFn(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return dir === "asc" ? cmp : -cmp;
    });
  }

  function dailyStatusMap() {
    return new Map(state.dailyStatus.map((row) => [row.student_id, row]));
  }

  function fitStudentGrid(panel, grid, cardSelector) {
    if (!panel || !grid) return;

    const cards = Array.from(grid.querySelectorAll(cardSelector));
    if (!panel.classList.contains("is-fullscreen") || !cards.length) {
      grid.classList.remove("is-fitting");
      panel.style.removeProperty("--fit-grid-columns");
      panel.style.removeProperty("--fit-grid-gap");
      panel.style.removeProperty("--fit-card-height");
      panel.style.removeProperty("--fit-card-padding");
      panel.style.removeProperty("--fit-card-radius");
      panel.style.removeProperty("--fit-card-font-size");
      panel.style.removeProperty("--fit-panel-padding");
      return;
    }

    const rect = grid.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const count = cards.length;
    let best = { columns: 1, rows: count, cardWidth: width, cardHeight: height / count, score: 0 };

    for (let columns = 1; columns <= count; columns += 1) {
      const rows = Math.ceil(count / columns);
      const gap = Math.max(4, Math.min(12, Math.min(width, height) * 0.012));
      const cardWidth = (width - gap * (columns - 1)) / columns;
      const cardHeight = (height - gap * (rows - 1)) / rows;
      const score = Math.min(cardWidth / 2.8, cardHeight);
      if (cardWidth > 34 && cardHeight > 24 && score > best.score) {
        best = { columns, rows, cardWidth, cardHeight, gap, score };
      }
    }

    const sizeBase = Math.min(best.cardHeight * 0.34, best.cardWidth / 11);
    const fontSize = Math.max(0.54, Math.min(1.18, sizeBase / 16));
    const paddingY = Math.max(2, Math.min(10, best.cardHeight * 0.1));
    const paddingX = Math.max(3, Math.min(12, best.cardWidth * 0.06));
    const radius = Math.max(5, Math.min(14, Math.min(best.cardHeight, best.cardWidth) * 0.08));

    panel.style.setProperty("--fit-grid-columns", `repeat(${best.columns}, minmax(0, 1fr))`);
    panel.style.setProperty("--fit-grid-gap", `${best.gap}px`);
    panel.style.setProperty("--fit-card-height", `${Math.max(24, best.cardHeight)}px`);
    panel.style.setProperty("--fit-card-padding", `${paddingY}px ${paddingX}px`);
    panel.style.setProperty("--fit-card-radius", `${radius}px`);
    panel.style.setProperty("--fit-card-font-size", `${fontSize}rem`);
    panel.style.setProperty("--fit-panel-padding", `${Math.max(8, Math.min(16, best.gap * 1.25))}px`);
    grid.classList.add("is-fitting");
  }

  function scheduleTodayGridFit() {
    if (state.todayGridFitTimer) window.cancelAnimationFrame(state.todayGridFitTimer);
    state.todayGridFitTimer = window.requestAnimationFrame(() => {
      state.todayGridFitTimer = null;
      fitStudentGrid(el("today-student-grid-card"), el("today-student-grid"), ".all-students-card");
    });
  }

  function setTodayGridFullscreen(enabled, options = {}) {
    const panel = el("today-student-grid-card");
    const button = el("today-grid-fullscreen-btn");
    if (!panel) return;

    state.todayGridFullscreen = enabled;
    panel.classList.toggle("is-fullscreen", enabled);
    document.body.classList.toggle("grid-fullscreen-active", enabled);

    if (button) {
      button.textContent = enabled ? "Exit Full Screen" : "Full Screen";
      button.setAttribute("aria-pressed", String(enabled));
    }

    if (enabled) {
      if (!options.skipNative && panel.requestFullscreen && document.fullscreenElement !== panel) {
        panel.requestFullscreen().catch(() => {});
      }
      scheduleTodayGridFit();
      window.setTimeout(scheduleTodayGridFit, 80);
      return;
    }

    if (!options.skipNative && document.fullscreenElement === panel && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    scheduleTodayGridFit();
  }

  async function setTodayStudentStatus(studentId, status) {
    const client = mustClient();
    const isCalled = status === "CALLED";
    const checkedInBy = isCalled ? await currentActorLabel(client, "Admin") : null;
    const payload = [{
      student_id: studentId,
      date: state.today,
      status,
      called_at: isCalled ? new Date().toISOString() : null,
      called_by: isCalled ? "admin" : null,
      checked_in_by: checkedInBy,
      pickup_family_id: null,
      pickup_family_label: null
    }];

    const { error } = await client.from("daily_status").upsert(payload, { onConflict: "student_id,date" });
    if (error) throw error;
    return checkedInBy;
  }

  function applyTodayStatusLocally(studentId, status, checkedInBy) {
    const isCalled = status === "CALLED";
    const nextRecord = {
      student_id: studentId,
      date: state.today,
      status,
      called_at: isCalled ? new Date().toISOString() : null,
      called_by: isCalled ? "admin" : null,
      checked_in_by: isCalled ? (checkedInBy || "Admin") : null,
      pickup_family_id: null,
      pickup_family_label: null
    };
    const existingIndex = state.dailyStatus.findIndex((row) => row.student_id === studentId && row.date === state.today);
    if (existingIndex >= 0) {
      state.dailyStatus[existingIndex] = {
        ...state.dailyStatus[existingIndex],
        ...nextRecord
      };
    } else {
      state.dailyStatus.unshift(nextRecord);
    }
  }

  async function toggleTodayStudentStatus(studentId) {
    const current = dailyStatusMap().get(studentId);
    const nextStatus = current && current.status === "CALLED" ? "WAITING" : "CALLED";
    const checkedInBy = await setTodayStudentStatus(studentId, nextStatus);
    applyTodayStatusLocally(studentId, nextStatus, checkedInBy);
    renderToday();
  }

  async function repingTodayStudent(studentId) {
    const checkedInBy = await setTodayStudentStatus(studentId, "CALLED");
    applyTodayStatusLocally(studentId, "CALLED", checkedInBy);
    renderToday();
  }

  function formatAttemptTime(value) {
    return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
  }

  function todayAttemptMatchesSearch({ rec, stu }) {
    const query = normalizeText(state.todayAttemptSearch);
    if (!query) return true;

    const family = stu && stu.families ? stu.families : null;
    const haystack = normalizeText([
      formatAttemptTime(rec.called_at),
      stu ? studentLabel(stu) : "Unknown student",
      stu ? `${stu.first_name} ${stu.last_name}` : "",
      stu && stu.classes ? stu.classes.name : "",
      family ? familyDisplayName(family) : "",
      family ? family.carpool_number : "",
      rec.status,
      checkInSourceLabel(rec)
    ].join(" "));

    return query.split(" ").every((term) => haystack.includes(term));
  }

  function applySortHeaders(tableId, col, dir) {
    const table = el(tableId);
    if (!table) return;
    table.querySelectorAll("th[data-sort]").forEach(th => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === col) {
        th.classList.add(dir === "asc" ? "sort-asc" : "sort-desc");
      }
    });
  }

  async function fetchAll() {
    const client = mustClient();
    const [classesRes, familiesRes, studentsRes, dailyStatusRes] = await Promise.all([
      client.from("classes").select("id,name,display_order").order("display_order", { ascending: true }),
      client
        .from("families")
        .select("id,carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,contact_info,notification_email,notification_enabled")
        .order("carpool_number", { ascending: true }),
      client
        .from("students")
        .select("id,first_name,last_name,class_id,family_id,classes(name),families(carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name)")
        .order("last_name", { ascending: true }),
      client
        .from("daily_status")
        .select("id,student_id,status,called_at,called_by,checked_in_by,date")
        .eq("date", state.today)
        .order("called_at", { ascending: false })
    ]);

    const [pickupAuthRes, pickupAuthStudentsRes, pickupAuditRes, presetsRes, presetStudentsRes] = await Promise.all([
      client.from("pickup_authorizations").select("*").order("created_at", { ascending: false }),
      client.from("pickup_authorization_students").select("*"),
      client.from("pickup_authorization_audit").select("*").order("created_at", { ascending: false }),
      client.from("carpool_presets").select("*").order("created_at", { ascending: false }),
      client.from("carpool_preset_students").select("*")
    ]);

    if (classesRes.error) throw classesRes.error;
    if (familiesRes.error) throw familiesRes.error;
    if (studentsRes.error) throw studentsRes.error;
    if (dailyStatusRes.error) throw dailyStatusRes.error;
    if (pickupAuthRes.error) throw pickupAuthRes.error;
    if (pickupAuthStudentsRes.error) throw pickupAuthStudentsRes.error;
    if (pickupAuditRes.error) throw pickupAuditRes.error;
    if (presetsRes.error) throw presetsRes.error;
    if (presetStudentsRes.error) throw presetStudentsRes.error;

    state.classes = classesRes.data || [];
    state.families = (familiesRes.data || []).map(hydrateFamily);
    state.students = (studentsRes.data || []).map(hydrateStudent);
    state.dailyStatus = dailyStatusRes.data || [];
    state.pickupAuthorizations = pickupAuthRes.data || [];
    state.pickupAuthorizationStudents = pickupAuthStudentsRes.data || [];
    state.pickupAuthorizationAudit = pickupAuditRes.data || [];
    state.carpoolPresets = presetsRes.data || [];
    state.carpoolPresetStudents = presetStudentsRes.data || [];
  }

  function setTab(nextTab) {
    state.currentTab = nextTab;

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === nextTab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.tabPanel !== nextTab);
    });
  }

  function renderFamilies() {
    const byFamily = new Map();
    state.students.forEach((s) => {
      const arr = byFamily.get(s.family_id) || [];
      arr.push(`${s.first_name} ${s.last_name}`);
      byFamily.set(s.family_id, arr);
    });

    const { col, dir } = sortState.families;
    const valFn = (f) => {
      if (col === "carpool") return f.carpool_number;
      if (col === "parents") return familyDisplayName(f);
      if (col === "contact") return f.contact_info || "";
      if (col === "notification") return f.notification_email || "";
      if (col === "students") return (byFamily.get(f.id) || []).length;
      return 0;
    };
    const sorted = sortedBy(state.families, col, dir, valFn);

    const html = sorted
      .map((f) => {
        const students = byFamily.get(f.id) || [];
        return `<tr>
          <td>${escapeHtml(String(f.carpool_number))}</td>
          <td>${escapeHtml(familyDisplayName(f))}</td>
          <td>${escapeHtml(f.contact_info || "")}</td>
          <td>${escapeHtml(f.notification_enabled === false ? "Off" : (f.notification_email || "On, no email"))}</td>
          <td>${escapeHtml(students.join(", "))}</td>
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-family", f.id, "Edit family")}
              ${deleteActionButton("data-delete-family", f.id, "Delete family")}
            </div>
          </td>
        </tr>`;
      })
      .join("");

    el("families-tbody").innerHTML = html || '<tr><td colspan="6" class="muted">No families yet.</td></tr>';
    applySortHeaders("families-table", col, dir);
  }

  function renderClasses() {
    const counts = new Map();
    const studentsByClass = new Map();
    state.students.forEach((s) => {
      counts.set(s.class_id, (counts.get(s.class_id) || 0) + 1);
      const arr = studentsByClass.get(s.class_id) || [];
      arr.push(s);
      studentsByClass.set(s.class_id, arr);
    });

    const { col, dir } = sortState.classes;
    const valFn = (c) => {
      if (col === "name") return c.name;
      if (col === "order") return c.display_order;
      if (col === "count") return counts.get(c.id) || 0;
      return 0;
    };
    const sorted = sortedBy(state.classes, col, dir, valFn);

    const html = sorted
      .map((c) => {
        const count = counts.get(c.id) || 0;
        const classStudents = (studentsByClass.get(c.id) || [])
          .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
        const studentRows = classStudents
          .map(s => `<tr class="student-subrow">
            <td>${escapeHtml(studentLabel(s))}</td>
            <td>${escapeHtml(s.families ? String(s.families.carpool_number) : "")}</td>
          </tr>`)
          .join("");

        return `<tr class="class-row" data-class-id="${escapeHtml(c.id)}">
          <td class="chevron-cell">
            <button class="chevron-btn" aria-label="Expand students" aria-expanded="false">&#8250;</button>
          </td>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(String(c.display_order))}</td>
          <td>${escapeHtml(String(count))}</td>
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-class", c.id, "Edit class")}
              ${deleteActionButton("data-delete-class", c.id, "Delete class")}
            </div>
          </td>
        </tr>
        <tr class="class-detail-row hidden" data-detail-for="${escapeHtml(c.id)}">
          <td></td>
          <td colspan="4">
            <table class="detail-table">
              <thead><tr><th>Student</th><th>Family #</th></tr></thead>
              <tbody>${studentRows || '<tr><td colspan="2" class="muted">No students in this class.</td></tr>'}</tbody>
            </table>
          </td>
        </tr>`;
      })
      .join("");

    el("classes-tbody").innerHTML = html || '<tr><td colspan="5" class="muted">No classes yet.</td></tr>';
    applySortHeaders("classes-table", col, dir);

    el("classes-tbody").querySelectorAll(".chevron-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = btn.closest("tr");
        const classId = row.dataset.classId;
        const detailRow = el("classes-tbody").querySelector(`[data-detail-for="${classId}"]`);
        if (!detailRow) return;
        const expanded = !detailRow.classList.contains("hidden");
        detailRow.classList.toggle("hidden", expanded);
        btn.setAttribute("aria-expanded", String(!expanded));
        btn.classList.toggle("open", !expanded);
      });
    });
  }

  function renderStudents() {
    const { col, dir } = sortState.students;
    const valFn = (s) => {
      if (col === "name") return `${s.last_name} ${s.first_name}`;
      if (col === "class") return s.classes ? s.classes.name : "";
      if (col === "family") return s.families ? familyDisplayName(s.families) : "";
      if (col === "carpool") return s.families ? s.families.carpool_number : 0;
      return "";
    };
    const sorted = sortedBy(state.students, col, dir, valFn);

    const html = sorted
      .map((s) => {
        return `<tr>
          <td>${escapeHtml(studentLabel(s))}</td>
          <td>${escapeHtml(s.classes ? s.classes.name : "")}</td>
          <td>${escapeHtml(s.families ? familyDisplayName(s.families) : "")}</td>
          <td>${escapeHtml(s.families ? String(s.families.carpool_number) : "")}</td>
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-student", s.id, "Edit student")}
              ${deleteActionButton("data-delete-student", s.id, "Delete student")}
            </div>
          </td>
        </tr>`;
      })
      .join("");

    el("students-tbody").innerHTML = html || '<tr><td colspan="5" class="muted">No students yet.</td></tr>';
    applySortHeaders("students-table", col, dir);
  }

  function renderToday() {
    const calledRows = state.dailyStatus.filter((s) => s.status === "CALLED");
    const parentRows = state.dailyStatus.filter((s) => (s.called_by || "").toLowerCase() === "parent");
    const calledIds = new Set(calledRows.map((s) => s.student_id));
    const waiting = state.students.length - calledIds.size;

    el("today-attempts-count").textContent = String(state.dailyStatus.length);
    el("today-dismissed-count").textContent = String(calledRows.length);
    el("today-waiting-count").textContent = String(Math.max(waiting, 0));
    el("today-parent-count").textContent = String(parentRows.length);

    const byId = new Map(state.students.map((s) => [s.id, s]));
    const enriched = state.dailyStatus.map((rec) => ({ rec, stu: byId.get(rec.student_id) }));

    const { col, dir } = sortState.today;
    const valFn = ({ rec, stu }) => {
      if (col === "time") return rec.called_at || "";
      if (col === "student") return stu ? `${stu.last_name} ${stu.first_name}` : "";
      if (col === "class") return stu && stu.classes ? stu.classes.name : "";
      if (col === "family") return stu && stu.families ? familyDisplayName(stu.families) : "";
      if (col === "carpool") return stu && stu.families ? stu.families.carpool_number : 0;
      if (col === "status") return rec.status || "";
      if (col === "source") return checkInSourceLabel(rec);
      return "";
    };
    const visible = enriched.filter(todayAttemptMatchesSearch);
    const sorted = sortedBy(visible, col, dir, valFn);
    const visibleCount = el("today-attempts-visible-count");
    if (visibleCount) {
      const searchActive = Boolean(normalizeText(state.todayAttemptSearch));
      visibleCount.textContent = searchActive
        ? `${visible.length} of ${enriched.length} shown`
        : `${enriched.length} shown`;
    }

    const rows = sorted
      .map(({ rec, stu }) => {
        const time = formatAttemptTime(rec.called_at);
        const statusClass = rec.status === "CALLED" ? "status status-called" : "status status-waiting";
        return `<tr>
          <td>${escapeHtml(time)}</td>
          <td>${escapeHtml(stu ? studentLabel(stu) : "Unknown student")}</td>
          <td>${escapeHtml(stu && stu.classes ? stu.classes.name : "")}</td>
          <td>${escapeHtml(stu && stu.families ? familyDisplayName(stu.families) : "")}</td>
          <td>${escapeHtml(stu && stu.families ? String(stu.families.carpool_number) : "")}</td>
          <td><span class="${statusClass}${stu ? " is-toggle" : ""}" ${stu ? `data-today-student-id="${escapeHtml(stu.id)}"` : ""}>${escapeHtml(rec.status)}</span></td>
          <td>${escapeHtml(checkInSourceLabel(rec))}</td>
          <td>${stu ? bellActionButton("data-reping-student", stu.id, rec.status === "CALLED" ? "Reping student" : "Call student") : "-"}</td>
        </tr>`;
      })
      .join("");

    const emptyMessage = state.dailyStatus.length
      ? "No attempts match your search."
      : "No dismissal attempts yet today.";
    el("today-attempts-tbody").innerHTML = rows || `<tr><td colspan="8" class="muted">${emptyMessage}</td></tr>`;
    applySortHeaders("today-table", col, dir);
    renderTodayStudentGrid();
  }

  function renderTodayStudentGrid() {
    const statusByStudent = dailyStatusMap();
    const classOrder = new Map(state.classes.map((cls, index) => [cls.id, cls.display_order ?? index]));
    const students = [...state.students].sort((a, b) => {
      const classCmp = (classOrder.get(a.class_id) || 0) - (classOrder.get(b.class_id) || 0);
      if (classCmp !== 0) return classCmp;
      const lastCmp = a.last_name.localeCompare(b.last_name);
      return lastCmp !== 0 ? lastCmp : a.first_name.localeCompare(b.first_name);
    });
    const visibleStudents = state.todayGridWaitingOnly
      ? students.filter((student) => {
        const rec = statusByStudent.get(student.id);
        return !rec || rec.status !== "CALLED";
      })
      : students;
    const count = el("today-student-grid-count");
    if (count) {
      count.textContent = state.todayGridWaitingOnly
        ? `${visibleStudents.length} waiting of ${students.length}`
        : `${students.length} students`;
    }

    const html = visibleStudents
      .map((student) => {
        const rec = statusByStudent.get(student.id);
        const status = rec ? rec.status : "WAITING";
        const cardClass = status === "CALLED" ? "all-students-card called" : "all-students-card";
        const className = student.classes ? student.classes.name : "";
        return `<div class="${cardClass}" data-today-grid-student-id="${escapeHtml(student.id)}">
          <div class="all-students-name-line">
            <span class="all-students-name">${escapeHtml(student.first_name)} ${escapeHtml(student.last_name)}</span>
            <span class="all-students-meta">${escapeHtml(className)}</span>
          </div>
        </div>`;
      })
      .join("");

    el("today-student-grid").innerHTML = html || `<p class="muted">${state.todayGridWaitingOnly ? "Everyone has been called." : "No students yet."}</p>`;
    scheduleTodayGridFit();
  }

  function renderAll() {
    renderToday();
    renderFamilies();
    renderClasses();
    renderStudents();
    renderPermissions();
    renderImportPreview();
  }

  function renderPermissions() {
    const familyById = new Map(state.families.map((family) => [family.id, family]));
    const studentById = new Map(state.students.map((student) => [student.id, student]));
    const studentsByAuthorization = new Map();
    const studentsByPreset = new Map();

    state.pickupAuthorizationStudents.forEach((row) => {
      const list = studentsByAuthorization.get(row.authorization_id) || [];
      const student = studentById.get(row.student_id);
      if (student) list.push(student);
      studentsByAuthorization.set(row.authorization_id, list);
    });

    state.carpoolPresetStudents.forEach((row) => {
      const list = studentsByPreset.get(row.preset_id) || [];
      const student = studentById.get(row.student_id);
      if (student) list.push(student);
      studentsByPreset.set(row.preset_id, list);
    });

    const { col: permissionsCol, dir: permissionsDir } = sortState.permissions;
    const sortedPermissions = sortedBy(state.pickupAuthorizations, permissionsCol, permissionsDir, (auth) => {
      const granting = familyById.get(auth.granting_family_id);
      const receiving = familyById.get(auth.receiving_family_id);
      const students = (studentsByAuthorization.get(auth.id) || [])
        .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
        .map((student) => `${student.first_name} ${student.last_name}`)
        .join(", ");
      let status = "Active";
      if (auth.is_revoked) status = "Revoked";
      else if (state.today < auth.starts_on) status = "Upcoming";
      else if (state.today > auth.ends_on) status = "Expired";

      if (permissionsCol === "granting") return granting ? familyLabel(granting) : "";
      if (permissionsCol === "receiving") return receiving ? familyLabel(receiving) : "";
      if (permissionsCol === "students") return students;
      if (permissionsCol === "start") return auth.starts_on || "";
      if (permissionsCol === "end") return auth.ends_on || "";
      if (permissionsCol === "status") return status;
      return "";
    });

    const authRows = sortedPermissions
      .map((auth) => {
        const granting = familyById.get(auth.granting_family_id);
        const receiving = familyById.get(auth.receiving_family_id);
        const students = (studentsByAuthorization.get(auth.id) || [])
          .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
          .map((student) => `${student.first_name} ${student.last_name}`)
          .join(", ");
        let status = "Active";
        if (auth.is_revoked) status = "Revoked";
        else if (state.today < auth.starts_on) status = "Upcoming";
        else if (state.today > auth.ends_on) status = "Expired";
        const actionsCell = auth.is_revoked
          ? '<td class="muted">-</td>'
          : `<td>
              <div class="permissions-actions">
                ${editActionButton("data-edit-auth", auth.id, "Edit permission")}
                ${deleteActionButton("data-revoke-auth", auth.id, "Revoke permission")}
              </div>
            </td>`;

        return `<tr>
          <td>${escapeHtml(granting ? familyLabel(granting) : "Unknown")}</td>
          <td>${escapeHtml(receiving ? familyLabel(receiving) : "Unknown")}</td>
          <td>${escapeHtml(students)}</td>
          <td>${escapeHtml(formatDateLabel(auth.starts_on || ""))}</td>
          <td>${escapeHtml(formatDateLabel(auth.ends_on || ""))}</td>
          <td>${escapeHtml(status)}</td>
          ${actionsCell}
        </tr>`;
      })
      .join("");

    el("permissions-tbody").innerHTML = authRows || '<tr><td colspan="7" class="muted">No permissions yet.</td></tr>';
    applySortHeaders("permissions-table", permissionsCol, permissionsDir);

    const { col: presetsCol, dir: presetsDir } = sortState.presets;
    const sortedPresets = sortedBy(state.carpoolPresets, presetsCol, presetsDir, (preset) => {
      const owner = familyById.get(preset.owner_family_id);
      const students = (studentsByPreset.get(preset.id) || [])
        .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
        .map((student) => `${student.first_name} ${student.last_name}`)
        .join(", ");

      if (presetsCol === "owner") return owner ? familyLabel(owner) : "";
      if (presetsCol === "name") return preset.name || "";
      if (presetsCol === "days") return formatWeekdays(preset.weekdays || []);
      if (presetsCol === "students") return students;
      return "";
    });

    const presetRows = sortedPresets
      .map((preset) => {
        const owner = familyById.get(preset.owner_family_id);
        const students = (studentsByPreset.get(preset.id) || [])
          .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
          .map((student) => `${student.first_name} ${student.last_name}`)
          .join(", ");

        return `<tr>
          <td>${escapeHtml(owner ? familyLabel(owner) : "Unknown")}</td>
          <td>${escapeHtml(preset.name || "")}</td>
          <td>${escapeHtml(formatWeekdays(preset.weekdays || [], true))}</td>
          <td>${escapeHtml(students || "No students")}</td>
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-preset", preset.id, "Edit saved carpool")}
              ${deleteActionButton("data-delete-preset", preset.id, "Delete saved carpool")}
            </div>
          </td>
        </tr>`;
      })
      .join("");

    el("presets-tbody").innerHTML = presetRows || '<tr><td colspan="5" class="muted">No saved carpools yet.</td></tr>';
    applySortHeaders("presets-table", presetsCol, presetsDir);

    const auditRows = state.pickupAuthorizationAudit
      .map((audit) => {
        const granting = familyById.get(audit.granting_family_id);
        const receiving = familyById.get(audit.receiving_family_id);
        const names = (audit.student_ids || [])
          .map((studentId) => studentById.get(studentId))
          .filter(Boolean)
          .map((student) => `${student.first_name} ${student.last_name}`)
          .join(", ");
        const timestamp = audit.created_at ? new Date(audit.created_at).toLocaleString() : "";
        return `<tr>
          <td>${escapeHtml(timestamp)}</td>
          <td>${escapeHtml(audit.action || "")}</td>
          <td>${escapeHtml(granting ? familyLabel(granting) : "Unknown")}</td>
          <td>${escapeHtml(receiving ? familyLabel(receiving) : "Unknown")}</td>
          <td>${escapeHtml(names)}</td>
          <td>${escapeHtml(formatDateLabel(audit.starts_on || ""))} to ${escapeHtml(formatDateLabel(audit.ends_on || ""))}</td>
          <td>${escapeHtml(audit.actor_type || "")}</td>
        </tr>`;
      })
      .join("");

    el("permissions-audit-tbody").innerHTML = auditRows || '<tr><td colspan="7" class="muted">No audit events yet.</td></tr>';
  }

  function permissionStudentPickerHtml(grantingFamilyId, selectedIds) {
    if (!grantingFamilyId) {
      return '<p class="muted">Choose a granting family first.</p>';
    }

    const students = studentsForFamily(grantingFamilyId);
    if (!students.length) {
      return '<p class="muted">This family has no students.</p>';
    }

    return students.map((student) => {
      const checked = selectedIds.includes(student.id) ? "checked" : "";
      const className = student.classes ? student.classes.name : "";
      return `<label class="checkbox-option">
        <input type="checkbox" data-permission-student value="${escapeHtml(student.id)}" ${checked} />
        <span class="checkbox-option-row">
          <span class="checkbox-option-main">
            <span class="checkbox-option-toggle" aria-hidden="true"></span>
            <span class="checkbox-option-copy">
              <span class="checkbox-option-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
              ${className ? `<span class="checkbox-option-meta">${escapeHtml(className)}</span>` : ""}
            </span>
          </span>
        </span>
      </label>`;
    }).join("");
  }

  function presetStudentPickerHtml(ownerFamilyId, selectedIds) {
    if (!ownerFamilyId) {
      return '<p class="muted">Choose an owner family first.</p>';
    }

    const options = eligiblePresetStudents(ownerFamilyId);
    if (!options.length) {
      return '<p class="muted">No currently eligible students are available for this family.</p>';
    }

    return options.map(({ student, sourceFamily, sourceLabel }) => {
      const checked = selectedIds.includes(student.id) ? "checked" : "";
      const familyText = sourceFamily ? familyLabel(sourceFamily) : "Unknown family";
      const className = student.classes ? student.classes.name : "";
      return `<label class="checkbox-option">
        <input type="checkbox" data-preset-student value="${escapeHtml(student.id)}" ${checked} />
        <span class="checkbox-option-row">
          <span class="checkbox-option-main">
            <span class="checkbox-option-toggle" aria-hidden="true"></span>
            <span class="checkbox-option-copy">
              <span class="checkbox-option-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
              <span class="checkbox-option-meta">${escapeHtml(`${className} | ${sourceLabel} | ${familyText}`)}</span>
            </span>
          </span>
        </span>
      </label>`;
    }).join("");
  }

  function refreshPermissionModalStudents(selectedIds) {
    const container = el("modal-permission-students");
    const grantingFamilyId = el("modal-permission-granting") ? el("modal-permission-granting").value : "";
    if (!container) return;
    container.innerHTML = permissionStudentPickerHtml(grantingFamilyId, selectedIds || []);
  }

  function refreshPresetModalStudents(selectedIds) {
    const container = el("modal-preset-students");
    const ownerFamilyId = el("modal-preset-owner") ? el("modal-preset-owner").value : "";
    if (!container) return;
    container.innerHTML = presetStudentPickerHtml(ownerFamilyId, selectedIds || []);
  }

  async function refreshAndRender() {
    await fetchAll();
    renderAll();
  }

  function scheduleRefresh() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      refreshAndRender().catch(() => {});
    }, 250);
  }

  function startRealtime() {
    const client = mustClient();
    state.channel = client
      .channel("admin-daily-status")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_status" }, (payload) => {
        const record = payload.new || payload.old;
        if (!record || record.date !== state.today) return;
        scheduleRefresh();
      })
      .subscribe();
  }

  function modalFieldTemplate(kind, data) {
    if (kind === "family") {
      return `
        <div class="form-row">
          <label for="modal-family-number">Family #</label>
          <input id="modal-family-number" type="number" value="${escapeHtml(String(data?.carpool_number || ""))}" required />
        </div>
        <div class="form-row">
          <label for="modal-parent-one-title">Parent 1 Title</label>
          <input id="modal-parent-one-title" type="text" value="${escapeHtml(data?.parent_one_title || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-one-first">Parent 1 First Name</label>
          <input id="modal-parent-one-first" type="text" value="${escapeHtml(data?.parent_one_first_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-one-last">Parent 1 Last Name</label>
          <input id="modal-parent-one-last" type="text" value="${escapeHtml(data?.parent_one_last_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-two-title">Parent 2 Title</label>
          <input id="modal-parent-two-title" type="text" value="${escapeHtml(data?.parent_two_title || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-two-first">Parent 2 First Name</label>
          <input id="modal-parent-two-first" type="text" value="${escapeHtml(data?.parent_two_first_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-two-last">Parent 2 Last Name</label>
          <input id="modal-parent-two-last" type="text" value="${escapeHtml(data?.parent_two_last_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-family-contact">Contact info (optional)</label>
          <input id="modal-family-contact" type="text" value="${escapeHtml(data?.contact_info || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-family-notification-email">Alert email (optional)</label>
          <input id="modal-family-notification-email" type="email" value="${escapeHtml(data?.notification_email || "")}" />
        </div>
        <label class="modal-toggle" for="modal-family-notification-enabled">
          <input id="modal-family-notification-enabled" type="checkbox" ${data?.notification_enabled === false ? "" : "checked"} />
          <span>Send pickup permission email alerts</span>
        </label>
      `;
    }

    if (kind === "class") {
      return `
        <div class="form-row">
          <label for="modal-class-name">Class name</label>
          <input id="modal-class-name" type="text" value="${escapeHtml(data?.name || "")}" required />
        </div>
        <div class="form-row">
          <label for="modal-class-order">Display order</label>
          <input id="modal-class-order" type="number" value="${escapeHtml(String(data?.display_order ?? ""))}" />
        </div>
      `;
    }

    if (kind === "student") {
      const familyOptions = state.families
        .map((f) => {
          const selected = data && data.family_id === f.id ? "selected" : "";
          return `<option value="${escapeHtml(f.id)}" ${selected}>${escapeHtml(familyLabel(f))}</option>`;
        })
        .join("");

      const classOptions = [...state.classes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => {
          const selected = data && data.class_id === c.id ? "selected" : "";
          return `<option value="${escapeHtml(c.id)}" ${selected}>${escapeHtml(classLabel(c))}</option>`;
        })
        .join("");

      return `
        <div class="form-row">
          <label for="modal-student-first">First name</label>
          <input id="modal-student-first" type="text" value="${escapeHtml(data?.first_name || "")}" required />
        </div>
        <div class="form-row">
          <label for="modal-student-last">Last name</label>
          <input id="modal-student-last" type="text" value="${escapeHtml(data?.last_name || "")}" required />
        </div>
        <div class="form-row">
          <label for="modal-student-family">Family</label>
          <select id="modal-student-family" required>
            <option value="">Select family</option>
            ${familyOptions}
          </select>
        </div>
        <div class="form-row">
          <label for="modal-student-class">Class</label>
          <select id="modal-student-class" required>
            <option value="">Select class</option>
            ${classOptions}
          </select>
        </div>
      `;
    }

    if (kind === "permission") {
      const grantingOptions = state.families
        .map((f) => {
          const selected = data && data.granting_family_id === f.id ? "selected" : "";
          return `<option value="${escapeHtml(f.id)}" ${selected}>${escapeHtml(familyLabel(f))}</option>`;
        })
        .join("");

      const receivingOptions = state.families
        .map((f) => {
          const selected = data && data.receiving_family_id === f.id ? "selected" : "";
          const disabled = data && data.granting_family_id === f.id ? "disabled" : "";
          return `<option value="${escapeHtml(f.id)}" ${selected} ${disabled}>${escapeHtml(familyLabel(f))}</option>`;
        })
        .join("");

      return `
        <div class="form-row">
          <label for="modal-permission-granting">Granting Family</label>
          <select id="modal-permission-granting" ${data && data.authorization_id ? "disabled" : ""} required>
            <option value="">Select family</option>
            ${grantingOptions}
          </select>
        </div>
        <div class="form-row">
          <label for="modal-permission-receiving">Receiving Family</label>
          <select id="modal-permission-receiving" ${data && data.authorization_id ? "disabled" : ""} required>
            <option value="">Select family</option>
            ${receivingOptions}
          </select>
        </div>
        <div class="form-row">
          <label>Students</label>
          <div id="modal-permission-students" class="checkbox-list">${permissionStudentPickerHtml(data?.granting_family_id || "", data?.student_ids || [])}</div>
        </div>
        <label class="modal-toggle" for="modal-permission-permanent">
          <input id="modal-permission-permanent" type="checkbox" ${data?.ends_on === PERMANENT_END_DATE ? "checked" : ""} />
          <span>Save this permission permanently</span>
        </label>
        <div class="form-row">
          <label for="modal-permission-start">Start Date</label>
          <input id="modal-permission-start" type="date" value="${escapeHtml(data?.starts_on || state.today)}" required />
        </div>
        <div class="form-row">
          <label for="modal-permission-end">End Date</label>
          <input id="modal-permission-end" type="date" value="${escapeHtml(data?.ends_on === PERMANENT_END_DATE ? "" : (data?.ends_on || state.today))}" required />
        </div>
      `;
    }

    if (kind === "preset") {
      const ownerOptions = state.families
        .map((f) => {
          const selected = data && data.owner_family_id === f.id ? "selected" : "";
          return `<option value="${escapeHtml(f.id)}" ${selected}>${escapeHtml(familyLabel(f))}</option>`;
        })
        .join("");

      return `
        <div class="form-row">
          <label for="modal-preset-owner">Owner Family</label>
          <select id="modal-preset-owner" ${data && data.preset_id ? "disabled" : ""} required>
            <option value="">Select family</option>
            ${ownerOptions}
          </select>
        </div>
        <div class="form-row">
          <label for="modal-preset-name">Saved Carpool Name</label>
          <input id="modal-preset-name" type="text" value="${escapeHtml(data?.name || "")}" required />
        </div>
        <div class="form-row">
          <label>Days of the Week</label>
          <div class="checkbox-list weekday-checkbox-list">${weekdayCheckboxesHtml(data?.weekdays || [])}</div>
        </div>
        <div class="form-row">
          <label>Students</label>
          <div id="modal-preset-students" class="checkbox-list">${presetStudentPickerHtml(data?.owner_family_id || "", data?.student_ids || [])}</div>
        </div>
      `;
    }

    return "";
  }

  function bindModalSpecificUi(mode, data) {
    if (mode === "add-permission" || mode === "edit-permission") {
      const selectedIds = data?.student_ids || [];
      const grantingSelect = el("modal-permission-granting");
      const receivingSelect = el("modal-permission-receiving");
      const permanentToggle = el("modal-permission-permanent");
      if (grantingSelect && !grantingSelect.disabled) {
        grantingSelect.addEventListener("change", () => {
          const currentReceiving = receivingSelect ? receivingSelect.value : "";
          refreshPermissionModalStudents([]);
          if (receivingSelect) {
            Array.from(receivingSelect.options).forEach((option) => {
              if (!option.value) return;
              option.disabled = option.value === grantingSelect.value;
            });
            if (currentReceiving === grantingSelect.value) receivingSelect.value = "";
          }
        });
      }
      if (permanentToggle) {
        permanentToggle.addEventListener("change", syncPermissionPermanentUi);
      }
      syncPermissionPermanentUi();
      refreshPermissionModalStudents(selectedIds);
    }

    if (mode === "add-preset" || mode === "edit-preset") {
      const selectedIds = data?.student_ids || [];
      const ownerSelect = el("modal-preset-owner");
      if (ownerSelect && !ownerSelect.disabled) {
        ownerSelect.addEventListener("change", () => {
          refreshPresetModalStudents([]);
        });
      }
      refreshPresetModalStudents(selectedIds);
    }
  }

  function openModal(mode, entityId) {
    state.modal.mode = mode;
    state.modal.entityId = entityId || null;

    let title = "";
    let submitLabel = "Save";
    let body = "";
    let modalData = null;

    if (mode === "add-family") {
      title = "Add Family";
      submitLabel = "Add Family";
      body = modalFieldTemplate("family");
    } else if (mode === "edit-family") {
      const fam = state.families.find((f) => f.id === entityId);
      if (!fam) return;
      title = "Edit Family";
      submitLabel = "Save Changes";
      body = modalFieldTemplate("family", fam);
    } else if (mode === "add-class") {
      title = "Add Class";
      submitLabel = "Add Class";
      body = modalFieldTemplate("class", { display_order: state.classes.length + 1 });
    } else if (mode === "edit-class") {
      const cls = state.classes.find((c) => c.id === entityId);
      if (!cls) return;
      title = "Edit Class";
      submitLabel = "Save Changes";
      body = modalFieldTemplate("class", cls);
    } else if (mode === "add-student") {
      title = "Add Student";
      submitLabel = "Add Student";
      body = modalFieldTemplate("student");
    } else if (mode === "edit-student") {
      const student = state.students.find((s) => s.id === entityId);
      if (!student) return;
      title = "Edit Student";
      submitLabel = "Save Changes";
      body = modalFieldTemplate("student", student);
    } else if (mode === "add-permission") {
      title = "Add Pickup Permission";
      submitLabel = "Save Permission";
      modalData = { starts_on: state.today, ends_on: state.today, student_ids: [] };
      body = modalFieldTemplate("permission", modalData);
    } else if (mode === "edit-permission") {
      const auth = state.pickupAuthorizations.find((item) => item.id === entityId);
      if (!auth) return;
      title = "Edit Pickup Permission";
      submitLabel = "Save Changes";
      modalData = {
        authorization_id: auth.id,
        granting_family_id: auth.granting_family_id,
        receiving_family_id: auth.receiving_family_id,
        starts_on: auth.starts_on,
        ends_on: auth.ends_on,
        student_ids: authorizationStudentIds(auth.id)
      };
      body = modalFieldTemplate("permission", modalData);
    } else if (mode === "add-preset") {
      title = "Add Saved Carpool";
      submitLabel = "Save Saved Carpool";
      modalData = { student_ids: [] };
      body = modalFieldTemplate("preset", modalData);
    } else if (mode === "edit-preset") {
      const preset = state.carpoolPresets.find((item) => item.id === entityId);
      if (!preset) return;
      title = "Edit Saved Carpool";
      submitLabel = "Save Changes";
      modalData = {
        preset_id: preset.id,
        owner_family_id: preset.owner_family_id,
        name: preset.name,
        weekdays: preset.weekdays || [],
        student_ids: presetStudentIds(preset.id)
      };
      body = modalFieldTemplate("preset", modalData);
    }

    el("admin-modal-title").textContent = title;
    el("admin-modal-submit").textContent = submitLabel;
    el("admin-modal-fields").innerHTML = body;
    setNodeMessage("admin-modal-msg", "");
    show("admin-modal", true);
    bindModalSpecificUi(mode, modalData);
  }

  function closeModal() {
    state.modal.mode = null;
    state.modal.entityId = null;
    show("admin-modal", false);
  }

  async function saveFamily(isEdit) {
    const client = mustClient();
    const carpool = Number(el("modal-family-number").value);
    const contact = el("modal-family-contact").value.trim() || null;
    const payload = familyPayloadFromValues({
      carpool_number: carpool,
      contact_info: contact,
      notification_email: el("modal-family-notification-email").value,
      notification_enabled: el("modal-family-notification-enabled").checked,
      parent_one_title: el("modal-parent-one-title").value,
      parent_one_first_name: el("modal-parent-one-first").value,
      parent_one_last_name: el("modal-parent-one-last").value,
      parent_two_title: el("modal-parent-two-title").value,
      parent_two_first_name: el("modal-parent-two-first").value,
      parent_two_last_name: el("modal-parent-two-last").value
    });
    const hasAnyParentName = [
      payload.parent_one_first_name,
      payload.parent_one_last_name,
      payload.parent_two_first_name,
      payload.parent_two_last_name
    ].some(Boolean);

    if (!carpool || !hasAnyParentName) {
      setNodeMessage("admin-modal-msg", "Family number and at least one parent name are required.", "error");
      return;
    }

    const query = isEdit
      ? client.from("families").update(payload).eq("id", state.modal.entityId)
      : client.from("families").insert(payload);

    const { error } = await query;
    if (error) {
      setNodeMessage("admin-modal-msg", error.message, "error");
      return;
    }

    await refreshAndRender();
    closeModal();
  }

  async function saveClass(isEdit) {
    const client = mustClient();
    const name = el("modal-class-name").value.trim();
    const displayOrder = Number(el("modal-class-order").value || 0);

    if (!name) {
      setNodeMessage("admin-modal-msg", "Class name is required.", "error");
      return;
    }

    const query = isEdit
      ? client.from("classes").update({ name, display_order: displayOrder }).eq("id", state.modal.entityId)
      : client.from("classes").insert({ name, display_order: displayOrder });

    const { error } = await query;
    if (error) {
      setNodeMessage("admin-modal-msg", error.message, "error");
      return;
    }

    await refreshAndRender();
    closeModal();
  }

  async function saveStudent(isEdit) {
    const client = mustClient();
    const first = el("modal-student-first").value.trim();
    const last = el("modal-student-last").value.trim();
    const familyId = el("modal-student-family").value;
    const classId = el("modal-student-class").value;

    if (!first || !last || !familyId || !classId) {
      setNodeMessage("admin-modal-msg", "All student fields are required.", "error");
      return;
    }

    const payload = { first_name: first, last_name: last, family_id: familyId, class_id: classId };
    const query = isEdit
      ? client.from("students").update(payload).eq("id", state.modal.entityId)
      : client.from("students").insert(payload);

    const { error } = await query;
    if (error) {
      setNodeMessage("admin-modal-msg", error.message, "error");
      return;
    }

    await refreshAndRender();
    closeModal();
  }

  async function savePermission(isEdit) {
    const client = mustClient();
    const grantingFamilyId = el("modal-permission-granting").value;
    const receivingFamilyId = el("modal-permission-receiving").value;
    const startsOn = el("modal-permission-start").value;
    const endsOn = el("modal-permission-permanent").checked ? PERMANENT_END_DATE : el("modal-permission-end").value;
    const studentIds = Array.from(document.querySelectorAll("[data-permission-student]:checked")).map((input) => input.value);

    if (!grantingFamilyId || !receivingFamilyId || !startsOn || !endsOn || !studentIds.length) {
      setNodeMessage("admin-modal-msg", "Choose both families, a date range, and at least one student.", "error");
      return;
    }

    const rpcName = isEdit ? "admin_update_pickup_authorization" : "admin_create_pickup_authorization";
    const params = isEdit
      ? {
          p_authorization_id: state.modal.entityId,
          p_granting_family_id: grantingFamilyId,
          p_student_ids: studentIds,
          p_starts_on: startsOn,
          p_ends_on: endsOn
        }
      : {
          p_granting_family_id: grantingFamilyId,
          p_receiving_family_id: receivingFamilyId,
          p_student_ids: studentIds,
          p_starts_on: startsOn,
          p_ends_on: endsOn
        };

    const { error } = await client.rpc(rpcName, params);
    if (error) {
      setNodeMessage("admin-modal-msg", error.message, "error");
      return;
    }

    await refreshAndRender();
    closeModal();
  }

  function syncPermissionPermanentUi() {
    const permanentToggle = el("modal-permission-permanent");
    const endDate = el("modal-permission-end");
    if (!permanentToggle || !endDate) return;

    const isPermanent = permanentToggle.checked;
    endDate.disabled = isPermanent;
    if (isPermanent) {
      endDate.value = "";
    } else if (!endDate.value) {
      endDate.value = state.today;
    }
  }

  async function savePreset(isEdit) {
    const client = mustClient();
    const ownerFamilyId = el("modal-preset-owner").value;
    const name = el("modal-preset-name").value.trim();
    const studentIds = Array.from(document.querySelectorAll("[data-preset-student]:checked")).map((input) => input.value);
    const weekdays = normalizeWeekdays(Array.from(document.querySelectorAll("[data-preset-weekday]:checked")).map((input) => input.value));

    if (!ownerFamilyId || !name || !studentIds.length || !weekdays.length) {
      setNodeMessage("admin-modal-msg", "Choose an owner family, a name, at least one day, and at least one student.", "error");
      return;
    }

    const rpcName = isEdit ? "admin_update_carpool_preset" : "admin_create_carpool_preset";
    const params = isEdit
      ? {
          p_preset_id: state.modal.entityId,
          p_owner_family_id: ownerFamilyId,
          p_name: name,
          p_student_ids: studentIds,
          p_weekdays: weekdays
        }
      : {
          p_owner_family_id: ownerFamilyId,
          p_name: name,
          p_student_ids: studentIds,
          p_weekdays: weekdays
        };

    const { error } = await client.rpc(rpcName, params);
    if (error) {
      setNodeMessage("admin-modal-msg", error.message, "error");
      return;
    }

    await refreshAndRender();
    closeModal();
  }

  function parseClassOrderHints(rawRows, headerRowIndex) {
    if (headerRowIndex < 1) return [];
    const banner = cleanValue(rawRows[headerRowIndex - 1]?.[0]);
    if (!banner || !banner.includes("/")) return [];
    return banner.split("/").map((value) => normalizedClassName(value)).filter(Boolean);
  }

  function detectHeaderRow(rawRows) {
    let bestIndex = 0;
    let bestScore = -1;
    const maxRows = Math.min(rawRows.length, 10);
    for (let idx = 0; idx < maxRows; idx += 1) {
      const score = (rawRows[idx] || []).reduce((total, cell) => {
        const mapped = IMPORT_HEADER_ALIASES[importKey(cell)];
        return total + (mapped ? 1 : 0);
      }, 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }
    return bestIndex;
  }

  function normalizedRowsFromMatrix(rawRows) {
    if (!rawRows.length) return { rows: [], headerIssues: [], classOrderHints: [] };

    const headerRowIndex = detectHeaderRow(rawRows);
    const headerRow = rawRows[headerRowIndex] || [];
    const headerMap = new Map();

    headerRow.forEach((cell, index) => {
      const mapped = IMPORT_HEADER_ALIASES[importKey(cell)];
      if (mapped && !headerMap.has(mapped)) {
        headerMap.set(mapped, index);
      }
    });

    const headerIssues = REQUIRED_IMPORT_FIELDS
      .filter((field) => !headerMap.has(field))
      .map((field) => `Missing column in upload: ${expectedHeader(field)}. Added as editable blank cells in preview.`);

    const rows = rawRows
      .slice(headerRowIndex + 1)
      .map((cells, offset) => {
        const values = {};
        [...headerMap.keys(), ...REQUIRED_IMPORT_FIELDS].forEach((field) => {
          const sourceIndex = headerMap.get(field);
          values[field] = sourceIndex == null ? "" : cells[sourceIndex];
        });
        return canonicalImportRow(headerRowIndex + offset + 2, values);
      })
      .filter((row) => IMPORT_EDITABLE_FIELDS.some((field) => cleanValue(row[field])) || cleanValue(row.grade));

    return {
      rows,
      headerIssues,
      classOrderHints: parseClassOrderHints(rawRows, headerRowIndex)
    };
  }

  async function rawRowsFromFile(file) {
    const name = cleanValue(file?.name).toLowerCase();
    if (name.endsWith(".csv")) {
      return csvToArrays(await file.text());
    }

    if (!window.XLSX) {
      throw new Error("Excel parser is unavailable on this page.");
    }

    const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(firstSheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false
    });
  }

  function importSummaryCounts(rows) {
    const activeRows = rows.filter((row) => !row.skipped);
    return {
      total: rows.length,
      active: activeRows.length,
      skipped: rows.length - activeRows.length,
      invalid: activeRows.filter((row) => row.errors.length).length,
      ready: activeRows.filter((row) => !row.errors.length).length
    };
  }

  function recomputeImportPreview() {
    const rows = state.importPreview.rows;
    const existingClasses = new Map(state.classes.map((cls) => [normalizeText(cls.name), cls]));
    const existingFamilies = new Map(state.families.map((family) => [String(family.carpool_number), family]));
    const existingStudents = new Map();

    state.students.forEach((student) => {
      const key = `${student.family_id}::${normalizedStudentName(student.first_name)}::${normalizedStudentName(student.last_name)}`;
      const list = existingStudents.get(key) || [];
      list.push(student);
      existingStudents.set(key, list);
    });

    const familyConflicts = new Map();
    const familySnapshots = new Map();
    const batchStudentKeys = new Map();

    rows.forEach((row) => {
      row.errors = [];
      row.planned_action = "";
      if (row.skipped) return;

      REQUIRED_IMPORT_FIELDS.forEach((field) => {
        if (!cleanValue(row[field])) {
          row.errors.push(`${expectedHeader(field)} is required.`);
        }
      });

      const carpoolText = canonicalCarpool(row.carpool_number);
      if (carpoolText && !/^\d+$/.test(carpoolText)) {
        row.errors.push("Family number must be a whole number.");
      }

      const className = normalizedClassName(row.class_name);
      if (cleanValue(row.class_name) && !className) {
        row.errors.push("Class name is invalid.");
      }

      const carpoolKey = carpoolText;
      if (carpoolKey) {
        const snapshot = familyFieldsFromRow(row);
        const existingSnapshot = familySnapshots.get(carpoolKey);
        if (!existingSnapshot) {
          familySnapshots.set(carpoolKey, snapshot);
        } else if (!sameFamilyData(existingSnapshot, snapshot)) {
          familyConflicts.set(carpoolKey, true);
        }
      }

      const batchKey = `${carpoolText}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
      if (carpoolText && normalizedStudentName(row.student_first_name) && normalizedStudentName(row.student_last_name)) {
        const list = batchStudentKeys.get(batchKey) || [];
        list.push(row.row_number);
        batchStudentKeys.set(batchKey, list);
      }
    });

    rows.forEach((row) => {
      if (row.skipped) return;

      const carpoolText = canonicalCarpool(row.carpool_number);
      if (carpoolText && familyConflicts.get(carpoolText)) {
        row.errors.push("This import has conflicting parent data for the same family number.");
      }

      const batchKey = `${carpoolText}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
      if (batchStudentKeys.get(batchKey)?.length > 1) {
        row.errors.push("This student appears more than once in the current import batch.");
      }

      if (row.errors.length) {
        row.planned_action = "Fix row";
        return;
      }

      const actions = [];
      const classExists = existingClasses.has(normalizeText(row.class_name));
      if (!classExists) actions.push("Create class");

      const family = existingFamilies.get(carpoolText);
      if (!family) {
        actions.push("Create family");
      } else if (!sameFamilyData(family, familyFieldsFromRow(row))) {
        actions.push("Update family");
      }

      if (family) {
        const key = `${family.id}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
        const matches = existingStudents.get(key) || [];
        if (matches.length > 1) {
          row.errors.push("This student matches multiple existing students in the database.");
          row.planned_action = "Fix row";
          return;
        }
        if (!matches.length) {
          actions.push("Create student");
        } else if (matches[0].class_id !== existingClasses.get(normalizeText(row.class_name))?.id || matches[0].first_name !== row.student_first_name || matches[0].last_name !== row.student_last_name) {
          actions.push("Update student");
        } else if (!actions.length) {
          actions.push("No change");
        }
      } else {
        actions.push("Create student");
      }

      row.planned_action = actions.join(", ");
    });
  }

  function renderImportResultsHtml(result) {
    const lines = [
      `Students created: ${result.students_created}`,
      `Students updated: ${result.students_updated}`,
      `Families created: ${result.families_created}`,
      `Families updated: ${result.families_updated}`,
      `Classes created: ${result.classes_created}`,
      `Rows skipped: ${result.rows_skipped}`,
      `Rows failed: ${result.errors.length}`
    ];
    return `
      <p class="success">${escapeHtml(lines.join(" | "))}</p>
      ${result.errors.length ? `<ul>${result.errors.map((err) => `<li class="error">${escapeHtml(err)}</li>`).join("")}</ul>` : ""}
    `;
  }

  function renderImportPreview() {
    const emptyState = el("imports-empty-state");
    const reviewState = el("imports-review-state");
    const status = el("imports-status");
    const summary = el("imports-preview-summary");
    const tbody = el("imports-preview-tbody");
    const confirmBtn = el("imports-confirm-btn");
    if (!emptyState || !reviewState || !status || !summary || !tbody || !confirmBtn) return;

    const hasRows = state.importPreview.rows.length > 0;
    emptyState.classList.toggle("hidden", hasRows);
    reviewState.classList.toggle("hidden", !hasRows);

    if (!hasRows) {
      status.innerHTML = [
        state.importPreview.parseError ? `<p class="error">${escapeHtml(state.importPreview.parseError)}</p>` : "",
        state.importPreview.resultHtml || '<p class="muted">No import run in this session.</p>'
      ].join("");
      return;
    }

    const counts = importSummaryCounts(state.importPreview.rows);
    const issues = state.importPreview.headerIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("");
    status.innerHTML = `
      <p class="muted"><strong>${escapeHtml(state.importPreview.fileName)}</strong></p>
      <p class="muted">${escapeHtml(`${counts.ready} ready, ${counts.invalid} invalid, ${counts.skipped} skipped.`)}</p>
      ${issues ? `<ul class="import-issues">${issues}</ul>` : ""}
      ${state.importPreview.parseError ? `<p class="error">${escapeHtml(state.importPreview.parseError)}</p>` : ""}
      ${state.importPreview.resultHtml ? `<div class="import-result-copy">${state.importPreview.resultHtml}</div>` : ""}
    `;

    summary.textContent = `Review ${counts.total} row${counts.total === 1 ? "" : "s"} before importing.`;
    confirmBtn.disabled = counts.invalid > 0 || counts.ready === 0;

    tbody.innerHTML = state.importPreview.rows.map((row, index) => {
      const rowClass = row.skipped ? "import-row skipped" : row.errors.length ? "import-row invalid" : "import-row ready";
      const errorText = row.errors.length ? row.errors.join(" ") : row.skipped ? "Skipped" : "Ready";
      const editableCells = IMPORT_EDITABLE_FIELDS.map((field) => `
        <td>
          <input
            type="${field === "carpool_number" ? "number" : "text"}"
            class="import-cell-input"
            data-import-row="${escapeHtml(String(index))}"
            data-import-field="${escapeHtml(field)}"
            value="${escapeHtml(row[field] || "")}"
            ${row.skipped ? "disabled" : ""}
          />
        </td>
      `).join("");

      return `
        <tr class="${rowClass}">
          <td>
            <label class="import-keep-toggle">
              <input type="checkbox" data-import-skip="${escapeHtml(String(index))}" ${row.skipped ? "" : "checked"} />
              <span>${row.skipped ? "Skipped" : "Keep"}</span>
            </label>
          </td>
          <td>${escapeHtml(String(row.row_number))}</td>
          <td>${escapeHtml(row.planned_action || "Review")}</td>
          <td class="${row.errors.length ? "error" : row.skipped ? "muted" : "success"}">${escapeHtml(errorText)}</td>
          ${editableCells}
          <td>${escapeHtml(row.grade || "")}</td>
        </tr>
      `;
    }).join("");
  }

  function clearImportPreviewRows() {
    state.importPreview.rows = [];
    state.importPreview.headerIssues = [];
    state.importPreview.classOrderHints = [];
    state.importPreview.parseError = "";
    state.importPreview.fileName = "";
    renderImportPreview();
  }

  async function stageImportFile(file) {
    try {
      const rawRows = await rawRowsFromFile(file);
      if (!rawRows.length) throw new Error("The selected file is empty.");
      const normalized = normalizedRowsFromMatrix(rawRows);
      if (!normalized.rows.length) {
        throw new Error("No importable rows were found in this file.");
      }
      state.importPreview = {
        fileName: file.name,
        rows: normalized.rows,
        headerIssues: normalized.headerIssues,
        classOrderHints: normalized.classOrderHints,
        parseError: "",
        resultHtml: ""
      };
      recomputeImportPreview();
      renderImportPreview();
      setTab("imports");
    } catch (error) {
      state.importPreview = {
        ...state.importPreview,
        fileName: file?.name || "",
        rows: [],
        headerIssues: [],
        classOrderHints: [],
        parseError: error.message || "Unable to parse this file."
      };
      renderImportPreview();
      setTab("imports");
    }
  }

  function classDisplayOrderForName(name) {
    const hints = state.importPreview.classOrderHints || [];
    const hintIndex = hints.findIndex((hint) => normalizeText(hint) === normalizeText(name));
    if (hintIndex >= 0) return hintIndex + 1;
    return state.classes.length + 1;
  }

  async function confirmImportPreview() {
    recomputeImportPreview();
    renderImportPreview();

    const rows = state.importPreview.rows.filter((row) => !row.skipped && !row.errors.length);
    if (!rows.length) return;

    const client = mustClient();
    const results = {
      students_created: 0,
      students_updated: 0,
      families_created: 0,
      families_updated: 0,
      classes_created: 0,
      rows_skipped: state.importPreview.rows.filter((row) => row.skipped).length,
      errors: []
    };

    const classMap = new Map(state.classes.map((cls) => [normalizeText(cls.name), cls]));
    const familyMap = new Map(state.families.map((family) => [String(family.carpool_number), family]));
    const studentMap = new Map();
    state.students.forEach((student) => {
      const key = `${student.family_id}::${normalizedStudentName(student.first_name)}::${normalizedStudentName(student.last_name)}`;
      const list = studentMap.get(key) || [];
      list.push(student);
      studentMap.set(key, list);
    });

    for (const row of rows) {
      try {
        const classKey = normalizeText(row.class_name);
        let classRow = classMap.get(classKey);
        if (!classRow) {
          const classInsert = await client
            .from("classes")
            .insert({ name: normalizedClassName(row.class_name), display_order: classDisplayOrderForName(row.class_name) })
            .select("id,name,display_order")
            .single();
          if (classInsert.error) throw classInsert.error;
          classRow = classInsert.data;
          classMap.set(classKey, classRow);
          state.classes.push(classRow);
          results.classes_created += 1;
        }

        const familyKey = canonicalCarpool(row.carpool_number);
        let familyRow = familyMap.get(familyKey);
        const rowFamilyFields = familyFieldsFromRow(row);
        const rowIncludesNotifications =
          Object.prototype.hasOwnProperty.call(rowFamilyFields, "notification_email") ||
          Object.prototype.hasOwnProperty.call(rowFamilyFields, "notification_enabled");
        const familyPayload = familyPayloadFromValues({
          carpool_number: row.carpool_number,
          ...rowFamilyFields
        }, { includeNotification: rowIncludesNotifications });

        if (!familyRow) {
          const familyInsert = await client
            .from("families")
            .insert(familyPayload)
            .select("id,carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,contact_info,notification_email,notification_enabled")
            .single();
          if (familyInsert.error) throw familyInsert.error;
          familyRow = hydrateFamily(familyInsert.data);
          familyMap.set(familyKey, familyRow);
          state.families.push(familyRow);
          results.families_created += 1;
        } else if (!sameFamilyData(familyRow, rowFamilyFields)) {
          const familyUpdate = await client
            .from("families")
            .update(familyPayload)
            .eq("id", familyRow.id)
            .select("id,carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,contact_info,notification_email,notification_enabled")
            .single();
          if (familyUpdate.error) throw familyUpdate.error;
          familyRow = hydrateFamily(familyUpdate.data);
          familyMap.set(familyKey, familyRow);
          state.families = state.families.map((family) => family.id === familyRow.id ? familyRow : family);
          results.families_updated += 1;
        }

        const studentKey = `${familyRow.id}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
        const matches = studentMap.get(studentKey) || [];
        if (matches.length > 1) {
          throw new Error("This student matches multiple existing students.");
        }

        if (!matches.length) {
          const studentInsert = await client
            .from("students")
            .insert({
              first_name: row.student_first_name,
              last_name: row.student_last_name,
              family_id: familyRow.id,
              class_id: classRow.id
            })
            .select("id,first_name,last_name,class_id,family_id,classes(name),families(carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name)")
            .single();
          if (studentInsert.error) throw studentInsert.error;
          const newStudent = hydrateStudent(studentInsert.data);
          const list = studentMap.get(studentKey) || [];
          list.push(newStudent);
          studentMap.set(studentKey, list);
          state.students.push(newStudent);
          results.students_created += 1;
        } else {
          const existingStudent = matches[0];
          if (
            existingStudent.class_id !== classRow.id ||
            existingStudent.first_name !== row.student_first_name ||
            existingStudent.last_name !== row.student_last_name
          ) {
            const studentUpdate = await client
              .from("students")
              .update({
                first_name: row.student_first_name,
                last_name: row.student_last_name,
                class_id: classRow.id,
                family_id: familyRow.id
              })
              .eq("id", existingStudent.id)
              .select("id,first_name,last_name,class_id,family_id,classes(name),families(carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name)")
              .single();
            if (studentUpdate.error) throw studentUpdate.error;
            const updatedStudent = hydrateStudent(studentUpdate.data);
            studentMap.set(studentKey, [updatedStudent]);
            state.students = state.students.map((student) => student.id === updatedStudent.id ? updatedStudent : student);
            results.students_updated += 1;
          }
        }
      } catch (error) {
        results.errors.push(`Row ${row.row_number}: ${error.message || "Import failed"}`);
      }
    }

    await refreshAndRender();
    state.importPreview.rows = [];
    state.importPreview.parseError = "";
    state.importPreview.headerIssues = [];
    state.importPreview.classOrderHints = [];
    state.importPreview.resultHtml = renderImportResultsHtml(results);
    renderImportPreview();
    setTab("imports");
  }

  async function handleModalSubmit(event) {
    event.preventDefault();

    const mode = state.modal.mode;
    if (mode === "add-family") return saveFamily(false);
    if (mode === "edit-family") return saveFamily(true);
    if (mode === "add-class") return saveClass(false);
    if (mode === "edit-class") return saveClass(true);
    if (mode === "add-student") return saveStudent(false);
    if (mode === "edit-student") return saveStudent(true);
    if (mode === "add-permission") return savePermission(false);
    if (mode === "edit-permission") return savePermission(true);
    if (mode === "add-preset") return savePreset(false);
    if (mode === "edit-preset") return savePreset(true);
  }

  async function deleteFamily(id) {
    const linked = state.students.some((s) => s.family_id === id);
    if (linked && !confirm("This family has linked students. Delete anyway?")) return;
    if (!linked && !confirm("Delete this family?")) return;

    const client = mustClient();
    const { error } = await client.from("families").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }

    await refreshAndRender();
  }

  async function deleteClass(id) {
    const assigned = state.students.some((s) => s.class_id === id);
    if (assigned && !confirm("This class has assigned students. Delete anyway?")) return;
    if (!assigned && !confirm("Delete this class?")) return;

    const client = mustClient();
    const { error } = await client.from("classes").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }

    await refreshAndRender();
  }

  async function deleteStudent(id) {
    if (!confirm("Delete this student?")) return;
    const client = mustClient();
    const { error } = await client.from("students").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }

    await refreshAndRender();
  }

  async function revokePermission(id) {
    if (!confirm("Revoke this pickup permission?")) return;
    const client = mustClient();
    const { error } = await client.rpc("admin_revoke_pickup_authorization", {
      p_authorization_id: id
    });
    if (error) {
      alert(error.message);
      return;
    }

    await refreshAndRender();
  }

  async function removePreset(id) {
    if (!confirm("Delete this saved carpool?")) return;
    const client = mustClient();
    const { error } = await client.rpc("admin_delete_carpool_preset", {
      p_preset_id: id
    });
    if (error) {
      alert(error.message);
      return;
    }

    await refreshAndRender();
  }

  function bindSortHandlers() {
    const tableRenderMap = {
      today: renderToday,
      students: renderStudents,
      families: renderFamilies,
      classes: renderClasses,
      permissions: renderPermissions,
      presets: renderPermissions
    };

    ["today", "students", "families", "classes", "permissions", "presets"].forEach(key => {
      const table = el(`${key}-table`);
      if (!table) return;
      table.querySelectorAll("th[data-sort]").forEach(th => {
        th.addEventListener("click", () => {
          const clickedCol = th.dataset.sort;
          if (sortState[key].col === clickedCol) {
            sortState[key].dir = sortState[key].dir === "asc" ? "desc" : "asc";
          } else {
            sortState[key].col = clickedCol;
            sortState[key].dir = "asc";
          }
          tableRenderMap[key]();
        });
      });
    });
  }

  function bindUi() {
    el("admin-login-btn").addEventListener("click", async () => {
      show("admin-login-error", false);

      const email = el("admin-email").value.trim();
      const password = el("admin-password").value;
      const client = mustClient();
      const { error } = await client.auth.signInWithPassword({ email, password });

      if (error) {
        el("admin-login-error").textContent = "Invalid email or password.";
        show("admin-login-error", true);
        return;
      }

      window.location.reload();
    });

    el("admin-logout-btn").addEventListener("click", async () => {
      const client = mustClient();
      await client.auth.signOut();
      window.location.reload();
    });

    el("open-add-family").addEventListener("click", () => openModal("add-family"));
    el("open-add-class").addEventListener("click", () => openModal("add-class"));
    el("open-add-student").addEventListener("click", () => openModal("add-student"));
    el("open-add-permission").addEventListener("click", () => openModal("add-permission"));
    el("open-add-preset").addEventListener("click", () => openModal("add-preset"));
    el("open-csv-import").addEventListener("click", () => {
      setTab("imports");
      el("imports-file-input").click();
    });
    el("imports-browse-btn").addEventListener("click", () => el("imports-file-input").click());
    el("imports-file-input").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      await stageImportFile(file);
      event.target.value = "";
    });
    el("imports-cancel-btn").addEventListener("click", clearImportPreviewRows);
    el("imports-confirm-btn").addEventListener("click", confirmImportPreview);
    el("imports-preview-tbody").addEventListener("change", (event) => {
      const input = event.target.closest("[data-import-field]");
      if (input) {
        const row = state.importPreview.rows[Number(input.dataset.importRow)];
        if (!row) return;
        row[input.dataset.importField] = cleanValue(input.value);
        recomputeImportPreview();
        renderImportPreview();
        return;
      }

      const toggle = event.target.closest("[data-import-skip]");
      if (!toggle) return;
      const row = state.importPreview.rows[Number(toggle.dataset.importSkip)];
      if (!row) return;
      row.skipped = !toggle.checked;
      recomputeImportPreview();
      renderImportPreview();
    });

    el("admin-modal-close").addEventListener("click", closeModal);
    el("admin-modal-cancel").addEventListener("click", closeModal);
    el("admin-modal").addEventListener("click", (event) => {
      if (event.target === el("admin-modal")) closeModal();
    });
    el("admin-modal-form").addEventListener("submit", handleModalSubmit);

    el("admin-tabs").addEventListener("click", (event) => {
      const btn = event.target.closest(".tab-btn");
      if (!btn) return;
      setTab(btn.dataset.tab);
    });

    el("today-attempts-tbody").addEventListener("click", async (event) => {
      const repingBtn = event.target.closest("[data-reping-student]");
      if (repingBtn) {
        const studentId = repingBtn.dataset.repingStudent;
        if (!studentId) return;
        try {
          await repingTodayStudent(studentId);
        } catch (error) {
          alert(error.message || "Unable to reping student.");
        }
        return;
      }

      const statusNode = event.target.closest("[data-today-student-id]");
      if (!statusNode) return;
      const studentId = statusNode.dataset.todayStudentId;
      if (!studentId) return;
      try {
        await toggleTodayStudentStatus(studentId);
      } catch (error) {
        alert(error.message || "Unable to update student status.");
      }
    });

    el("today-attempts-search")?.addEventListener("input", (event) => {
      state.todayAttemptSearch = event.target.value;
      renderToday();
    });

    el("today-student-grid").addEventListener("click", async (event) => {
      const card = event.target.closest("[data-today-grid-student-id]");
      if (!card) return;
      const studentId = card.dataset.todayGridStudentId;
      if (!studentId) return;
      try {
        await toggleTodayStudentStatus(studentId);
      } catch (error) {
        alert(error.message || "Unable to update student status.");
      }
    });

    el("today-waiting-only-toggle")?.addEventListener("change", (event) => {
      state.todayGridWaitingOnly = event.target.checked;
      renderTodayStudentGrid();
    });

    el("today-grid-fullscreen-btn")?.addEventListener("click", () => {
      setTodayGridFullscreen(!state.todayGridFullscreen);
    });

    document.addEventListener("fullscreenchange", () => {
      const panel = el("today-student-grid-card");
      if (state.todayGridFullscreen && document.fullscreenElement !== panel) {
        setTodayGridFullscreen(false, { skipNative: true });
      } else if (state.todayGridFullscreen) {
        scheduleTodayGridFit();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.todayGridFullscreen) {
        setTodayGridFullscreen(false);
      }
    });

    window.addEventListener("resize", scheduleTodayGridFit);

    el("families-tbody").addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-edit-family]");
      if (editBtn) {
        openModal("edit-family", editBtn.dataset.editFamily);
        return;
      }

      const deleteBtn = event.target.closest("[data-delete-family]");
      if (deleteBtn) {
        deleteFamily(deleteBtn.dataset.deleteFamily);
      }
    });

    el("classes-tbody").addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-edit-class]");
      if (editBtn) {
        openModal("edit-class", editBtn.dataset.editClass);
        return;
      }

      const deleteBtn = event.target.closest("[data-delete-class]");
      if (deleteBtn) {
        deleteClass(deleteBtn.dataset.deleteClass);
      }
    });

    el("students-tbody").addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-edit-student]");
      if (editBtn) {
        openModal("edit-student", editBtn.dataset.editStudent);
        return;
      }

      const deleteBtn = event.target.closest("[data-delete-student]");
      if (deleteBtn) {
        deleteStudent(deleteBtn.dataset.deleteStudent);
      }
    });

    el("permissions-tbody").addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-edit-auth]");
      if (editBtn) {
        openModal("edit-permission", editBtn.dataset.editAuth);
        return;
      }

      const revokeBtn = event.target.closest("[data-revoke-auth]");
      if (revokeBtn) {
        revokePermission(revokeBtn.dataset.revokeAuth);
      }
    });

    el("presets-tbody").addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-edit-preset]");
      if (editBtn) {
        openModal("edit-preset", editBtn.dataset.editPreset);
        return;
      }

      const deleteBtn = event.target.closest("[data-delete-preset]");
      if (deleteBtn) {
        removePreset(deleteBtn.dataset.deletePreset);
      }
    });

    bindSortHandlers();
  }

  async function init() {
    if (!window.carpoolClient) {
      show("config-warning", true);
      return;
    }

    bindUi();

    try {
      const auth = await requireAuth("admin");
      if (!auth.ok) {
        show("admin-login-section", true);
        show("admin-dashboard", false);
        return;
      }

      show("admin-login-section", false);
      show("admin-dashboard", true);

      state.today = await fetchSchoolToday();
      await refreshAndRender();
      startRealtime();
      setTab("today");
    } catch (error) {
      show("admin-login-section", true);
      el("admin-login-error").textContent = error.message || "Unable to load admin dashboard.";
      show("admin-login-error", true);
    }
  }

  init();

  window.addEventListener("beforeunload", () => {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    if (state.todayGridFitTimer) window.cancelAnimationFrame(state.todayGridFitTimer);
    if (state.channel && window.carpoolClient) {
      window.carpoolClient.removeChannel(state.channel);
    }
  });
})();
