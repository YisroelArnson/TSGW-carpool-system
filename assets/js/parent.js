(function parentPage() {
  const { mustClient, show, escapeHtml, familyDisplayName, formatWeekdays, fetchSchoolToday, attendanceBadgeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const STORAGE_KEY = "tsgw_carpool_number";
  const REPING_COOLDOWN_MS = 3 * 60 * 1000;
  const METERS_PER_FOOT = 0.3048;
  const METERS_PER_MILE = 1609.344;
  const state = {
    number: null,
    context: null,
    geofenceSettings: defaultGeofenceSettings(),
    selectedByFamily: new Map(),
    manualSelectedByFamily: new Map(),
    activePresetIds: new Set(),
    loading: false,
    checkinNotice: null,
    scheduledPickup: null,
    scheduleMinutes: 5,
    scheduleBusy: false,
    scheduleRefreshAt: 0,
    lastSubmittedStudents: [],
    repingBusyIds: new Set(),
    cancelBusyIds: new Set(),
    repingTimer: null,
    autoCall: {
      status: "idle",
      watchId: null,
      wakeLock: null,
      targets: [],
      message: "",
      note: "",
      lastDistanceMeters: null,
      lastAccuracyMeters: null,
      submitting: false
    }
  };

  function el(id) {
    return document.getElementById(id);
  }

  function defaultGeofenceSettings() {
    return {
      is_enabled: false,
      is_configured: false,
      school_latitude: null,
      school_longitude: null,
      radius_meters: 300
    };
  }

  function normalizeGeofenceSettings(settings) {
    return {
      ...defaultGeofenceSettings(),
      ...(settings || {}),
      school_latitude: settings?.school_latitude == null ? null : Number(settings.school_latitude),
      school_longitude: settings?.school_longitude == null ? null : Number(settings.school_longitude),
      radius_meters: Number(settings?.radius_meters || 300)
    };
  }

  function setBootPending(isPending) {
    document.documentElement.classList.toggle("parent-boot-pending", Boolean(isPending));
  }

  function setStudentsActive(isActive) {
    document.documentElement.classList.toggle("parent-checkin-active", Boolean(isActive));
  }

  function hideAllSections() {
    ["number-section", "students-section", "done-section"].forEach((id) => show(id, false));
    show("entry-card", true);
    show("students-section", false);
    show("done-card", false);
    show("sticky-checkin-bar", false);
    setStudentsActive(false);
  }

  function syncNumberUi() {
    const numberText = state.number ? String(state.number) : "";
    if (el("carpool-number")) el("carpool-number").value = numberText;
    show("parent-logout-btn", Boolean(numberText));
    show("parent-settings-link", Boolean(numberText));
  }

  function showError(id, message) {
    const node = el(id);
    if (!node) return;
    node.textContent = message;
    show(id, true);
  }

  function clearError(id) {
    const node = el(id);
    if (!node) return;
    node.textContent = "";
    show(id, false);
  }

  function selectedCheckInActor() {
    const family = state.context?.requesting_family;
    return family ? familyDisplayName(family) : "";
  }

  async function getCheckinContext(number) {
    const client = mustClient();
    const { data, error } = await client.rpc("get_parent_checkin_context", {
      p_carpool_number: Number(number)
    });
    if (error) throw error;
    return data;
  }

  async function submitCheckInRequest(targets) {
    const client = mustClient();
    const { data, error } = await client.rpc("submit_check_in_request", {
      p_requesting_carpool_number: Number(state.number),
      p_targets: targets,
      p_called_by: "parent",
      p_checked_in_by: selectedCheckInActor()
    });
    if (error) throw error;
    return data;
  }

  async function submitPresetCheckIn(presetId) {
    const client = mustClient();
    const { data, error } = await client.rpc("submit_carpool_preset_check_in", {
      p_preset_id: presetId,
      p_owner_carpool_number: Number(state.number),
      p_called_by: "parent",
      p_checked_in_by: selectedCheckInActor()
    });
    if (error) throw error;
    return data;
  }

  async function createScheduledPickup(targets, sendAt) {
    const client = mustClient();
    const { data, error } = await client.rpc("create_scheduled_pickup_request", {
      p_requesting_carpool_number: Number(state.number),
      p_targets: targets,
      p_send_at: sendAt,
      p_checked_in_by: selectedCheckInActor()
    });
    if (error) throw error;
    return data;
  }

  async function getPendingScheduledPickup() {
    const client = mustClient();
    const { data, error } = await client.rpc("get_pending_scheduled_pickup_request", {
      p_requesting_carpool_number: Number(state.number)
    });
    if (error) throw error;
    return data;
  }

  async function getPickupGeofenceSettings() {
    const client = mustClient();
    const { data, error } = await client.rpc("get_pickup_geofence_settings");
    if (error) throw error;
    return normalizeGeofenceSettings(data);
  }

  async function cancelScheduledPickupRequest(requestId) {
    const client = mustClient();
    const { data, error } = await client.rpc("cancel_scheduled_pickup_request", {
      p_request_id: requestId,
      p_requesting_carpool_number: Number(state.number)
    });
    if (error) throw error;
    return data;
  }

  async function cancelParentCheckInRequest(studentIds) {
    const client = mustClient();
    const { data, error } = await client.rpc("cancel_parent_check_in_request", {
      p_requesting_carpool_number: Number(state.number),
      p_student_ids: studentIds
    });
    if (error) throw error;
    return data;
  }

  function isRepingCooldownError(error) {
    const message = String(error?.message || "").toLowerCase();
    return message.includes("reping") || message.includes("already active");
  }

  function showNumberStep(clearNumberError) {
    hideAllSections();
    show("number-section", true);
    if (clearNumberError) clearError("number-error");
    syncNumberUi();
    if (el("carpool-number")) el("carpool-number").focus();
  }

  function resetSelections() {
    state.selectedByFamily = new Map();
    state.manualSelectedByFamily = new Map();
    const ownFamilyId = state.context?.requesting_family?.family_id;
    if (ownFamilyId) {
      state.selectedByFamily.set(ownFamilyId, new Set());
      state.manualSelectedByFamily.set(ownFamilyId, new Set());
    }
    (state.context?.authorized_pickups || []).forEach((family) => {
      state.selectedByFamily.set(family.family_id, new Set());
      state.manualSelectedByFamily.set(family.family_id, new Set());
    });
    state.activePresetIds = new Set();
  }

  function familyCards() {
    if (!state.context) return [];
    const ownFamily = state.context.requesting_family;
    const cards = [{
      family_id: ownFamily.family_id,
      display_name: familyDisplayName(ownFamily),
      students: state.context.own_students || [],
      label: "Your Family",
      note: ""
    }];

    (state.context.authorized_pickups || []).forEach((family) => {
      cards.push({
        family_id: family.family_id,
        display_name: familyDisplayName(family),
        students: family.students || [],
        label: "Students You're Going To Pick Up",
        note: `Approved from ${family.starts_on} to ${family.ends_on}`
      });
    });

    return cards;
  }

  function selectedCount() {
    let count = 0;
    state.selectedByFamily.forEach((ids) => {
      count += ids.size;
    });
    return count;
  }

  function isStudentCheckedIn(student) {
    return Boolean(student?.is_checked_in);
  }

  function studentCooldownUntil(student) {
    if (!student) return 0;
    if (student.retry_at) return new Date(student.retry_at).getTime();
    if (student.called_at) return new Date(student.called_at).getTime() + REPING_COOLDOWN_MS;
    return 0;
  }

  function isStudentCoolingDown(student) {
    return studentCooldownUntil(student) > Date.now();
  }

  function formatCooldown(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${seconds}s`;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function formatScheduleRemaining(ms) {
    if (ms <= 0) return "0:00";
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function formatScheduleTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function metersToFeet(meters) {
    return Math.round(Number(meters || 0) / METERS_PER_FOOT);
  }

  function formatDistance(meters) {
    const value = Number(meters);
    if (!Number.isFinite(value)) return "";
    if (value >= METERS_PER_MILE * 0.25) {
      return `${(value / METERS_PER_MILE).toFixed(1)} mi`;
    }
    return `${Math.max(1, Math.round(value / METERS_PER_FOOT))} ft`;
  }

  function distanceMeters(aLat, aLng, bLat, bLng) {
    const toRad = (deg) => deg * Math.PI / 180;
    const radius = 6371000;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function allCheckinStudents() {
    return familyCards().flatMap((family) =>
      (family.students || []).map((student) => ({
        ...student,
        family_id: family.family_id
      }))
    );
  }

  function contextStudentGroups(context) {
    return [
      context?.own_students || [],
      ...(context?.authorized_pickups || []).map((family) => family.students || [])
    ];
  }

  async function applyStudentCallLabels(context) {
    const studentGroups = contextStudentGroups(context);
    const studentIds = [...new Set(
      studentGroups
        .flatMap((students) => students || [])
        .map((student) => student?.student_id)
        .filter(Boolean)
        .map(String)
    )];
    if (!studentIds.length) return;

    try {
      const client = mustClient();
      const today = fetchSchoolToday ? await fetchSchoolToday() : new Date().toISOString().slice(0, 10);
      const { data, error } = await client
        .from("daily_status")
        .select("student_id,called_by,checked_in_by,pickup_family_label")
        .eq("date", today)
        .eq("status", "CALLED")
        .in("student_id", studentIds);
      if (error) throw error;

      const statusByStudent = new Map((data || []).map((row) => [String(row.student_id), row]));

      studentGroups.forEach((students) => {
        (students || []).forEach((student) => {
          const status = statusByStudent.get(String(student.student_id));
          if (!status) return;

          student.called_by = status.called_by || student.called_by;
          student.checked_in_by = status.checked_in_by || "";
          student.pickup_family_label = String(status.pickup_family_label || "").trim();
        });
      });
    } catch (error) {
      console.warn("Unable to load student call labels", error);
    }
  }

  function callSourceDisplayName(source) {
    const normalized = String(source || "").trim().toLowerCase();
    if (normalized === "admin") return "Administrator";
    if (normalized === "spotter") return "Spotter";
    if (normalized === "parent") return "Parent";
    if (!normalized) return "";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function studentCalledByLabel(student) {
    if (!isStudentCheckedIn(student)) return "";
    const source = String(student?.called_by || "").trim().toLowerCase();
    if (source === "parent") {
      return String(student?.pickup_family_label || "").trim() || "Parent";
    }
    if (source === "admin" || source === "spotter") {
      return callSourceDisplayName(source);
    }
    return String(student?.pickup_family_label || student?.checked_in_by || "").trim() || callSourceDisplayName(source);
  }

  function scheduledStudentIds() {
    const ids = new Set();
    if (!state.scheduledPickup || state.scheduledPickup.status !== "pending") return ids;

    (state.scheduledPickup.targets || []).forEach((target) => {
      (target.student_ids || []).forEach((studentId) => ids.add(String(studentId)));
    });

    return ids;
  }

  function scheduledStudents() {
    const ids = scheduledStudentIds();
    if (!ids.size) return [];
    return allCheckinStudents().filter((student) => ids.has(String(student.student_id)));
  }

  function scheduledStudentNames() {
    return scheduledStudents().map((student) => `${student.first_name} ${student.last_name}`);
  }

  function formatScheduledNames(names) {
    if (!names.length) {
      const count = Number(state.scheduledPickup?.target_count || 0);
      return `${count} ${count === 1 ? "child" : "children"}`;
    }
    if (names.length <= 2) return names.join(", ");
    return `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
  }

  function checkedInStudentIds() {
    return new Set(
      familyCards()
        .flatMap((family) => family.students || [])
        .filter((student) => isStudentCheckedIn(student))
        .map((student) => String(student.student_id))
    );
  }

  function manualSelectedCount() {
    let count = 0;
    state.manualSelectedByFamily.forEach((ids) => {
      count += ids.size;
    });
    return count;
  }

  function collectTargets() {
    const targets = [];
    state.selectedByFamily.forEach((ids, familyId) => {
      if (!ids.size) return;
      targets.push({
        family_id: familyId,
        student_ids: Array.from(ids)
      });
    });
    return targets;
  }

  function collectAutoCallTargets() {
    return collectTargets();
  }

  function autoCallTargetStudents(targets) {
    const targetIds = new Set((targets || []).flatMap((target) => target.student_ids || []).map(String));
    return allCheckinStudents().filter((student) => targetIds.has(String(student.student_id)));
  }

  function autoCallTargetLabel(targets) {
    const students = autoCallTargetStudents(targets);
    const names = students.map((student) => `${student.first_name} ${student.last_name}`);
    if (!names.length) return "selected children";
    if (names.length <= 2) return names.join(", ");
    return `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
  }

  function rebuildSelections() {
    const merged = new Map();
    const lockedStudentIds = checkedInStudentIds();

    state.manualSelectedByFamily.forEach((ids, familyId) => {
      merged.set(familyId, new Set(Array.from(ids).filter((studentId) => !lockedStudentIds.has(String(studentId)))));
    });

    (state.context?.saved_carpools || []).forEach((preset) => {
      if (!state.activePresetIds.has(preset.preset_id)) return;
      (preset.students || []).forEach((student) => {
        if (lockedStudentIds.has(String(student.student_id))) return;
        const familyId = student.family_id;
        if (!merged.has(familyId)) merged.set(familyId, new Set());
        merged.get(familyId).add(String(student.student_id));
      });
    });

    state.selectedByFamily = merged;
  }

  function clearActivePresets() {
    state.activePresetIds = new Set();
    rebuildSelections();
  }

  function applyPresetSelection(presetId) {
    if (state.activePresetIds.has(presetId)) {
      state.activePresetIds.delete(presetId);
      rebuildSelections();
      renderCheckinPage();
      return;
    }

    const preset = (state.context?.saved_carpools || []).find((item) => item.preset_id === presetId);
    if (!preset) return;

    state.activePresetIds.add(preset.preset_id);
    rebuildSelections();
    renderCheckinPage();
  }

  function toggleStudentSelection(familyId, studentId) {
    const student = familyCards()
      .flatMap((family) => family.students || [])
      .find((entry) => String(entry.student_id) === String(studentId));
    if (isStudentCheckedIn(student)) return;

    const wasSelected = (state.selectedByFamily.get(familyId) || new Set()).has(studentId);
    clearActivePresets();
    const selected = state.manualSelectedByFamily.get(familyId) || new Set();
    if (wasSelected) selected.delete(studentId);
    else selected.add(studentId);
    state.manualSelectedByFamily.set(familyId, selected);
    rebuildSelections();
    renderCheckinPage();
  }

  function selectEntireFamily(familyId) {
    clearActivePresets();
    const card = familyCards().find((item) => item.family_id === familyId);
    const allStudentIds = (card?.students || [])
      .filter((student) => !isStudentCheckedIn(student))
      .map((student) => String(student.student_id));
    const current = state.selectedByFamily.get(familyId) || new Set();
    const hasAllSelected = allStudentIds.length > 0 && allStudentIds.every((studentId) => current.has(studentId));
    const next = hasAllSelected ? new Set() : new Set(allStudentIds);
    state.manualSelectedByFamily.set(familyId, next);
    rebuildSelections();
    renderCheckinPage();
  }

  function renderPresetCards() {
    const presets = state.context?.saved_carpools || [];
    const list = el("saved-carpools-list");
    if (!list) return;

    if (!presets.length) {
      list.innerHTML = "";
      show("saved-carpools-section", false);
      return;
    }

    show("saved-carpools-section", true);

    list.innerHTML = presets.map((preset) => {
      const isActive = state.activePresetIds.has(preset.preset_id);
      const preview = (preset.students || [])
        .map((student) => `${student.first_name} ${student.last_name}`)
        .join(", ");
      const dayText = formatWeekdays(preset.weekdays || [], true);
      const count = Number(preset.student_count || 0);

      return `
        <button
          type="button"
          class="selection-row${isActive ? " selected" : ""}"
          data-preset-id="${escapeHtml(preset.preset_id)}"
          aria-pressed="${isActive ? "true" : "false"}"
        >
          <span class="selection-row-main">
            <span class="selection-row-toggle">${isActive ? "✓" : "+"}</span>
            <span class="selection-row-copy">
              <span class="selection-row-name">${escapeHtml(preset.name || "Quick Pick")}</span>
              <span class="selection-row-meta">${escapeHtml(`${dayText} | ${preview || "No children"}`)}</span>
            </span>
          </span>
          <span class="selection-row-count">${escapeHtml(String(count))} ${count === 1 ? "child" : "children"}</span>
        </button>
      `;
    }).join("");
  }

  function renderFamilyGroups() {
    const ownCard = familyCards()[0];
    const authorizedCards = familyCards().slice(1);

    el("your-students-list").innerHTML = ownCard ? familyCardHtml(ownCard) : "";
    el("authorized-students-list").innerHTML = authorizedCards.length
      ? authorizedCards.map(familyCardHtml).join("")
      : '<p class="muted empty-state">No outside students are currently authorized for your family.</p>';

    syncSelectAllButton(ownCard);
    show("authorized-students-section", authorizedCards.length > 0);
  }

  function syncSelectAllButton(card) {
    const button = el("select-all-children");
    const icon = el("select-all-children-icon");
    const label = el("select-all-children-label");
    if (!button || !icon || !label) return;

    const studentIds = (card?.students || [])
      .filter((student) => !isStudentCheckedIn(student))
      .map((student) => String(student.student_id));
    const selected = card ? (state.selectedByFamily.get(card.family_id) || new Set()) : new Set();
    const hasChildren = studentIds.length > 0;
    const hasAllSelected = hasChildren && studentIds.every((studentId) => selected.has(studentId));

    if (!hasChildren || !card) {
      button.dataset.selectFamily = "";
      button.classList.add("hidden");
      button.classList.remove("selected");
      icon.textContent = "+";
      label.textContent = "Select All";
      return;
    }

    button.dataset.selectFamily = String(card.family_id);
    button.classList.remove("hidden");
    button.classList.toggle("selected", hasAllSelected);
    icon.textContent = hasAllSelected ? "✓" : "+";
    label.textContent = hasAllSelected ? "Clear All" : "Select All";
  }

  function studentScheduleText() {
    const sendAt = new Date(state.scheduledPickup?.send_at || "").getTime();
    if (!sendAt || Number.isNaN(sendAt)) return "Request scheduled.";
    if (sendAt <= Date.now()) return "Request is being sent shortly.";
    const remaining = formatScheduleRemaining(sendAt - Date.now());
    const timeText = formatScheduleTime(state.scheduledPickup.send_at);
    return timeText ? `Request sending in ${remaining} at ${timeText}.` : `Request sending in ${remaining}.`;
  }

  function studentRecallButtonHtml(student, familyId) {
    const studentId = String(student.student_id);
    const isBusy = state.repingBusyIds.has(studentId);
    const isCoolingDown = isStudentCoolingDown(student);
    const buttonLabel = isBusy ? "Calling..." : (isCoolingDown ? `Re-ping in ${formatCooldown(studentCooldownUntil(student) - Date.now())}` : "Call Again");

    return `
      <button
        type="button"
        class="student-recall-btn"
        data-reping-student="${escapeHtml(studentId)}"
        data-reping-family="${escapeHtml(familyId)}"
        aria-disabled="${isBusy || isCoolingDown ? "true" : "false"}"
        ${isBusy || isCoolingDown ? "disabled" : ""}
      >
        ${escapeHtml(buttonLabel)}
      </button>
    `;
  }

  function studentCancelButtonHtml(student) {
    const studentId = String(student.student_id);
    const isBusy = state.cancelBusyIds.has(studentId);
    const studentName = `${student.first_name} ${student.last_name}`.trim() || "student";
    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 1 1 0 11H11"/></svg>';

    return `
      <button
        type="button"
        class="student-cancel-btn"
        data-cancel-student="${escapeHtml(studentId)}"
        aria-label="${escapeHtml(`Cancel pickup request for ${studentName}`)}"
        title="Cancel pickup request"
        aria-disabled="${isBusy ? "true" : "false"}"
        ${isBusy ? "disabled" : ""}
      >
        ${isBusy ? "..." : icon}
      </button>
    `;
  }

  function studentCallActionsHtml(student, familyId) {
    return `
      <span class="student-call-actions">
        ${studentRecallButtonHtml(student, familyId)}
        ${studentCancelButtonHtml(student)}
      </span>
    `;
  }

  function familyCardHtml(card) {
    const selected = state.selectedByFamily.get(card.family_id) || new Set();
    const pendingStudentIds = scheduledStudentIds();
    const studentsHtml = (card.students || []).map((student) => {
      const studentId = String(student.student_id);
      const isSelected = selected.has(studentId);
      const isCheckedIn = isStudentCheckedIn(student);
      const isScheduled = !isCheckedIn && pendingStudentIds.has(studentId);
      const studentName = `${student.first_name} ${student.last_name}`;
      const calledByLabel = studentCalledByLabel(student);
      const studentCopy = `
        <span class="selection-row-main">
          <span class="selection-row-toggle">${isCheckedIn || isSelected ? "✓" : "+"}</span>
          <span class="student-pick-content">
            <span class="student-pick-name">${escapeHtml(studentName)}</span>
            <span class="student-pick-meta-row">
              ${student.class_name ? `<small class="student-pick-grade">${escapeHtml(student.class_name)}</small>` : ""}
              ${attendanceBadgeHtml ? attendanceBadgeHtml(student.attendance_status) : ""}
              ${calledByLabel ? `<small class="student-pick-called-by">Called By: ${escapeHtml(calledByLabel)}</small>` : ""}
            </span>
            ${isScheduled ? `<small class="student-pick-scheduled">${escapeHtml(studentScheduleText())}</small>` : ""}
          </span>
        </span>
      `;

      if (isCheckedIn) {
        return `
          <div class="selection-row student-pick checked-in" data-family-id="${escapeHtml(card.family_id)}">
            ${studentCopy}
            ${studentCallActionsHtml(student, card.family_id)}
          </div>
        `;
      }

      return `
        <button
          type="button"
          class="selection-row student-pick${isSelected ? " selected" : ""}${isScheduled ? " scheduled" : ""}"
          data-family-id="${escapeHtml(card.family_id)}"
          data-student-id="${escapeHtml(studentId)}"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          ${studentCopy}
        </button>
      `;
    }).join("");

    return `
      <article class="family-card">
        <div class="family-card-head">
          <div class="family-card-hero">
            ${card.label === "Your Family" ? "" : `<h3>${escapeHtml(card.display_name || "Family")}</h3>`}
          </div>
        </div>
        <div class="family-students">${studentsHtml}</div>
      </article>
    `;
  }

  function setScheduleError(message) {
    const node = el("schedule-modal-error");
    if (!node) return;
    node.textContent = message || "";
    show("schedule-modal-error", Boolean(message));
  }

  function syncScheduleModal() {
    const minutes = Math.max(1, Math.min(60, Number(state.scheduleMinutes) || 5));
    state.scheduleMinutes = minutes;

    const value = el("schedule-minutes-value");
    if (value) value.textContent = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

    document.querySelectorAll("[data-schedule-minutes]").forEach((button) => {
      button.classList.toggle("selected", Number(button.dataset.scheduleMinutes) === minutes);
    });

    const submit = el("schedule-submit");
    if (submit) {
      submit.disabled = state.scheduleBusy || !selectedCount();
      submit.textContent = state.scheduledPickup ? "Replace Timer" : "Start Timer";
    }

    const close = el("schedule-modal-close");
    if (close) close.textContent = state.scheduledPickup ? "Close" : "Cancel";
  }

  function openScheduleModal() {
    if (!state.scheduledPickup && !selectedCount()) {
      showError("students-error", "Choose at least one child before setting a timer.");
      return;
    }
    clearError("students-error");
    setScheduleError("");
    syncScheduleModal();
    show("schedule-modal", true);
  }

  function closeScheduleModal() {
    show("schedule-modal", false);
    setScheduleError("");
  }

  function renderScheduleStatus() {
    const scheduled = state.scheduledPickup;
    const title = el("sticky-schedule-title");
    const meta = el("sticky-schedule-meta");
    const cancel = el("sticky-schedule-cancel");

    if (!scheduled || scheduled.status !== "pending") {
      show("sticky-schedule-status", false);
      return;
    }

    const sendAt = new Date(scheduled.send_at).getTime();
    const msRemaining = sendAt - Date.now();
    const names = scheduledStudentNames();
    const namesText = formatScheduledNames(names);
    const titleName = names.length === 1 ? names[0] : namesText;
    if (title) {
      title.textContent = msRemaining <= 0
        ? `Sending ${titleName} shortly`
        : `Sending ${titleName} in ${formatScheduleRemaining(msRemaining)}`;
    }
    if (meta) {
      const timeText = formatScheduleTime(scheduled.send_at);
      meta.textContent = timeText ? `Scheduled for ${timeText}` : namesText;
    }
    if (cancel) cancel.disabled = state.scheduleBusy;
    show("sticky-schedule-status", true);
  }

  function geofenceIsReady() {
    const settings = state.geofenceSettings || defaultGeofenceSettings();
    return Boolean(
      settings.is_enabled
      && settings.is_configured
      && Number.isFinite(Number(settings.school_latitude))
      && Number.isFinite(Number(settings.school_longitude))
      && Number(settings.radius_meters) > 0
    );
  }

  function isAutoCallActive() {
    return ["arming", "watching", "submitting"].includes(state.autoCall.status);
  }

  function clearAutoCallWatch() {
    if (state.autoCall.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(state.autoCall.watchId);
    }
    state.autoCall.watchId = null;
  }

  async function releaseAutoCallWakeLock() {
    const wakeLock = state.autoCall.wakeLock;
    state.autoCall.wakeLock = null;
    if (!wakeLock) return;
    try {
      await wakeLock.release();
    } catch (_error) {
      // The browser may release the wake lock before our cleanup runs.
    }
  }

  async function requestAutoCallWakeLock() {
    if (!navigator.wakeLock || document.visibilityState !== "visible") return false;
    try {
      const wakeLock = await navigator.wakeLock.request("screen");
      state.autoCall.wakeLock = wakeLock;
      wakeLock.addEventListener("release", () => {
        if (state.autoCall.wakeLock === wakeLock) state.autoCall.wakeLock = null;
        if (isAutoCallActive() && document.visibilityState === "visible") {
          state.autoCall.note = "Please keep this screen open. Students will be called automatically when you are close enough.";
          renderStickyBar();
        }
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  function setAutoCallStatus(status, message, note) {
    state.autoCall.status = status;
    state.autoCall.message = message || "";
    state.autoCall.note = note || "";
    renderStickyBar();
  }

  function stopAutoCall(options = {}) {
    clearAutoCallWatch();
    releaseAutoCallWakeLock();
    state.autoCall = {
      status: options.status || "idle",
      watchId: null,
      wakeLock: null,
      targets: options.targets || [],
      message: options.message || "",
      note: options.note || "",
      lastDistanceMeters: null,
      lastAccuracyMeters: null,
      submitting: false
    };
    renderStickyBar();
  }

  function renderAutoCallStatus() {
    const wrapper = el("auto-call-overlay");
    const title = el("auto-call-overlay-title");
    const meta = el("auto-call-overlay-copy");
    const detail = el("auto-call-overlay-detail");
    const cancel = el("auto-call-overlay-cancel");
    if (!wrapper || !title || !meta || !cancel) return;

    if (state.autoCall.status === "idle" || !state.autoCall.message) {
      show("auto-call-overlay", false);
      return;
    }

    title.textContent = state.autoCall.message;
    meta.textContent = state.autoCall.note || "Please keep this screen open. Students will be called automatically when you are close enough.";
    if (detail) {
      const radiusText = formatDistance(state.geofenceSettings?.radius_meters || 0);
      const distanceText = formatDistance(state.autoCall.lastDistanceMeters);
      detail.textContent = state.autoCall.status === "watching" && distanceText
        ? `Current distance: ${distanceText}. Call radius: ${radiusText}.`
        : `Call radius: ${radiusText}.`;
    }
    cancel.textContent = state.autoCall.status === "done" || state.autoCall.status === "error" ? "Dismiss" : "Cancel";
    cancel.disabled = state.autoCall.status === "submitting";
    wrapper.classList.toggle("success", state.autoCall.status === "done");
    wrapper.classList.toggle("error", state.autoCall.status === "error");
    show("auto-call-overlay", true);
  }

  function renderStickyBar() {
    const count = selectedCount();
    const submit = el("students-submit");
    const scheduleBtn = el("schedule-pickup-open");
    const locationBtn = el("auto-call-location");
    const isStudentsStepActive = document.documentElement.classList.contains("parent-checkin-active");
    if (submit) {
      submit.disabled = !count || state.loading;
      submit.textContent = `I'm Here For ${count} ${count === 1 ? "Child" : "Children"}`;
    }
    if (scheduleBtn) scheduleBtn.disabled = (!count && !state.scheduledPickup) || state.loading || state.scheduleBusy;
    if (locationBtn) locationBtn.disabled = !count || !geofenceIsReady() || state.loading || state.scheduleBusy || isAutoCallActive();
    renderScheduleStatus();
    renderAutoCallStatus();
    show("sticky-checkin-bar", isStudentsStepActive && state.number && Boolean(state.context));
  }

  function renderCheckinNotice() {
    const notice = el("checkin-notice");
    const title = el("checkin-notice-title");
    const copy = el("checkin-notice-copy");
    if (!notice || !title || !copy) return;

    if (!state.checkinNotice?.message) {
      title.textContent = "";
      copy.textContent = "";
      show("checkin-notice", false);
      return;
    }

    title.textContent = state.checkinNotice.message;
    copy.textContent = state.checkinNotice.note || "The school has been notified.";
    show("checkin-notice", true);
  }

  function renderCheckinPage() {
    renderCheckinNotice();
    renderPresetCards();
    renderFamilyGroups();
    renderStickyBar();
  }

  async function loadFamily(number) {
    const [context, geofenceSettings] = await Promise.all([
      getCheckinContext(number),
      getPickupGeofenceSettings().catch(() => defaultGeofenceSettings())
    ]);
    state.context = context;
    state.geofenceSettings = geofenceSettings;
    await applyStudentCallLabels(state.context);
    state.scheduledPickup = state.context?.scheduled_pickup || await getPendingScheduledPickup();
    resetSelections();
    renderCheckinPage();
  }

  async function finishLogin(nextNumber) {
    state.number = nextNumber;
    await loadFamily(nextNumber);
    syncNumberUi();
    localStorage.setItem(STORAGE_KEY, String(state.number));
    hideAllSections();
    show("entry-card", false);
    show("students-section", true);
    setStudentsActive(true);
    renderStickyBar();
  }

  async function continueWithNumber(number) {
    clearError("number-error");
    clearError("students-error");
    state.checkinNotice = null;

    if (!number) {
      showError("number-error", "Please enter your family number.");
      return;
    }

    try {
      await finishLogin(Number(number));
    } catch (error) {
      showError("number-error", error.message || "Unable to connect. Please try again.");
    }
  }

  async function restoreSavedSession(number) {
    hideAllSections();
    show("entry-card", false);

    try {
      await finishLogin(Number(number));
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
      state.number = null;
      state.context = null;
      syncNumberUi();
      showNumberStep(true);
      showError("number-error", "Please enter your family number to continue.");
    }
  }

  function setDoneState(message, note) {
    el("done-message").textContent = message;
    el("done-note").textContent = note || "";
    show("done-note", Boolean(note));
    hideAllSections();
    show("entry-card", false);
    show("done-card", true);
    show("done-section", true);
    setDoneRepingStatus("");
    renderDoneRepingActions();
  }

  function formatCalledStudents(result) {
    return (result.families || []).flatMap((family) =>
      (family.students || []).map((student) => `${student.first_name} ${student.last_name}`)
    );
  }

  function formatSkippedStudents(result) {
    return (result.skipped_students || []).map((student) => `${student.first_name} ${student.last_name}`);
  }

  function flattenCalledStudents(result) {
    return (result.families || []).flatMap((family) =>
      (family.students || []).map((student) => ({
        family_id: family.family_id,
        student_id: String(student.student_id),
        first_name: student.first_name,
        last_name: student.last_name,
        class_name: student.class_name || "",
        cooldownUntil: Date.now() + REPING_COOLDOWN_MS
      }))
    );
  }

  function flattenSkippedStudents(result) {
    return (result.skipped_students || []).map((student) => ({
      family_id: student.family_id,
      student_id: String(student.student_id),
      first_name: student.first_name,
      last_name: student.last_name,
      class_name: student.class_name || "",
      cooldownUntil: student.retry_at ? new Date(student.retry_at).getTime() : (Date.now() + REPING_COOLDOWN_MS)
    }));
  }

  function rememberLastSubmittedStudents(result) {
    const merged = new Map();

    [...flattenCalledStudents(result), ...flattenSkippedStudents(result)].forEach((student) => {
      const existing = merged.get(student.student_id);
      if (!existing || student.cooldownUntil > existing.cooldownUntil) {
        merged.set(student.student_id, student);
      }
    });

    state.lastSubmittedStudents = Array.from(merged.values());
  }

  function mergeSubmissionResults(results) {
    const familyMap = new Map();
    const skippedMap = new Map();

    results.forEach((result) => {
      (result.families || []).forEach((family) => {
        const existing = familyMap.get(family.family_id) || {
          family_id: family.family_id,
          carpool_number: family.carpool_number,
          display_name: family.display_name || familyDisplayName(family),
          students: []
        };
        existing.students.push(...(family.students || []));
        familyMap.set(family.family_id, existing);
      });

      (result.skipped_students || []).forEach((student) => {
        skippedMap.set(student.student_id, student);
      });
    });

    const families = Array.from(familyMap.values()).map((family) => ({
      ...family,
      students: family.students.sort((a, b) =>
        `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)
      )
    })).sort((a, b) => Number(a.carpool_number || 0) - Number(b.carpool_number || 0));

    const skippedStudents = Array.from(skippedMap.values()).sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)
    );

    return {
      called_by: "parent",
      checked_in_by: selectedCheckInActor(),
      families,
      skipped_students: skippedStudents
    };
  }

  async function submitTargetsIndividually(targets) {
    const results = [];

    for (const target of targets) {
      for (const studentId of target.student_ids || []) {
        try {
          const result = await submitCheckInRequest([{
            family_id: target.family_id,
            student_ids: [studentId]
          }]);
          results.push(result || { families: [], skipped_students: [] });
        } catch (error) {
          if (!isRepingCooldownError(error)) throw error;

          const student = familyCards()
            .flatMap((family) => family.students || [])
            .find((entry) => String(entry.student_id) === String(studentId));

          results.push({
            families: [],
            skipped_students: [{
              family_id: target.family_id,
              student_id: String(studentId),
              first_name: student?.first_name || "Student",
              last_name: student?.last_name || "",
              class_name: student?.class_name || "",
              retry_at: new Date(Date.now() + REPING_COOLDOWN_MS).toISOString()
            }]
          });
        }
      }
    }

    return mergeSubmissionResults(results);
  }

  function buildDoneCopy(result, defaultNote) {
    const requestedStudents = [...new Set([
      ...formatCalledStudents(result),
      ...formatSkippedStudents(result)
    ])];

    if (requestedStudents.length) {
      return {
        message: `Pickup request sent for ${requestedStudents.join(", ")}.`,
        note: ""
      };
    }

    return {
      message: "No students were updated.",
      note: defaultNote || ""
    };
  }

  function setDoneRepingStatus(message, klass) {
    const node = el("done-reping-status");
    if (!node) return;
    node.className = `done-reping-status${klass ? ` ${klass}` : ""}`;
    node.textContent = message || "";
    show("done-reping-status", Boolean(message));
  }

  function renderDoneRepingActions() {
    const section = el("done-reping-section");
    const list = el("done-reping-list");
    if (!section || !list) return;

    if (!state.lastSubmittedStudents.length) {
      list.innerHTML = "";
      show("done-reping-section", false);
      return;
    }

    list.innerHTML = state.lastSubmittedStudents.map((student) => {
      const fullName = `${student.first_name} ${student.last_name}`;
      const msRemaining = student.cooldownUntil - Date.now();
      const isBusy = state.repingBusyIds.has(student.student_id);
      const isCancelBusy = state.cancelBusyIds.has(student.student_id);
      const isCoolingDown = msRemaining > 0;
      const metaParts = [];
      const cancelIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 1 1 0 11H11"/></svg>';
      if (student.class_name) {
        metaParts.push(`<span class="done-reping-meta">${escapeHtml(student.class_name)}</span>`);
      }
      const meta = metaParts.length ? `<span class="done-reping-meta-row">${metaParts.join("")}</span>` : "";
      const buttonLabel = isBusy ? "Calling..." : "Call Again";

      return `
        <div class="selection-row done-reping-row${isCoolingDown ? " is-cooling-down" : ""}">
          <span class="selection-row-copy">
            <span class="selection-row-name">${escapeHtml(fullName)}</span>
            ${meta}
          </span>
          <span class="student-call-actions">
            <button
              type="button"
              class="done-reping-btn${isCoolingDown ? " is-cooling-down" : ""}"
              data-reping-student="${escapeHtml(student.student_id)}"
              aria-disabled="${isBusy || isCoolingDown ? "true" : "false"}"
              ${isBusy || isCoolingDown ? "disabled" : ""}
            >
              ${escapeHtml(buttonLabel)}
            </button>
            <button
              type="button"
              class="done-cancel-btn"
              data-cancel-student="${escapeHtml(student.student_id)}"
              aria-label="${escapeHtml(`Cancel pickup request for ${fullName}`)}"
              title="Cancel pickup request"
              aria-disabled="${isCancelBusy ? "true" : "false"}"
              ${isCancelBusy ? "disabled" : ""}
            >
              ${isCancelBusy ? "..." : cancelIcon}
            </button>
          </span>
        </div>
      `;
    }).join("");

    show("done-reping-section", true);
  }

  async function submitAutoCallTargets() {
    if (state.autoCall.submitting) return;
    const targets = state.autoCall.targets || [];
    if (!targets.length) {
      stopAutoCall({
        status: "error",
        message: "Choose at least one child.",
        note: "Auto call was not started."
      });
      return;
    }

    state.autoCall.submitting = true;
    clearAutoCallWatch();
    setAutoCallStatus("submitting", "Sending pickup request...", "The school will be notified shortly.");

    try {
      let result;
      try {
        result = await submitCheckInRequest(targets);
      } catch (error) {
        if (!isRepingCooldownError(error)) throw error;
        result = await submitTargetsIndividually(targets);
      }

      const pendingRequestId = state.scheduledPickup?.status === "pending" ? state.scheduledPickup.request_id : null;
      if (pendingRequestId) {
        await cancelScheduledPickupRequest(pendingRequestId).catch(() => {});
        state.scheduledPickup = null;
      }

      rememberLastSubmittedStudents(result);
      const doneCopy = buildDoneCopy(result, "The school has been notified automatically.");
      state.checkinNotice = {
        message: doneCopy.message,
        note: "Triggered automatically when you got near school."
      };
      await releaseAutoCallWakeLock();
      state.autoCall.submitting = false;
      state.autoCall.status = "done";
      state.autoCall.message = doneCopy.message;
      state.autoCall.note = "Triggered automatically when you got near school.";
      await loadFamily(state.number).catch(() => {});
    } catch (error) {
      await releaseAutoCallWakeLock();
      state.autoCall.submitting = false;
      stopAutoCall({
        status: "error",
        targets,
        message: "Auto call could not send.",
        note: error.message || "Use the I'm Here button or timer instead."
      });
      return;
    }

    renderCheckinPage();
  }

  function handleAutoCallPosition(position) {
    if (!isAutoCallActive() || state.autoCall.status === "submitting") return;

    const settings = state.geofenceSettings || defaultGeofenceSettings();
    const coords = position.coords;
    const distance = distanceMeters(
      coords.latitude,
      coords.longitude,
      Number(settings.school_latitude),
      Number(settings.school_longitude)
    );
    const accuracy = Number(coords.accuracy || 0);
    const radius = Number(settings.radius_meters || 300);
    const accuracyLimit = Math.max(200, radius * 2);

    state.autoCall.lastDistanceMeters = distance;
    state.autoCall.lastAccuracyMeters = accuracy;

    if (distance <= radius && (!accuracy || accuracy <= accuracyLimit)) {
      submitAutoCallTargets();
      return;
    }

    const label = autoCallTargetLabel(state.autoCall.targets);
    const accuracyText = accuracy ? ` Accuracy ${formatDistance(accuracy)}.` : "";
    const accuracyWaiting = distance <= radius && accuracy > accuracyLimit
      ? " Near school, waiting for a more accurate location."
      : "";
    setAutoCallStatus(
      "watching",
      `Auto call is on for ${label}.`,
      `Please keep this screen open. Students will be called automatically when you are close enough.${accuracyWaiting}${accuracyText}`
    );
  }

  function handleAutoCallError(error) {
    let message = "Unable to watch your location.";
    let note = "Use the I'm Here button or timer instead.";
    if (error.code === 1) {
      message = "Location access was denied.";
      note = "Use the I'm Here button or timer instead.";
    } else if (error.code === 2) {
      note = "Check that location services are enabled, or use the timer.";
    } else if (error.code === 3) {
      note = "Still waiting for GPS. Keep this page open, or use the timer.";
    }

    if (error.code === 3 && isAutoCallActive()) {
      setAutoCallStatus("watching", state.autoCall.message || "Auto call armed.", note);
      return;
    }

    stopAutoCall({
      status: "error",
      targets: state.autoCall.targets,
      message,
      note
    });
  }

  async function startAutoCall() {
    clearError("students-error");

    if (!geofenceIsReady()) {
      showError("students-error", "Auto call is not set up yet. Please use I'm Here or the timer.");
      return;
    }
    if (!navigator.geolocation) {
      showError("students-error", "This browser cannot use location. Please use I'm Here or the timer.");
      return;
    }
    if (!window.isSecureContext) {
      showError("students-error", "Location requires the secure school website. Please use I'm Here or the timer.");
      return;
    }

    const targets = collectAutoCallTargets();
    if (!targets.length) {
      showError("students-error", "Choose at least one child before using auto call.");
      return;
    }

    const label = autoCallTargetLabel(targets);
    state.autoCall = {
      status: "arming",
      watchId: null,
      wakeLock: null,
      targets,
      message: `Auto call is on for ${label}.`,
      note: "Please keep this screen open. Students will be called automatically when you are close enough.",
      lastDistanceMeters: null,
      lastAccuracyMeters: null,
      submitting: false
    };
    renderStickyBar();

    const hasWakeLock = await requestAutoCallWakeLock();
    state.autoCall.note = hasWakeLock
      ? "Please keep this screen open. We are watching for when you get close enough."
      : "Please keep this screen open. Students will be called automatically when you are close enough.";

    try {
      const watchId = navigator.geolocation.watchPosition(
        handleAutoCallPosition,
        handleAutoCallError,
        {
          enableHighAccuracy: true,
          maximumAge: 10000,
          timeout: 20000
        }
      );
      state.autoCall.watchId = watchId;
      state.autoCall.status = "watching";
      renderStickyBar();
    } catch (error) {
      await releaseAutoCallWakeLock();
      stopAutoCall({
        status: "error",
        targets,
        message: "Unable to start auto call.",
        note: error.message || "Use the I'm Here button or timer instead."
      });
    }
  }

  async function repingLastSubmittedStudent(studentId, familyId) {
    const target = state.lastSubmittedStudents.find((student) => student.student_id === studentId)
      || allCheckinStudents().find((student) => String(student.student_id) === String(studentId));
    if (!target || !state.number || state.repingBusyIds.has(studentId)) return;

    state.repingBusyIds.add(studentId);
    setDoneRepingStatus("");
    clearError("students-error");
    renderCheckinPage();
    renderDoneRepingActions();

    try {
      const result = await submitCheckInRequest([{
        family_id: familyId || target.family_id,
        student_ids: [target.student_id]
      }]);
      rememberLastSubmittedStudents({
        families: [],
        skipped_students: [],
        ...result
      });
      const calledNames = formatCalledStudents(result);
      const skippedNames = formatSkippedStudents(result);
      if (calledNames.length) {
        state.checkinNotice = {
          message: `${calledNames.join(", ")} is showing again in the classroom.`,
          note: "The school has been notified."
        };
        setDoneRepingStatus(`${calledNames.join(", ")} is showing again in the classroom.`, "success");
      } else if (skippedNames.length) {
        state.checkinNotice = {
          message: `${skippedNames.join(", ")} is already active for the classroom.`,
          note: "You can call again after the cooldown ends."
        };
        setDoneRepingStatus(`${skippedNames.join(", ")} is already active for the classroom.`, "success");
      }
      await loadFamily(state.number);
    } catch (error) {
      showError("students-error", error.message || "Unable to call again right now. Please try again.");
      setDoneRepingStatus(error.message || "Unable to reping right now. Please try again.", "error");
    } finally {
      state.repingBusyIds.delete(studentId);
      renderCheckinPage();
      renderDoneRepingActions();
    }
  }

  async function cancelCalledStudent(studentId) {
    const target = state.lastSubmittedStudents.find((student) => student.student_id === studentId)
      || allCheckinStudents().find((student) => String(student.student_id) === String(studentId));
    if (!target || !state.number || state.cancelBusyIds.has(studentId)) return;

    const fullName = `${target.first_name || "Student"} ${target.last_name || ""}`.trim();

    state.cancelBusyIds.add(studentId);
    setDoneRepingStatus("");
    clearError("students-error");
    renderCheckinPage();
    renderDoneRepingActions();

    try {
      const result = await cancelParentCheckInRequest([target.student_id || studentId]);
      const cancelledIds = new Set((result?.cancelled_student_ids || []).map(String));

      if (!cancelledIds.has(String(studentId))) {
        throw new Error("This pickup request could not be cancelled.");
      }

      state.lastSubmittedStudents = state.lastSubmittedStudents.filter((student) => student.student_id !== studentId);
      state.checkinNotice = {
        message: `Pickup request cancelled for ${fullName}.`,
        note: "The classroom display has been updated."
      };

      const doneSection = el("done-section");
      if (doneSection && !doneSection.classList.contains("hidden")) {
        el("done-message").textContent = `Pickup request cancelled for ${fullName}.`;
        el("done-note").textContent = "The classroom display has been updated.";
        show("done-note", true);
        setDoneRepingStatus(`Cancelled ${fullName}.`, "success");
      }

      await loadFamily(state.number);
    } catch (error) {
      showError("students-error", error.message || "Unable to cancel this pickup request. Please try again.");
      setDoneRepingStatus(error.message || "Unable to cancel this pickup request. Please try again.", "error");
    } finally {
      state.cancelBusyIds.delete(studentId);
      renderCheckinPage();
      renderDoneRepingActions();
    }
  }

  async function submitSelectedStudents() {
    const targets = collectTargets();
    if (!targets.length) {
      showError("students-error", "Choose at least one child.");
      return;
    }

    clearError("students-error");
    state.loading = true;
    renderStickyBar();

    try {
      let result;
      let note = "The school has been notified.";

      if (state.activePresetIds.size === 1 && manualSelectedCount() === 0) {
        const [presetId] = Array.from(state.activePresetIds);
        result = await submitPresetCheckIn(presetId);
        if (result.is_empty_after_cleanup) {
          await loadFamily(state.number);
          showError("students-error", "This quick pick needs to be updated in Settings before it can be used again.");
          return;
        }

        const removed = (result.removed_students || []).map((student) => `${student.first_name} ${student.last_name}`);
        if (removed.length) {
          note = `Your quick pick was updated after expired approvals were removed for: ${removed.join(", ")}.`;
        }
      } else {
        try {
          result = await submitCheckInRequest(targets);
        } catch (error) {
          if (!isRepingCooldownError(error)) throw error;
          result = await submitTargetsIndividually(targets);
        }
      }

      rememberLastSubmittedStudents(result);
      const doneCopy = buildDoneCopy(result, note);
      state.checkinNotice = doneCopy;
      await loadFamily(state.number);
    } catch (error) {
      showError("students-error", error.message || "Unable to check in right now. Please try again.");
    } finally {
      state.loading = false;
      renderStickyBar();
    }
  }

  async function submitScheduledPickup() {
    const targets = collectTargets();
    if (!targets.length) {
      setScheduleError("Choose at least one child.");
      return;
    }

    setScheduleError("");
    clearError("students-error");
    state.scheduleBusy = true;
    syncScheduleModal();
    renderStickyBar();

    try {
      const sendAt = new Date(Date.now() + state.scheduleMinutes * 60 * 1000).toISOString();
      state.scheduledPickup = await createScheduledPickup(targets, sendAt);
      const namesText = formatScheduledNames(scheduledStudentNames());
      state.checkinNotice = {
        message: `Timer set for ${namesText}.`,
        note: `The request will send at ${formatScheduleTime(state.scheduledPickup.send_at)}.`
      };
      closeScheduleModal();
      await loadFamily(state.number);
    } catch (error) {
      setScheduleError(error.message || "Unable to set the timer. Please try again.");
    } finally {
      state.scheduleBusy = false;
      syncScheduleModal();
      renderCheckinPage();
    }
  }

  async function cancelScheduledPickup(options = {}) {
    const requestId = state.scheduledPickup?.request_id;
    if (!requestId || state.scheduleBusy) return;

    state.scheduleBusy = true;
    setScheduleError("");
    renderStickyBar();
    syncScheduleModal();

    try {
      await cancelScheduledPickupRequest(requestId);
      state.scheduledPickup = null;
      if (!options.silent) {
        state.checkinNotice = {
          message: "Timer cancelled.",
          note: "No scheduled pickup request will be sent."
        };
      }
      closeScheduleModal();
      await loadFamily(state.number);
    } catch (error) {
      if (!options.silent) {
        setScheduleError(error.message || "Unable to cancel the timer. Please try again.");
        showError("students-error", error.message || "Unable to cancel the timer. Please try again.");
      }
    } finally {
      state.scheduleBusy = false;
      syncScheduleModal();
      renderCheckinPage();
    }
  }

  function clearParentSession() {
    stopAutoCall();
    localStorage.removeItem(STORAGE_KEY);
    state.number = null;
    state.context = null;
    state.checkinNotice = null;
    state.scheduledPickup = null;
    state.geofenceSettings = defaultGeofenceSettings();
    state.lastSubmittedStudents = [];
    state.repingBusyIds = new Set();
    state.cancelBusyIds = new Set();
    resetSelections();
    syncNumberUi();
    setBootPending(false);
    setDoneRepingStatus("");
    renderDoneRepingActions();
    showNumberStep(true);
  }

  async function returnToStudentCheckin() {
    if (!state.number) {
      showNumberStep(true);
      return;
    }

    await loadFamily(state.number);
    hideAllSections();
    show("entry-card", false);
    show("students-section", true);
    setStudentsActive(true);
    renderStickyBar();
  }

  function bindEvents() {
    el("find-family").addEventListener("click", () => continueWithNumber(el("carpool-number").value.trim()));
    el("carpool-number").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        continueWithNumber(el("carpool-number").value.trim());
      }
    });

    el("parent-logout-btn").addEventListener("click", clearParentSession);
    el("done-back-btn").addEventListener("click", returnToStudentCheckin);

    el("done-reping-list").addEventListener("click", (event) => {
      const cancelBtn = event.target.closest("[data-cancel-student]");
      if (cancelBtn) {
        cancelCalledStudent(cancelBtn.dataset.cancelStudent);
        return;
      }

      const repingBtn = event.target.closest("[data-reping-student]");
      if (!repingBtn) return;
      repingLastSubmittedStudent(repingBtn.dataset.repingStudent);
    });

    el("saved-carpools-list").addEventListener("click", (event) => {
      const presetBtn = event.target.closest("[data-preset-id]");
      if (!presetBtn) return;
      applyPresetSelection(presetBtn.dataset.presetId);
    });

    ["your-students-list", "authorized-students-list"].forEach((id) => {
      el(id).addEventListener("click", (event) => {
        const cancelBtn = event.target.closest("[data-cancel-student]");
        if (cancelBtn) {
          cancelCalledStudent(cancelBtn.dataset.cancelStudent);
          return;
        }

        const repingBtn = event.target.closest("[data-reping-student]");
        if (repingBtn) {
          repingLastSubmittedStudent(repingBtn.dataset.repingStudent, repingBtn.dataset.repingFamily);
          return;
        }

        const studentBtn = event.target.closest("[data-student-id]");
        if (studentBtn) {
          toggleStudentSelection(studentBtn.dataset.familyId, studentBtn.dataset.studentId);
          return;
        }

        const familyBtn = event.target.closest("[data-select-family]");
        if (familyBtn) {
          selectEntireFamily(familyBtn.dataset.selectFamily);
        }
      });
    });

    el("select-all-children").addEventListener("click", (event) => {
      const familyId = event.currentTarget.dataset.selectFamily;
      if (!familyId) return;
      selectEntireFamily(familyId);
    });

    el("students-submit").addEventListener("click", submitSelectedStudents);
    el("schedule-pickup-open").addEventListener("click", openScheduleModal);
    el("sticky-schedule-cancel").addEventListener("click", () => cancelScheduledPickup());
    el("auto-call-location").addEventListener("click", startAutoCall);
    el("auto-call-overlay-cancel").addEventListener("click", () => stopAutoCall());
    el("schedule-modal-close").addEventListener("click", closeScheduleModal);
    el("schedule-submit").addEventListener("click", submitScheduledPickup);
    el("schedule-minus").addEventListener("click", () => {
      state.scheduleMinutes = Math.max(1, state.scheduleMinutes - 1);
      syncScheduleModal();
    });
    el("schedule-plus").addEventListener("click", () => {
      state.scheduleMinutes = Math.min(60, state.scheduleMinutes + 1);
      syncScheduleModal();
    });
    el("schedule-modal").addEventListener("click", (event) => {
      if (event.target.id === "schedule-modal") closeScheduleModal();
    });
    document.querySelectorAll("[data-schedule-minutes]").forEach((button) => {
      button.addEventListener("click", () => {
        state.scheduleMinutes = Number(button.dataset.scheduleMinutes) || 5;
        syncScheduleModal();
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !el("schedule-modal").classList.contains("hidden")) {
        closeScheduleModal();
      }
    });
    document.addEventListener("visibilitychange", async () => {
      if (!isAutoCallActive()) return;
      if (document.visibilityState === "visible") {
        if (!state.autoCall.wakeLock) await requestAutoCallWakeLock();
        state.autoCall.note = "Please keep this screen open. We are watching for when you get close enough.";
      } else {
        state.autoCall.note = "Auto call may pause while this page is not visible.";
      }
      renderStickyBar();
    });
  }

  function init() {
    if (!window.carpoolClient) {
      setBootPending(false);
      show("config-warning", true);
      return;
    }

    bindEvents();

    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      setBootPending(true);
      restoreSavedSession(cached).finally(() => {
        setBootPending(false);
      });
    } else {
      setBootPending(false);
      syncNumberUi();
      showNumberStep(true);
    }

    state.repingTimer = window.setInterval(() => {
      const doneSection = el("done-section");
      const studentsSection = el("students-section");
      if (doneSection && !doneSection.classList.contains("hidden") && state.lastSubmittedStudents.length) {
        renderDoneRepingActions();
      }
      if (studentsSection && !studentsSection.classList.contains("hidden") && allCheckinStudents().some(isStudentCheckedIn)) {
        renderCheckinPage();
      }
      if (state.scheduledPickup) {
        if (studentsSection && !studentsSection.classList.contains("hidden")) {
          renderCheckinPage();
        } else {
          renderScheduleStatus();
        }
        const sendAt = new Date(state.scheduledPickup.send_at).getTime();
        if (sendAt <= Date.now() && state.number && Date.now() > state.scheduleRefreshAt) {
          state.scheduleRefreshAt = Date.now() + 10000;
          loadFamily(state.number).catch(() => {});
        }
      }
    }, 1000);
  }

  window.addEventListener("beforeunload", () => {
    if (state.repingTimer) clearInterval(state.repingTimer);
    clearAutoCallWatch();
    releaseAutoCallWakeLock();
  });

  init();
})();
