(function spotterPage() {
  const {
    mustClient,
    show,
    requireAuth,
    schoolTodayISO,
    fetchSchoolToday,
    escapeHtml,
    familyDisplayName,
    familySearchText,
    normalizeText,
    attendanceBadgeHtml,
    attendanceStatusLabel,
    normalizeWeekdays,
    formatWeekdays,
    weekdayKeyForISO
  } = window.carpoolUtils || {};
  if (!mustClient) return;

  const state = {
    today: schoolTodayISO(),
    families: [],
    students: [],
    statuses: new Map(),
    attendanceStatuses: new Map(),
    channel: null,
    context: null,
    lookupFamily: null,
    selectedByFamily: new Map(),
    messageTimer: null
  };

  function el(id) {
    return document.getElementById(id);
  }

  async function currentActorLabel(client, fallback) {
    try {
      const { data } = await client.auth.getUser();
      return data?.user?.email || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function setMessage(text, klass) {
    const node = el("spotter-checkin-message");
    if (!node) return;

    if (state.messageTimer) {
      window.clearTimeout(state.messageTimer);
      state.messageTimer = null;
    }

    node.classList.remove("success", "error", "visible");

    if (!text) {
      node.textContent = "";
      node.classList.add("hidden");
      return;
    }

    node.textContent = text;
    node.classList.remove("hidden");
    if (klass) node.classList.add(klass);
    window.requestAnimationFrame(() => node.classList.add("visible"));

    const duration = klass === "error" ? 3200 : 2200;
    state.messageTimer = window.setTimeout(() => {
      node.classList.remove("visible");
      window.setTimeout(() => {
        node.classList.add("hidden");
        node.textContent = "";
      }, 180);
      state.messageTimer = null;
    }, duration);
  }

  function familyMeta(familyId) {
    return state.families.find((family) => family.id === familyId) || null;
  }

  function contextCards() {
    if (!state.context) return [];
    const own = state.context.requesting_family;
    const cards = [{
      family_id: own.family_id,
      carpool_number: own.carpool_number,
      display_name: familyDisplayName(own),
      label: "Your Family",
      note: "",
      students: state.context.own_students || []
    }];

    (state.context.authorized_pickups || []).forEach((family) => {
      const meta = familyMeta(family.family_id);
      cards.push({
        family_id: family.family_id,
        carpool_number: meta?.carpool_number || "",
        display_name: familyDisplayName(family),
        label: "Authorized Kids",
        note: `Approved from ${family.starts_on} to ${family.ends_on}`,
        students: family.students || []
      });
    });

    return cards;
  }

  function resetTopSelections() {
    state.selectedByFamily = new Map();
    contextCards().forEach((card) => state.selectedByFamily.set(card.family_id, new Set()));
  }

  function selectedCount() {
    let total = 0;
    state.selectedByFamily.forEach((set) => {
      total += set.size;
    });
    return total;
  }

  function selectedCountForFamily(card) {
    return (state.selectedByFamily.get(card.family_id) || new Set()).size;
  }

  function familySelectionState(card) {
    const count = selectedCountForFamily(card);
    if (!count) return "empty";
    if (count >= card.students.length) return "full";
    return "partial";
  }

  function familyLastName(displayName) {
    const text = String(displayName || "").trim();
    if (!text) return "Family";
    const parts = text.split(/\s+/);
    return parts[parts.length - 1];
  }

  function parentInitial(firstName) {
    return String(firstName || "").trim().charAt(0).toUpperCase();
  }

  function familySharedLastName(family) {
    const parentOneLast = String(family?.parent_one_last_name || "").trim();
    const parentTwoLast = String(family?.parent_two_last_name || "").trim();

    if (parentOneLast && parentTwoLast && normalizeText(parentOneLast) === normalizeText(parentTwoLast)) {
      return parentOneLast;
    }

    if (parentOneLast && !parentTwoLast) return parentOneLast;
    if (parentTwoLast && !parentOneLast) return parentTwoLast;

    return familyLastName(familyDisplayName(family));
  }

  function familyQuickLabel(family) {
    const lastName = familySharedLastName(family);
    const duplicateCount = state.families.filter((entry) =>
      normalizeText(familySharedLastName(entry)) === normalizeText(lastName)
    ).length;

    if (duplicateCount < 2) return familyLastName(familyDisplayName(family));

    const initials = [
      parentInitial(family?.parent_one_first_name),
      parentInitial(family?.parent_two_first_name)
    ].filter(Boolean);

    if (!initials.length) return lastName || "Family";
    return `${initials.join(" & ")} ${lastName}`;
  }

  function filteredQuickCarpools() {
    const query = normalizeText(el("spotter-carpool-input").value);
    const families = [...state.families].sort((a, b) => Number(a.carpool_number) - Number(b.carpool_number));
    if (!query) return families;
    return families.filter((family) =>
      String(family.carpool_number).includes(query) ||
      familySearchText(family).includes(query)
    );
  }

  function resolveLookupFamily() {
    const query = el("spotter-carpool-input").value.trim();
    if (!query) return null;

    const exactNumber = state.families.find((family) => String(family.carpool_number) === query);
    if (exactNumber) return exactNumber;

    const normalizedQuery = normalizeText(query);
    const exactName = state.families.find((family) => familySearchText(family) === normalizedQuery);
    if (exactName) return exactName;

    return filteredQuickCarpools()[0] || null;
  }

  function clearLookup() {
    state.lookupFamily = null;
    state.context = null;
    resetTopSelections();
    el("spotter-carpool-input").value = "";
    renderQuickCarpools();
    renderContextPanel();
    setMessage("");
    el("spotter-carpool-input").focus();
  }

  function renderQuickCarpools() {
    const tray = el("spotter-quick-carpools");
    if (!tray) return;

    const activeNumber = state.lookupFamily ? String(state.lookupFamily.carpool_number) : "";
    const families = filteredQuickCarpools();

    if (!families.length) {
      tray.innerHTML = '<p class="spotter-quick-empty">No carpools match that search.</p>';
      return;
    }

    tray.innerHTML = families.map((family) => `
      <button
        type="button"
        class="spotter-quick-carpool${String(family.carpool_number) === activeNumber ? " active" : ""}"
        data-quick-carpool="${escapeHtml(String(family.carpool_number))}"
        aria-label="Open carpool ${escapeHtml(String(family.carpool_number))} for ${escapeHtml(familyDisplayName(family))}"
      >
        <span class="spotter-quick-carpool-number">${escapeHtml(String(family.carpool_number))}</span>
        <span class="spotter-quick-carpool-name">${escapeHtml(familyQuickLabel(family))}</span>
      </button>
    `).join("");
  }

  function studentStatus(studentId) {
    return state.statuses.get(studentId) || "WAITING";
  }

  function studentAttendanceStatus(studentId) {
    return state.attendanceStatuses.get(studentId) || "";
  }

  function attendanceLabel(status) {
    return attendanceStatusLabel ? attendanceStatusLabel(status) : "";
  }

  function attendanceActionButton(studentId, status, label, currentStatus) {
    const isClear = !status;
    const active = status && currentStatus === status;
    const disabled = isClear && !currentStatus;
    return `<button
      class="spotter-attendance-btn${active ? " active" : ""}"
      type="button"
      data-attendance-student="${escapeHtml(studentId)}"
      data-attendance-status="${escapeHtml(status)}"
      aria-pressed="${active ? "true" : "false"}"
      ${disabled ? "disabled" : ""}
    >${escapeHtml(label)}</button>`;
  }

  function attendanceCellHtml(studentId) {
    const currentStatus = studentAttendanceStatus(studentId);
    const badge = attendanceBadgeHtml ? attendanceBadgeHtml(currentStatus) : "";
    return `<div class="spotter-attendance-cell">
      ${badge || '<span class="spotter-attendance-empty">In school</span>'}
      <div class="spotter-attendance-actions">
        ${attendanceActionButton(studentId, "ABSENT", "Absent", currentStatus)}
        ${attendanceActionButton(studentId, "LEFT_EARLY", "Left early", currentStatus)}
        ${attendanceActionButton(studentId, "", "Back", currentStatus)}
      </div>
    </div>`;
  }

  function filteredStudents() {
    const search = el("spotter-search").value.trim().toLowerCase();
    const sortBy = el("spotter-sort").value;

    let list = [...state.students];
    if (search) {
      list = list.filter((s) => {
        const full = `${s.last_name}, ${s.first_name}`.toLowerCase();
        return full.includes(search)
          || String(s.carpool_number).includes(search)
          || attendanceLabel(studentAttendanceStatus(s.id)).toLowerCase().includes(search);
      });
    }

    if (sortBy === "class") {
      list.sort((a, b) => a.class_name.localeCompare(b.class_name) || a.last_name.localeCompare(b.last_name));
    } else if (sortBy === "status") {
      list.sort((a, b) => studentStatus(a.id).localeCompare(studentStatus(b.id)) || a.last_name.localeCompare(b.last_name));
    } else if (sortBy === "attendance") {
      list.sort((a, b) => studentAttendanceStatus(a.id).localeCompare(studentAttendanceStatus(b.id)) || a.last_name.localeCompare(b.last_name));
    } else {
      list.sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
    }

    return list;
  }

  function renderTable() {
    const rows = filteredStudents()
      .map((s) => {
        const status = studentStatus(s.id);
        const tag = status === "CALLED" ? "status status-called" : "status status-waiting";
        const toggleNext = status === "CALLED" ? "WAITING" : "CALLED";
        const toggleIsActive = status === "CALLED";
        const actions = `<div class="spotter-row-actions">
            <button
              class="spotter-status-toggle${toggleIsActive ? " active" : ""}"
              data-status-action="toggle"
              data-next-status="${toggleNext}"
              data-student-id="${escapeHtml(s.id)}"
              aria-pressed="${toggleIsActive ? "true" : "false"}"
              aria-label="${toggleIsActive
                ? `Set ${escapeHtml(`${s.first_name} ${s.last_name}`)} to waiting`
                : `Set ${escapeHtml(`${s.first_name} ${s.last_name}`)} to called`}"
              title="${toggleIsActive ? "Set waiting" : "Set called"}"
              type="button"
            >
              <span class="spotter-status-toggle-track"><span class="spotter-status-toggle-thumb"></span></span>
            </button>
            <button
              class="spotter-icon-btn${toggleIsActive ? " active" : " inactive"}"
              data-status-action="reping"
              data-next-status="CALLED"
              data-student-id="${escapeHtml(s.id)}"
              aria-label="Reping ${escapeHtml(`${s.first_name} ${s.last_name}`)}"
              title="Reping"
              type="button"
              ${toggleIsActive ? "" : "disabled"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M15 17H9"></path>
                <path d="M10 21h4"></path>
                <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"></path>
              </svg>
            </button>
          </div>`;

        return `<tr>
          <td>${escapeHtml(`${s.last_name}, ${s.first_name}`)}</td>
          <td>${escapeHtml(s.class_name)}</td>
          <td>${escapeHtml(String(s.carpool_number))}</td>
          <td><span class="${tag}">${status}</span></td>
          <td>${attendanceCellHtml(s.id)}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");

    const tbody = el("spotter-tbody");
    tbody.innerHTML = rows || '<tr><td colspan="6" class="muted">No students found.</td></tr>';

    tbody.querySelectorAll("button[data-attendance-student]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const studentId = btn.dataset.attendanceStudent;
        try {
          await setAttendanceStatus(studentId, btn.dataset.attendanceStatus || null);
          const student = state.students.find((entry) => entry.id === studentId);
          const fullName = student ? `${student.first_name} ${student.last_name}` : "Student";
          const label = attendanceLabel(btn.dataset.attendanceStatus);
          setMessage(label ? `${fullName} marked ${label.toLowerCase()}` : `${fullName} marked back in school`, "success");
        } catch (error) {
          setMessage(error.message || "Unable to update attendance.", "error");
        } finally {
          btn.disabled = false;
        }
      });
    });

    tbody.querySelectorAll("button[data-status-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const studentId = btn.dataset.studentId;
        const nextStatus = btn.dataset.nextStatus || "CALLED";
        const action = btn.dataset.statusAction;
        try {
          await setStatus(studentId, nextStatus, "spotter");
          state.statuses.set(studentId, nextStatus);
          renderTable();
          const student = state.students.find((entry) => entry.id === studentId);
          const fullName = student ? `${student.first_name} ${student.last_name}` : "Student";
          if (action === "reping") {
            setMessage(`${fullName} reping sent`, "success");
          } else if (nextStatus === "CALLED") {
            setMessage(`${fullName} called`, "success");
          } else {
            setMessage(`${fullName} set to waiting`, "success");
          }
        } catch (error) {
          setMessage("Unable to update status.", "error");
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async function setStatus(studentId, status, calledBy) {
    const client = mustClient();
    const isCalled = status === "CALLED";
    const checkedInBy = isCalled ? await currentActorLabel(client, calledBy === "spotter" ? "Spotter" : "Staff") : null;
    const payload = [{
      student_id: studentId,
      date: state.today,
      status,
      called_at: isCalled ? new Date().toISOString() : null,
      called_by: isCalled ? calledBy : null,
      checked_in_by: checkedInBy,
      pickup_family_id: null,
      pickup_family_label: null
    }];

    const { error } = await client.from("daily_status").upsert(payload, { onConflict: "student_id,date" });
    if (error) throw error;
  }

  function applyAttendanceRecord(record) {
    if (!record?.student_id) return;
    state.statuses.set(record.student_id, record.status || "WAITING");
    if (record.attendance_status) {
      state.attendanceStatuses.set(record.student_id, record.attendance_status);
    } else {
      state.attendanceStatuses.delete(record.student_id);
    }

    const groups = [
      state.context?.own_students || [],
      ...(state.context?.authorized_pickups || []).map((family) => family.students || [])
    ];
    groups.forEach((students) => {
      (students || []).forEach((student) => {
        if (String(student.student_id) === String(record.student_id)) {
          student.attendance_status = record.attendance_status || "";
          student.attendance_marked_at = record.attendance_marked_at || null;
          student.attendance_marked_by = record.attendance_marked_by || "";
          student.attendance_cleared_at = record.attendance_cleared_at || null;
          student.attendance_cleared_by = record.attendance_cleared_by || "";
        }
      });
    });
  }

  async function setAttendanceStatus(studentId, attendanceStatus) {
    const client = mustClient();
    const actor = await currentActorLabel(client, "Spotter");
    const { data, error } = await client.rpc("set_student_attendance_status", {
      p_student_id: studentId,
      p_attendance_status: attendanceStatus || null,
      p_actor: actor
    });
    if (error) throw error;
    applyAttendanceRecord(data);
    renderTable();
    renderContextPanel();
  }

  async function getCheckinContext(number) {
    const client = mustClient();
    const { data, error } = await client.rpc("staff_get_parent_checkin_context", {
      p_carpool_number: Number(number)
    });
    if (error) throw error;
    return data;
  }

  async function submitCheckInRequest(number, targets) {
    const client = mustClient();
    const checkedInBy = await currentActorLabel(client, "Spotter");
    const { data, error } = await client.rpc("staff_submit_check_in_request", {
      p_requesting_carpool_number: Number(number),
      p_targets: targets,
      p_checked_in_by: checkedInBy
    });
    if (error) throw error;
    return data;
  }

  function setSelectedFamily(familyId, studentIds) {
    state.selectedByFamily.set(familyId, new Set(studentIds.map((studentId) => String(studentId))));
  }

  function toggleStudentSelection(familyId, studentId) {
    const set = state.selectedByFamily.get(familyId) || new Set();
    if (set.has(studentId)) set.delete(studentId);
    else set.add(studentId);
    state.selectedByFamily.set(familyId, set);
  }

  function selectEntireFamily(familyId) {
    const card = contextCards().find((item) => item.family_id === familyId);
    const existing = state.selectedByFamily.get(familyId) || new Set();
    const studentIds = (card?.students || []).map((student) => String(student.student_id));
    const allSelected = studentIds.length > 0 && studentIds.every((studentId) => existing.has(studentId));
    state.selectedByFamily.set(familyId, allSelected ? new Set() : new Set(studentIds));
  }

  function isPresetSelected(preset) {
    if (!(preset.students || []).length) return false;
    return (preset.students || []).every((student) => {
      const familySet = state.selectedByFamily.get(student.family_id) || new Set();
      return familySet.has(String(student.student_id));
    });
  }

  function applyPresetSelection(presetId) {
    const preset = (state.context?.saved_carpools || []).find((item) => item.preset_id === presetId);
    if (!preset) return;

    if (isPresetSelected(preset)) {
      (preset.students || []).forEach((student) => {
        const familySet = state.selectedByFamily.get(student.family_id) || new Set();
        familySet.delete(String(student.student_id));
        state.selectedByFamily.set(student.family_id, familySet);
      });
      return;
    }

    (preset.students || []).forEach((student) => {
      const familySet = state.selectedByFamily.get(student.family_id) || new Set();
      familySet.add(String(student.student_id));
      state.selectedByFamily.set(student.family_id, familySet);
    });
  }

  function renderContextPanel() {
    const panel = el("spotter-context-panel");
    if (!state.context) {
      panel.innerHTML = "";
      show("spotter-context-panel", false);
      return;
    }

    const cards = contextCards();
    const ownCard = cards[0] || null;
    const authorizedStudents = cards.slice(1).flatMap((card) =>
      (card.students || []).map((student) => ({
        ...student,
        family_id: card.family_id,
        display_name: card.display_name,
        carpool_number: card.carpool_number
      }))
    );
    const totalSelected = selectedCount();
    const ownSelected = ownCard ? familySelectionState(ownCard) === "full" : false;
    const todayWeekday = weekdayKeyForISO(state.today);
    const presetButtons = (state.context.saved_carpools || []).map((preset) => {
      const count = Number(preset.student_count || 0);
      const active = isPresetSelected(preset);
      const preview = (preset.students || []).map((student) => student.first_name).join(", ");
      const days = normalizeWeekdays(preset.weekdays || []);
      const isTodayPreset = todayWeekday && days.includes(todayWeekday);
      const dayText = formatWeekdays(days, true);
      return `
        <button
          type="button"
          class="spotter-preset-pick${active ? " selected" : ""}${isTodayPreset ? " today" : ""}"
          data-preset-id="${escapeHtml(preset.preset_id)}"
          aria-pressed="${active ? "true" : "false"}"
        >
          <span class="spotter-preset-pick-icon">${active ? "✓" : "+"}</span>
          <span class="spotter-preset-pick-copy">
            <span class="spotter-preset-pick-kicker">${isTodayPreset ? "Today" : "Saved Carpool"}</span>
            <span class="spotter-preset-pick-name">${escapeHtml(preset.name || "Quick Pick")}</span>
            <span class="spotter-preset-pick-meta">${escapeHtml(`${dayText} | ${preview || `${count} students`}`)}</span>
          </span>
        </button>
      `;
    }).join("");

    const ownStudentsHtml = ownCard ? (ownCard.students || []).map((student) => {
      const selected = state.selectedByFamily.get(ownCard.family_id) || new Set();
      const studentId = String(student.student_id);
      const isSelected = selected.has(studentId);
      return `
        <button
          type="button"
          class="spotter-student-pick${isSelected ? " selected" : ""}"
          data-family-id="${escapeHtml(ownCard.family_id)}"
          data-student-id="${escapeHtml(studentId)}"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          <span class="spotter-student-copy">
            <span class="spotter-student-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
            <small>${escapeHtml(student.class_name || "")}</small>
            ${attendanceBadgeHtml ? attendanceBadgeHtml(student.attendance_status) : ""}
          </span>
          <span class="spotter-student-pick-toggle">${isSelected ? "✓" : "+"}</span>
        </button>
      `;
    }).join("") : "";

    const authorizedStudentsHtml = authorizedStudents.map((student) => {
      const familySet = state.selectedByFamily.get(student.family_id) || new Set();
      const studentId = String(student.student_id);
      const isSelected = familySet.has(studentId);
      return `
        <button
          type="button"
          class="spotter-student-pick${isSelected ? " selected" : ""}"
          data-family-id="${escapeHtml(student.family_id)}"
          data-student-id="${escapeHtml(studentId)}"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          <span class="spotter-student-copy">
            <span class="spotter-student-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
            <small>${escapeHtml(student.class_name || "")} · ${escapeHtml(student.display_name || "Family")}${student.carpool_number ? ` · Family #${escapeHtml(String(student.carpool_number))}` : ""}</small>
            ${attendanceBadgeHtml ? attendanceBadgeHtml(student.attendance_status) : ""}
          </span>
          <span class="spotter-student-pick-toggle">${isSelected ? "✓" : "+"}</span>
        </button>
      `;
    }).join("");

    panel.innerHTML = `
      <div class="spotter-context-shell">
        <div class="spotter-context-head">
          <p class="spotter-context-kicker">Family Found</p>
          <h3>#${escapeHtml(String(state.context.requesting_family.carpool_number))} ${escapeHtml(familyDisplayName(state.context.requesting_family))}</h3>
          <p class="spotter-context-copy">Saved carpools are at the top, then spotter can tap own kids or any currently authorized pickup kids below.</p>
        </div>
        ${(state.context.saved_carpools || []).length ? `
          <section class="spotter-preset-section">
            <div class="spotter-section-head">
              <div>
                <p class="spotter-section-kicker">Saved Carpools</p>
                <h4 class="spotter-section-title">Tap a saved carpool</h4>
              </div>
            </div>
            <div class="spotter-preset-picks">${presetButtons}</div>
          </section>
        ` : ""}
        ${ownCard ? `
          <section class="spotter-students-section">
            <div class="spotter-section-head">
              <div>
                <p class="spotter-section-kicker">Own Kids</p>
                <h4 class="spotter-section-title">Students in this family</h4>
              </div>
              <button
                type="button"
                class="spotter-select-all${ownSelected ? " selected" : ""}"
                data-select-family="${escapeHtml(ownCard.family_id)}"
                aria-pressed="${ownSelected ? "true" : "false"}"
              >
                <span class="spotter-select-all-icon">${ownSelected ? "✓" : "+"}</span>
                <span>${ownSelected ? "Clear All" : "Select All"}</span>
              </button>
            </div>
            <div class="spotter-student-list">${ownStudentsHtml}</div>
          </section>
        ` : ""}
        <section class="spotter-students-section">
          <div class="spotter-section-head">
            <div>
              <p class="spotter-section-kicker">Authorized Kids</p>
              <h4 class="spotter-section-title">Students this family can pick up</h4>
            </div>
          </div>
          <div class="spotter-student-list">${authorizedStudentsHtml || '<p class="muted">No outside students are currently authorized for this family.</p>'}</div>
        </section>
        <p id="spotter-selection-summary" class="spotter-selection-summary">${
          totalSelected ? `${totalSelected} student${totalSelected === 1 ? "" : "s"} selected` : "Choose students or tap a saved carpool above."
        }</p>
        <button type="button" id="spotter-submit-selection" class="btn btn-primary spotter-submit-selection" ${totalSelected ? "" : "disabled"}>Check In ${totalSelected || ""} ${totalSelected === 1 ? "Student" : totalSelected ? "Students" : "Selected Students"}</button>
      </div>
    `;
    show("spotter-context-panel", true);
  }

  async function lookupCarpool() {
    const lookupFamily = resolveLookupFamily();
    if (!lookupFamily) {
      setMessage("Enter a family number or family name.", "error");
      return;
    }

    state.lookupFamily = lookupFamily;
    el("spotter-carpool-input").value = String(lookupFamily.carpool_number);
    renderQuickCarpools();

    try {
      state.context = await getCheckinContext(lookupFamily.carpool_number);
      resetTopSelections();
      renderContextPanel();
      setMessage("");
    } catch (error) {
      state.context = null;
      renderContextPanel();
      setMessage(error.message || `Unable to open ${familyDisplayName(lookupFamily)}`, "error");
    }
  }

  function collectTargets() {
    const targets = [];
    state.selectedByFamily.forEach((set, familyId) => {
      if (!set.size) return;
      targets.push({
        family_id: familyId,
        student_ids: Array.from(set)
      });
    });
    return targets;
  }

  async function submitSelected() {
    const number = state.lookupFamily?.carpool_number || resolveLookupFamily()?.carpool_number;
    const targets = collectTargets();
    if (!number || !targets.length) {
      setMessage("Choose at least one student.", "error");
      return;
    }

    try {
      const result = await submitCheckInRequest(number, targets);
      (result.families || []).forEach((family) => {
        (family.students || []).forEach((student) => state.statuses.set(student.student_id, "CALLED"));
      });
      renderTable();
      const names = (result.families || []).flatMap((family) =>
        (family.students || []).map((student) => `${student.first_name} ${student.last_name}`)
      );
      setMessage(`${names.join(", ")} called`, "success");
      state.context = null;
      state.lookupFamily = null;
      renderContextPanel();
      el("spotter-carpool-input").value = "";
      renderQuickCarpools();
      el("spotter-carpool-input").focus();
    } catch (error) {
      setMessage(error.message || "Unable to check in selection.", "error");
    }
  }

  async function fetchRoster() {
    const client = mustClient();

    const [studentsRes, statusRes] = await Promise.all([
      client
        .from("students")
        .select("id,first_name,last_name,class_id,family_id,classes(name),families(id,carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name)"),
      client.from("daily_status").select("student_id,status,attendance_status").eq("date", state.today)
    ]);

    if (studentsRes.error) throw studentsRes.error;
    if (statusRes.error) throw statusRes.error;

    const familyMap = new Map();
    (studentsRes.data || []).forEach((student) => {
      const family = student.families;
      if (!family || familyMap.has(family.id)) return;
      familyMap.set(family.id, {
        id: family.id,
        carpool_number: family.carpool_number,
        parent_names: family.parent_names || "",
        parent_one_title: family.parent_one_title || "",
        parent_one_first_name: family.parent_one_first_name || "",
        parent_one_last_name: family.parent_one_last_name || "",
        parent_two_title: family.parent_two_title || "",
        parent_two_first_name: family.parent_two_first_name || "",
        parent_two_last_name: family.parent_two_last_name || "",
        display_name: familyDisplayName(family)
      });
    });
    state.families = Array.from(familyMap.values());

    state.students = (studentsRes.data || []).map((s) => ({
      id: s.id,
      first_name: s.first_name,
      last_name: s.last_name,
      class_name: s.classes ? s.classes.name : "",
      carpool_number: s.families ? s.families.carpool_number : ""
    }));

    state.statuses = new Map();
    state.attendanceStatuses = new Map();
    (statusRes.data || []).forEach((row) => {
      state.statuses.set(row.student_id, row.status);
      if (row.attendance_status) state.attendanceStatuses.set(row.student_id, row.attendance_status);
    });
  }

  function onRealtime(payload) {
    const rec = payload.new || payload.old;
    if (!rec || rec.date !== state.today) return;
    state.statuses.set(rec.student_id, rec.status || "WAITING");
    if (rec.attendance_status) {
      state.attendanceStatuses.set(rec.student_id, rec.attendance_status);
    } else {
      state.attendanceStatuses.delete(rec.student_id);
    }
    renderTable();
    renderContextPanel();
  }

  function subscribeRealtime() {
    const client = mustClient();
    state.channel = client
      .channel("spotter-daily-status")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_status" }, onRealtime)
      .subscribe();
  }

  function bindUI() {
    el("spotter-checkin-btn").addEventListener("click", clearLookup);
    el("spotter-carpool-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        lookupCarpool();
      }
    });
    el("spotter-carpool-input").addEventListener("input", () => {
      state.lookupFamily = null;
      state.context = null;
      resetTopSelections();
      renderQuickCarpools();
      renderContextPanel();
      setMessage("");
    });

    el("spotter-quick-carpools").addEventListener("click", (event) => {
      const button = event.target.closest("[data-quick-carpool]");
      if (!button) return;
      el("spotter-carpool-input").value = button.dataset.quickCarpool;
      renderQuickCarpools();
      lookupCarpool();
    });

    el("spotter-context-panel").addEventListener("click", (event) => {
      const studentBtn = event.target.closest("[data-student-id]");
      if (studentBtn) {
        toggleStudentSelection(studentBtn.dataset.familyId, studentBtn.dataset.studentId);
        renderContextPanel();
        return;
      }

      const familyBtn = event.target.closest("[data-select-family]");
      if (familyBtn) {
        selectEntireFamily(familyBtn.dataset.selectFamily);
        renderContextPanel();
        return;
      }

      const presetBtn = event.target.closest("[data-preset-id]");
      if (presetBtn) {
        applyPresetSelection(presetBtn.dataset.presetId);
        renderContextPanel();
        return;
      }

      if (event.target.closest("#spotter-submit-selection")) {
        submitSelected();
      }
    });

    el("spotter-search").addEventListener("input", renderTable);
    el("spotter-sort").addEventListener("change", renderTable);
    el("spotter-checkin-message").addEventListener("click", () => setMessage(""));

    el("spotter-logout-btn").addEventListener("click", async () => {
      const client = mustClient();
      await client.auth.signOut();
      window.location.reload();
    });

    const submitSpotterLogin = async () => {
      const client = mustClient();
      show("spotter-login-error", false);

      const email = el("spotter-email").value.trim();
      const password = el("spotter-password").value;

      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        el("spotter-login-error").textContent = "Invalid email or password.";
        show("spotter-login-error", true);
        return;
      }

      window.location.reload();
    };

    el("spotter-login-btn").addEventListener("click", submitSpotterLogin);
    ["spotter-email", "spotter-password"].forEach((id) => {
      el(id)?.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submitSpotterLogin();
      });
    });
  }

  async function init() {
    if (!window.carpoolClient) {
      show("config-warning", true);
      return;
    }

    bindUI();

    try {
      const auth = await requireAuth("spotter");
      if (!auth.ok) {
        show("login-section", true);
        show("spotter-section", false);
        return;
      }

      show("login-section", false);
      show("spotter-section", true);

      state.today = await fetchSchoolToday();
      await fetchRoster();
      renderTable();
      renderQuickCarpools();
      subscribeRealtime();
      el("spotter-carpool-input").focus();
    } catch (error) {
      console.error("Spotter dashboard init failed", error);
      show("login-section", true);
      el("spotter-login-error").textContent = "Unable to load spotter dashboard. Please try again.";
      show("spotter-login-error", true);
    }
  }

  init();
})();
