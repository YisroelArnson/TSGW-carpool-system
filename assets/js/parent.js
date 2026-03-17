(function parentPage() {
  const { mustClient, show, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const STORAGE_KEY = "tsgw_carpool_number";
  const state = {
    number: null,
    context: null,
    selectedByFamily: new Map(),
    manualSelectedByFamily: new Map(),
    activePresetIds: new Set(),
    loading: false
  };

  function el(id) {
    return document.getElementById(id);
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

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
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
      p_called_by: "parent"
    });
    if (error) throw error;
    return data;
  }

  async function submitPresetCheckIn(presetId) {
    const client = mustClient();
    const { data, error } = await client.rpc("submit_carpool_preset_check_in", {
      p_preset_id: presetId,
      p_owner_carpool_number: Number(state.number),
      p_called_by: "parent"
    });
    if (error) throw error;
    return data;
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
      parent_names: ownFamily.parent_names,
      carpool_number: ownFamily.carpool_number,
      students: state.context.own_students || [],
      label: "Your Family",
      note: ""
    }];

    (state.context.authorized_pickups || []).forEach((family) => {
      cards.push({
        family_id: family.family_id,
        parent_names: family.parent_names,
        carpool_number: family.carpool_number,
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

  function rebuildSelections() {
    const merged = new Map();

    state.manualSelectedByFamily.forEach((ids, familyId) => {
      merged.set(familyId, new Set(ids));
    });

    (state.context?.saved_carpools || []).forEach((preset) => {
      if (!state.activePresetIds.has(preset.preset_id)) return;
      (preset.students || []).forEach((student) => {
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
    const next = new Set((card?.students || []).map((student) => String(student.student_id)));
    state.manualSelectedByFamily.set(familyId, next);
    rebuildSelections();
    renderCheckinPage();
  }

  function renderPresetCards() {
    const presets = state.context?.saved_carpools || [];
    const list = el("saved-carpools-list");
    if (!list) return;

    if (!presets.length) {
      list.innerHTML = '<p class="muted empty-state">No saved carpools yet. Use the gear icon to create one.</p>';
      return;
    }

    list.innerHTML = presets.map((preset) => {
      const isActive = state.activePresetIds.has(preset.preset_id);
      const preview = (preset.students || [])
        .map((student) => `${student.first_name} ${student.last_name}`)
        .join(", ");

      return `
        <button
          type="button"
          class="preset-card${isActive ? " active" : ""}"
          data-preset-id="${escapeHtml(preset.preset_id)}"
          aria-pressed="${isActive ? "true" : "false"}"
        >
          <span class="preset-card-top">
            <span class="preset-card-name">${escapeHtml(preset.name || "Saved Carpool")}</span>
            <span class="preset-card-count">${escapeHtml(String(preset.student_count || 0))} students</span>
          </span>
          <span class="preset-card-preview">${escapeHtml(preview || "No students")}</span>
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

    show("authorized-students-section", authorizedCards.length > 0);
  }

  function familyCardHtml(card) {
    const selected = state.selectedByFamily.get(card.family_id) || new Set();
    const studentsHtml = (card.students || []).map((student) => {
      const studentId = String(student.student_id);
      const isSelected = selected.has(studentId);
      return `
        <button
          type="button"
          class="btn btn-primary student-pick${isSelected ? " selected" : ""}"
          data-family-id="${escapeHtml(card.family_id)}"
          data-student-id="${escapeHtml(studentId)}"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          <span class="student-pick-content">
            <span class="student-pick-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
            <small class="student-pick-grade">${escapeHtml(student.class_name || "")}</small>
          </span>
        </button>
      `;
    }).join("");

    return `
      <article class="family-card">
        <div class="family-card-head">
          <div class="family-card-hero">
            ${card.label === "Your Family" ? "" : `<h3>${escapeHtml(card.parent_names)} <span>#${escapeHtml(String(card.carpool_number))}</span></h3>`}
          </div>
        </div>
        <div class="family-students">${studentsHtml}</div>
      </article>
    `;
  }

  function renderStickyBar() {
    const count = selectedCount();
    const submit = el("students-submit");
    const clearBtn = el("sticky-clear");
    const isStudentsStepActive = document.documentElement.classList.contains("parent-checkin-active");
    if (submit) {
      submit.disabled = !count || state.loading;
      submit.textContent = `Check In ${count} Student${count === 1 ? "" : "s"}`;
    }
    if (clearBtn) clearBtn.disabled = !count || state.loading;
    show("sticky-checkin-bar", isStudentsStepActive && state.number && Boolean(state.context));
  }

  function renderCheckinPage() {
    renderPresetCards();
    renderFamilyGroups();
    renderStickyBar();
  }

  async function loadFamily(number) {
    state.context = await getCheckinContext(number);
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

    if (!number) {
      showError("number-error", "Please enter your carpool number.");
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
      showError("number-error", "Please enter your carpool number to continue.");
    }
  }

  function setDoneState(message, note) {
    el("done-message").textContent = message;
    el("done-note").textContent = note || "Your child's teacher has been notified.";
    hideAllSections();
    show("entry-card", false);
    show("done-card", true);
    show("done-section", true);
  }

  function formatCalledStudents(result) {
    return (result.families || []).flatMap((family) =>
      (family.students || []).map((student) => `${student.first_name} ${student.last_name}`)
    );
  }

  async function submitSelectedStudents() {
    const targets = collectTargets();
    if (!targets.length) {
      showError("students-error", "Choose at least one student.");
      return;
    }

    clearError("students-error");
    state.loading = true;
    renderStickyBar();

    try {
      let result;
      let note = "Your child's teacher has been notified.";

      if (state.activePresetIds.size === 1 && manualSelectedCount() === 0) {
        const [presetId] = Array.from(state.activePresetIds);
        result = await submitPresetCheckIn(presetId);
        if (result.is_empty_after_cleanup) {
          await loadFamily(state.number);
          showError("students-error", "This saved carpool no longer has any authorized students. Update it in Settings.");
          return;
        }

        const removed = (result.removed_students || []).map((student) => `${student.first_name} ${student.last_name}`);
        if (removed.length) {
          note = `Updated the saved carpool by removing: ${removed.join(", ")}.`;
        }
      } else {
        result = await submitCheckInRequest(targets);
      }

      const calledFamilies = formatCalledStudents(result);
      setDoneState(`Checked in: ${calledFamilies.join(", ")}.`, note);
      await loadFamily(state.number);
    } catch (error) {
      showError("students-error", error.message || "Unable to check in right now. Please try again.");
    } finally {
      state.loading = false;
      renderStickyBar();
    }
  }

  function clearParentSession() {
    localStorage.removeItem(STORAGE_KEY);
    state.number = null;
    state.context = null;
    resetSelections();
    syncNumberUi();
    setBootPending(false);
    showNumberStep(true);
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
    el("done-btn").addEventListener("click", async () => {
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
    });

    el("saved-carpools-list").addEventListener("click", (event) => {
      const presetBtn = event.target.closest("[data-preset-id]");
      if (!presetBtn) return;
      applyPresetSelection(presetBtn.dataset.presetId);
    });

    ["your-students-list", "authorized-students-list"].forEach((id) => {
      el(id).addEventListener("click", (event) => {
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

    el("sticky-clear").addEventListener("click", () => {
      resetSelections();
      renderCheckinPage();
      clearError("students-error");
    });
    el("students-submit").addEventListener("click", submitSelectedStudents);
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
  }

  init();
})();
