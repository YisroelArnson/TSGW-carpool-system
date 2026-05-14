(function parentSettingsPage() {
  const {
    mustClient,
    show,
    escapeHtml,
    familyDisplayName,
    CARPOOL_WEEKDAYS,
    normalizeWeekdays,
    formatWeekdays
  } = window.carpoolUtils || {};
  if (!mustClient) return;

  const STORAGE_KEY = "tsgw_carpool_number";
  const PERMANENT_END_DATE = "9999-12-31";

  const state = {
    number: null,
    context: null,
    authorizations: [],
    lookupFamily: null,
    familySearchResults: [],
    familySearchLoading: false,
    familySearchRequestSeq: 0,
    familySearchTimer: null,
    manageSelection: new Set(),
    editingAuthorizationId: null,
    presetSelection: new Set(),
    presetWeekdays: new Set(),
    editingPresetId: null
  };

  function el(id) {
    return document.getElementById(id);
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatDateLabel(value) {
    if (!value || value === PERMANENT_END_DATE) return "Permanent";

    const [year, month, day] = String(value).split("-").map(Number);
    if (!year || !month || !day) return value;

    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function pluralize(count, singular, plural) {
    return `${count} ${count === 1 ? singular : (plural || `${singular}s`)}`;
  }

  function setMessage(id, message, klass) {
    const node = el(id);
    if (!node) return;
    node.className = klass || "";
    node.textContent = message || "";
    show(id, Boolean(message));
  }

  function visibleAuthorizations(authorizations) {
    return (authorizations || []).filter((auth) => !auth.is_revoked);
  }

  async function getCheckinContext(number) {
    const client = mustClient();
    const { data, error } = await client.rpc("get_parent_checkin_context", {
      p_carpool_number: Number(number)
    });
    if (error) throw error;
    return data;
  }

  async function getFamilyAuthorizations(number) {
    const client = mustClient();
    const { data, error } = await client.rpc("get_family_authorizations", {
      p_carpool_number: Number(number)
    });
    if (error) throw error;
    return data || [];
  }

  async function searchReceivingFamilies(query) {
    const client = mustClient();
    const { data, error } = await client.rpc("search_receiving_families", {
      p_granting_carpool_number: Number(state.number),
      p_query: query
    });
    if (error) throw error;
    return data || [];
  }

  async function createAuthorization(payload) {
    const client = mustClient();
    const { data, error } = await client.rpc("create_pickup_authorization_for_family", payload);
    if (error) throw error;
    return data;
  }

  async function updateAuthorization(payload) {
    const client = mustClient();
    const { data, error } = await client.rpc("update_pickup_authorization", payload);
    if (error) throw error;
    return data;
  }

  async function revokeAuthorization(authId) {
    const client = mustClient();
    const { data, error } = await client.rpc("revoke_pickup_authorization", {
      p_authorization_id: authId,
      p_granting_carpool_number: Number(state.number)
    });
    if (error) throw error;
    return data;
  }

  async function createPreset(payload) {
    const client = mustClient();
    const { data, error } = await client.rpc("create_carpool_preset", payload);
    if (error) throw error;
    return data;
  }

  async function updatePreset(payload) {
    const client = mustClient();
    const { data, error } = await client.rpc("update_carpool_preset", payload);
    if (error) throw error;
    return data;
  }

  async function deletePreset(presetId) {
    const client = mustClient();
    const { data, error } = await client.rpc("delete_carpool_preset", {
      p_preset_id: presetId,
      p_owner_carpool_number: Number(state.number)
    });
    if (error) throw error;
    return data;
  }

  function syncHeader() {
    const family = state.context?.requesting_family;
    if (!family) return;
    el("settings-family-number").textContent = `Family #${family.carpool_number}`;
    el("settings-family-name").textContent = familyDisplayName(family);
  }

  function setPseudoDisabled(buttonId, isDisabled) {
    const button = el(buttonId);
    if (!button) return;
    button.classList.toggle("is-disabled", Boolean(isDisabled));
    button.setAttribute("aria-disabled", isDisabled ? "true" : "false");
  }

  function selectionRowHtml({ id, name, meta, selected, dataAttr }) {
    return `
      <button
        type="button"
        class="student-row${selected ? " selected" : ""}"
        ${dataAttr}="${escapeHtml(id)}"
        aria-pressed="${selected ? "true" : "false"}"
      >
        <span class="student-row-main">
          <span class="student-row-toggle">${selected ? "✓" : "+"}</span>
          <span class="student-row-copy">
            <span class="student-row-name">${escapeHtml(name)}</span>
            ${meta ? `<span class="student-row-meta">${escapeHtml(meta)}</span>` : ""}
          </span>
        </span>
      </button>
    `;
  }

  function weekdayPickerHtml(selectedDays) {
    return (CARPOOL_WEEKDAYS || []).map((day) => {
      const selected = selectedDays.has(day.key);
      return `
        <button
          type="button"
          class="weekday-option${selected ? " selected" : ""}"
          data-preset-weekday="${escapeHtml(day.key)}"
          aria-pressed="${selected ? "true" : "false"}"
        >
          <span class="weekday-option-main">${escapeHtml(day.label)}</span>
          <span class="weekday-option-short">${escapeHtml(day.short)}</span>
        </button>
      `;
    }).join("");
  }

  function syncPresetSubmitState() {
    setPseudoDisabled(
      "preset-submit",
      !state.presetSelection.size || !state.presetWeekdays.size || !el("preset-name").value.trim()
    );
  }

  function openPresetEditor() {
    show("preset-modal", true);
  }

  function closePresetEditor() {
    show("preset-modal", false);
  }

  function openAuthorizationEditor() {
    show("authorization-modal", true);
  }

  function closeAuthorizationEditor() {
    show("authorization-modal", false);
  }

  function renderAuthorizedPickups() {
    const node = el("settings-authorized-pickups");
    const authorized = state.context?.authorized_pickups || [];
    if (!authorized.length) {
      node.innerHTML = '<p class="item-meta empty-state">You don\'t have any pick up permissions</p>';
      return;
    }

    node.innerHTML = authorized.map((family) => {
      const students = (family.students || []).map((student) => `${student.first_name} ${student.last_name}`).join(", ");
      const studentCount = family.students?.length || 0;
      return `
        <article class="item-card">
          <div class="item-row">
            <h3 class="item-title">${escapeHtml(familyDisplayName(family))}</h3>
            <span class="item-count">${escapeHtml(pluralize(studentCount, "student"))}</span>
          </div>
          <p class="item-meta">${escapeHtml(students || "No students")}</p>
        </article>
      `;
    }).join("");
  }

  function authStatus(auth) {
    return auth.status_label || "Active";
  }

  function renderAuthorizationList() {
    const node = el("settings-authorization-list");
    if (!state.authorizations.length) {
      node.innerHTML = '<p class="item-meta empty-state">No pickup permissions yet.</p>';
      return;
    }

    node.innerHTML = state.authorizations.map((auth) => {
      const receiving = auth.receiving_family || {};
      const students = (auth.students || []).map((student) => `${student.first_name} ${student.last_name}`).join(", ");
      const startLabel = formatDateLabel(auth.starts_on);
      const endLabel = formatDateLabel(auth.ends_on);
      const datesLabel =
        endLabel === "Permanent"
          ? `Starts ${startLabel}. No end date.`
          : `${startLabel} to ${endLabel}`;
      return `
        <article class="item-card">
          <div class="item-row">
            <h3 class="item-title">${escapeHtml(familyDisplayName(receiving))}</h3>
            <span class="item-count">${escapeHtml(authStatus(auth))}</span>
          </div>
          <p class="item-meta">${escapeHtml(`Can pick up: ${students || "No students selected"}`)}</p>
          <p class="item-meta">${escapeHtml(`Dates: ${datesLabel}`)}</p>
          <div class="item-actions">
            <button type="button" class="action-link primary" data-edit-auth="${escapeHtml(auth.authorization_id)}">Edit</button>
            <button type="button" class="action-link" data-remove-auth="${escapeHtml(auth.authorization_id)}">Remove</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function clearAuthorizationSearchState() {
    if (state.familySearchTimer) {
      window.clearTimeout(state.familySearchTimer);
      state.familySearchTimer = null;
    }
    state.familySearchRequestSeq += 1;
    state.familySearchResults = [];
    state.familySearchLoading = false;
  }

  function syncAuthorizationFamilyInput() {
    const input = el("authorize-family-search");
    if (!input) return;
    input.disabled = Boolean(state.editingAuthorizationId);
  }

  function renderAuthorizationFamilyResults() {
    const node = el("authorization-family-results");
    const input = el("authorize-family-search");
    if (!node || !input) return;

    syncAuthorizationFamilyInput();

    const query = input.value.trim();
    if (state.editingAuthorizationId) {
      node.innerHTML = '<p class="item-meta empty-state">To switch families, remove this permission and create a new one.</p>';
      return;
    }

    if (!query) {
      node.innerHTML = '<p class="item-meta empty-state">Search by family name to find a family.</p>';
      return;
    }

    if (query.length < 2) {
      node.innerHTML = '<p class="item-meta empty-state">Type at least 2 letters to search.</p>';
      return;
    }

    if (state.familySearchLoading) {
      node.innerHTML = '<p class="item-meta empty-state">Searching families...</p>';
      return;
    }

    if (!state.familySearchResults.length) {
      node.innerHTML = '<p class="item-meta empty-state">No families matched that search.</p>';
      return;
    }

    node.innerHTML = state.familySearchResults.map((family) => {
      const selected = state.lookupFamily?.family_id === family.family_id;
      return selectionRowHtml({
        id: family.family_id,
        name: familyDisplayName(family),
        meta: selected ? "Selected family" : "Select this family",
        selected,
        dataAttr: "data-select-family"
      });
    }).join("");
  }

  function queueAuthorizationFamilySearch() {
    const input = el("authorize-family-search");
    if (!input) return;

    const query = input.value.trim();
    clearAuthorizationSearchState();

    if (state.lookupFamily && query !== familyDisplayName(state.lookupFamily)) {
      state.lookupFamily = null;
      renderAuthorizationLookup();
    }

    if (state.editingAuthorizationId || !query || query.length < 2) {
      renderAuthorizationFamilyResults();
      return;
    }

    state.familySearchLoading = true;
    const requestSeq = state.familySearchRequestSeq + 1;
    state.familySearchRequestSeq = requestSeq;
    renderAuthorizationFamilyResults();

    state.familySearchTimer = window.setTimeout(async () => {
      state.familySearchTimer = null;

      try {
        const results = await searchReceivingFamilies(query);
        if (requestSeq !== state.familySearchRequestSeq) return;
        state.familySearchResults = results;
      } catch (error) {
        if (requestSeq !== state.familySearchRequestSeq) return;
        state.familySearchResults = [];
        setMessage("authorization-message", error.message || "Unable to search families.", "error");
      } finally {
        if (requestSeq !== state.familySearchRequestSeq) return;
        state.familySearchLoading = false;
        renderAuthorizationFamilyResults();
      }
    }, 180);
  }

  function resetAuthorizationForm() {
    state.lookupFamily = null;
    state.manageSelection = new Set();
    state.editingAuthorizationId = null;
    clearAuthorizationSearchState();
    el("authorization-editor-title").textContent = "Create Pickup Permission";
    el("open-authorization-editor").textContent = "Add Permission";
    el("authorize-family-search").value = "";
    el("authorization-start-date").value = todayIso();
    el("authorization-end-date").value = "";
    el("authorization-permanent").checked = false;
    el("authorization-end-date").disabled = false;
    el("authorization-submit").textContent = "Save Permission";
    setMessage("authorization-message", "");
    renderAuthorizationFamilyResults();
    renderAuthorizationLookup();
    setPseudoDisabled("authorization-submit", true);
    closeAuthorizationEditor();
  }

  function syncPermanentUi() {
    const isPermanent = el("authorization-permanent").checked;
    const endDate = el("authorization-end-date");
    endDate.disabled = isPermanent;
    endDate.closest(".form-row")?.classList.toggle("is-disabled", isPermanent);
    if (isPermanent) endDate.value = "";
    if (!el("authorization-start-date").value) el("authorization-start-date").value = todayIso();
  }

  function renderAuthorizationLookup() {
    const details = el("authorization-lookup-result");
    if (!state.lookupFamily) {
      details.innerHTML = '<p class="item-meta empty-state">Choose a family to continue.</p>';
      setPseudoDisabled("authorization-submit", true);
      return;
    }

    const ownStudents = (state.context?.own_students || []).map((student) => {
      const studentId = String(student.student_id);
      const selected = state.manageSelection.has(studentId);
      return selectionRowHtml({
        id: studentId,
        name: `${student.first_name} ${student.last_name}`,
        meta: student.class_name || "",
        selected,
        dataAttr: "data-manage-student"
      });
    }).join("");

    details.innerHTML = `
      <div class="picker-group">
        <div class="picker-group-head">
          <p class="entity-kicker">Your Children</p>
          <h4>Choose who this family can pick up</h4>
        </div>
        <div class="student-list">${ownStudents}</div>
      </div>
    `;

    setPseudoDisabled(
      "authorization-submit",
      !state.manageSelection.size ||
        !el("authorization-start-date").value ||
        (!el("authorization-permanent").checked && !el("authorization-end-date").value)
    );
  }

  function loadAuthIntoForm(auth) {
    state.editingAuthorizationId = auth.authorization_id;
    state.lookupFamily = auth.receiving_family;
    state.manageSelection = new Set((auth.students || []).map((student) => String(student.student_id)));
    clearAuthorizationSearchState();
    el("authorization-editor-title").textContent = "Edit Pickup Permission";
    el("open-authorization-editor").textContent = "Add Permission";
    el("authorize-family-search").value = familyDisplayName(auth.receiving_family);
    el("authorization-start-date").value = auth.starts_on || todayIso();
    const isPermanent = auth.ends_on === PERMANENT_END_DATE;
    el("authorization-permanent").checked = isPermanent;
    el("authorization-end-date").value = isPermanent ? "" : (auth.ends_on || "");
    syncPermanentUi();
    el("authorization-submit").textContent = "Save Changes";
    renderAuthorizationFamilyResults();
    renderAuthorizationLookup();
    openAuthorizationEditor();
  }

  async function saveAuthorization() {
    const startDate = el("authorization-start-date").value || todayIso();
    const endDate = el("authorization-permanent").checked ? PERMANENT_END_DATE : el("authorization-end-date").value;

    if (!state.lookupFamily) {
      setMessage("authorization-message", "Choose a receiving family first.", "error");
      return;
    }
    if (!startDate || !endDate) {
      setMessage("authorization-message", "Choose a start date and an end date, or keep it active until you remove it.", "error");
      return;
    }
    if (!state.manageSelection.size) {
      setMessage("authorization-message", "Choose at least one child.", "error");
      return;
    }

    const payload = {
      p_granting_carpool_number: Number(state.number),
      p_student_ids: Array.from(state.manageSelection),
      p_starts_on: startDate,
      p_ends_on: endDate
    };

    try {
      if (state.editingAuthorizationId) {
        await updateAuthorization({
          ...payload,
          p_authorization_id: state.editingAuthorizationId
        });
      } else {
        await createAuthorization({
          ...payload,
          p_receiving_family_id: state.lookupFamily.family_id
        });
      }

      await refreshState();
      setMessage("authorization-message", "Permission saved.", "success");
      window.setTimeout(resetAuthorizationForm, 300);
    } catch (error) {
      setMessage("authorization-message", error.message || "Unable to save permission.", "error");
    }
  }

  function presetEligibleGroups() {
    const own = state.context?.requesting_family;
    const groups = [];

    if (own) {
      groups.push({
        family_id: own.family_id,
        heading: "Your Children",
        subheading: familyDisplayName(own),
        students: state.context?.own_students || []
      });
    }

    (state.context?.authorized_pickups || []).forEach((family) => {
      groups.push({
        family_id: family.family_id,
        heading: "Authorized Pickups",
        subheading: familyDisplayName(family),
        students: family.students || []
      });
    });

    return groups;
  }

  function renderPresetPicker() {
    const picker = el("preset-student-picker");
    const groups = presetEligibleGroups();
    if (!groups.length) {
      picker.innerHTML = '<p class="item-meta empty-state">No students are available for saved carpools.</p>';
      setPseudoDisabled("preset-submit", true);
      return;
    }

    picker.innerHTML = groups.map((group) => {
      const studentsHtml = (group.students || []).map((student) => {
        const studentId = String(student.student_id);
        const selected = state.presetSelection.has(studentId);
        return selectionRowHtml({
          id: studentId,
          name: `${student.first_name} ${student.last_name}`,
          meta: student.class_name || "",
          selected,
          dataAttr: "data-preset-student"
        });
      }).join("");

      return `
        <div class="picker-group">
          <div class="picker-group-head">
            <p class="entity-kicker">${escapeHtml(group.heading)}</p>
            <h4>${escapeHtml(group.subheading)}</h4>
          </div>
          <div class="student-list">${studentsHtml}</div>
        </div>
      `;
    }).join("");

    syncPresetSubmitState();
  }

  function renderPresetList() {
    const presets = state.context?.saved_carpools || [];
    const node = el("settings-presets-list");
    if (!presets.length) {
      node.innerHTML = '<p class="item-meta empty-state">No saved carpools yet.</p>';
      return;
    }

    node.innerHTML = presets.map((preset) => {
      const students = (preset.students || []).map((student) => `${student.first_name} ${student.last_name}`).join(", ");
      return `
        <article class="item-card">
          <div class="item-row">
            <h3 class="item-title">${escapeHtml(preset.name || "Saved Carpool")}</h3>
            <span class="item-count">${escapeHtml(pluralize(Number(preset.student_count || 0), "student"))}</span>
          </div>
          <p class="item-meta">${escapeHtml(`Days: ${formatWeekdays(preset.weekdays || [], true)}`)}</p>
          <p class="item-meta">${escapeHtml(`Includes: ${students || "No students"}`)}</p>
          <div class="item-actions">
            <button type="button" class="action-link primary" data-edit-preset="${escapeHtml(preset.preset_id)}">Edit</button>
            <button type="button" class="action-link" data-delete-preset="${escapeHtml(preset.preset_id)}">Delete</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function resetPresetForm() {
    state.presetSelection = new Set();
    state.presetWeekdays = new Set();
    state.editingPresetId = null;
    el("preset-editor-title").textContent = "Create Carpool";
    el("open-preset-editor").textContent = "Add New Carpool";
    el("preset-name").value = "";
    el("preset-submit").textContent = "Save Carpool";
    setMessage("preset-message", "");
    if (el("preset-weekday-picker")) {
      el("preset-weekday-picker").innerHTML = weekdayPickerHtml(state.presetWeekdays);
    }
    renderPresetPicker();
    syncPresetSubmitState();
    closePresetEditor();
  }

  function loadPresetIntoForm(preset) {
    state.editingPresetId = preset.preset_id;
    state.presetSelection = new Set((preset.students || []).map((student) => String(student.student_id)));
    state.presetWeekdays = new Set(normalizeWeekdays(preset.weekdays || []));
    el("preset-editor-title").textContent = "Edit Saved Carpool";
    el("open-preset-editor").textContent = "Add New Carpool";
    el("preset-name").value = preset.name || "";
    el("preset-submit").textContent = "Save Carpool";
    el("preset-weekday-picker").innerHTML = weekdayPickerHtml(state.presetWeekdays);
    renderPresetPicker();
    openPresetEditor();
  }

  async function savePreset() {
    const name = el("preset-name").value.trim();
    if (!name) {
      setMessage("preset-message", "Enter a carpool name.", "error");
      return;
    }
    if (!state.presetSelection.size) {
      setMessage("preset-message", "Choose at least one student.", "error");
      return;
    }
    if (!state.presetWeekdays.size) {
      setMessage("preset-message", "Choose at least one day.", "error");
      return;
    }

    const payload = {
      p_owner_carpool_number: Number(state.number),
      p_name: name,
      p_student_ids: Array.from(state.presetSelection),
      p_weekdays: normalizeWeekdays(Array.from(state.presetWeekdays))
    };

    try {
      if (state.editingPresetId) {
        await updatePreset({
          ...payload,
          p_preset_id: state.editingPresetId
        });
      } else {
        await createPreset(payload);
      }

      await refreshState();
      setMessage("preset-message", "Saved carpool updated.", "success");
      window.setTimeout(resetPresetForm, 300);
    } catch (error) {
      setMessage("preset-message", error.message || "Unable to save saved carpool.", "error");
    }
  }

  async function refreshState() {
    state.context = await getCheckinContext(state.number);
    state.authorizations = visibleAuthorizations(await getFamilyAuthorizations(state.number));
    syncHeader();
    renderAuthorizedPickups();
    renderAuthorizationList();
    renderPresetList();
    renderAuthorizationLookup();
    renderAuthorizationFamilyResults();
    renderPresetPicker();
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = "../";
  }

  async function init() {
    if (!window.carpoolClient) {
      show("config-warning", true);
      return;
    }

    const cached = localStorage.getItem(STORAGE_KEY);
    if (!cached) {
      window.location.href = "../";
      return;
    }

    state.number = Number(cached);

    try {
      await refreshState();
      resetAuthorizationForm();
      resetPresetForm();
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
      window.location.href = "../";
    }
  }

  function bindEvents() {
    el("settings-logout-btn").addEventListener("click", clearSession);
    el("preset-modal-close").addEventListener("click", resetPresetForm);
    el("authorization-modal-close").addEventListener("click", resetAuthorizationForm);
    el("preset-modal").addEventListener("click", (event) => {
      if (event.target === el("preset-modal")) resetPresetForm();
    });
    el("authorization-modal").addEventListener("click", (event) => {
      if (event.target === el("authorization-modal")) resetAuthorizationForm();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!el("preset-modal").classList.contains("hidden")) resetPresetForm();
      if (!el("authorization-modal").classList.contains("hidden")) resetAuthorizationForm();
    });

    el("open-preset-editor").addEventListener("click", () => {
      setMessage("preset-message", "");
      state.presetSelection = new Set();
      state.editingPresetId = null;
      el("preset-editor-title").textContent = "Create Carpool";
      el("preset-name").value = "";
      el("preset-submit").textContent = "Save Carpool";
      state.presetWeekdays = new Set();
      el("preset-weekday-picker").innerHTML = weekdayPickerHtml(state.presetWeekdays);
      openPresetEditor();
      renderPresetPicker();
      syncPresetSubmitState();
    });

    el("open-authorization-editor").addEventListener("click", () => {
      setMessage("authorization-message", "");
      state.lookupFamily = null;
      state.manageSelection = new Set();
      state.editingAuthorizationId = null;
      clearAuthorizationSearchState();
      el("authorization-editor-title").textContent = "Create Pickup Permission";
      el("authorize-family-search").value = "";
      el("authorization-start-date").value = todayIso();
      el("authorization-end-date").value = "";
      el("authorization-permanent").checked = false;
      syncPermanentUi();
      el("authorization-submit").textContent = "Save Permission";
      openAuthorizationEditor();
      renderAuthorizationFamilyResults();
      renderAuthorizationLookup();
      setPseudoDisabled("authorization-submit", true);
    });

    el("authorize-family-search").addEventListener("input", () => {
      setMessage("authorization-message", "");
      queueAuthorizationFamilySearch();
    });

    el("authorization-family-results").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-select-family]");
      if (!btn) return;
      const family = state.familySearchResults.find((item) => item.family_id === btn.dataset.selectFamily);
      if (!family) return;
      state.lookupFamily = family;
      el("authorize-family-search").value = familyDisplayName(family);
      renderAuthorizationFamilyResults();
      renderAuthorizationLookup();
    });

    el("authorize-family-search").addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const [firstMatch] = state.familySearchResults;
      if (!firstMatch) return;
      event.preventDefault();
      state.lookupFamily = firstMatch;
      el("authorize-family-search").value = familyDisplayName(firstMatch);
      renderAuthorizationFamilyResults();
      renderAuthorizationLookup();
    });

    el("authorization-lookup-result").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-manage-student]");
      if (!btn) return;
      const studentId = btn.dataset.manageStudent;
      if (state.manageSelection.has(studentId)) state.manageSelection.delete(studentId);
      else state.manageSelection.add(studentId);
      renderAuthorizationLookup();
    });

    ["authorization-start-date", "authorization-end-date"].forEach((id) => {
      el(id).addEventListener("input", renderAuthorizationLookup);
    });

    el("authorization-permanent").addEventListener("change", () => {
      syncPermanentUi();
      renderAuthorizationLookup();
    });

    el("authorization-submit").addEventListener("click", saveAuthorization);

    el("settings-authorization-list").addEventListener("click", async (event) => {
      const editBtn = event.target.closest("[data-edit-auth]");
      if (editBtn) {
        const auth = state.authorizations.find((item) => item.authorization_id === editBtn.dataset.editAuth);
        if (auth) loadAuthIntoForm(auth);
        return;
      }

      const removeBtn = event.target.closest("[data-remove-auth]");
      if (!removeBtn) return;
      const auth = state.authorizations.find((item) => item.authorization_id === removeBtn.dataset.removeAuth);
      if (!auth) return;
      const receiving = auth.receiving_family || {};
      if (!window.confirm(`Remove pickup permission for ${familyDisplayName(receiving) || "this family"}?`)) return;

      try {
        await revokeAuthorization(auth.authorization_id);
        await refreshState();
        if (state.editingAuthorizationId === auth.authorization_id) resetAuthorizationForm();
      } catch (error) {
        setMessage("authorization-message", error.message || "Unable to remove permission.", "error");
      }
    });

    el("preset-name").addEventListener("input", renderPresetPicker);
    el("preset-weekday-picker").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-preset-weekday]");
      if (!btn) return;
      const day = btn.dataset.presetWeekday;
      if (state.presetWeekdays.has(day)) state.presetWeekdays.delete(day);
      else state.presetWeekdays.add(day);
      el("preset-weekday-picker").innerHTML = weekdayPickerHtml(state.presetWeekdays);
      syncPresetSubmitState();
    });
    el("preset-student-picker").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-preset-student]");
      if (!btn) return;
      const studentId = btn.dataset.presetStudent;
      if (state.presetSelection.has(studentId)) state.presetSelection.delete(studentId);
      else state.presetSelection.add(studentId);
      renderPresetPicker();
    });

    el("preset-submit").addEventListener("click", savePreset);

    el("settings-presets-list").addEventListener("click", async (event) => {
      const editBtn = event.target.closest("[data-edit-preset]");
      if (editBtn) {
        const preset = (state.context?.saved_carpools || []).find((item) => item.preset_id === editBtn.dataset.editPreset);
        if (preset) loadPresetIntoForm(preset);
        return;
      }

      const deleteBtn = event.target.closest("[data-delete-preset]");
      if (!deleteBtn) return;
      const preset = (state.context?.saved_carpools || []).find((item) => item.preset_id === deleteBtn.dataset.deletePreset);
      if (!preset) return;
      if (!window.confirm(`Delete saved carpool "${preset.name}"?`)) return;

      try {
        await deletePreset(preset.preset_id);
        await refreshState();
        if (state.editingPresetId === preset.preset_id) resetPresetForm();
      } catch (error) {
        setMessage("preset-message", error.message || "Unable to delete saved carpool.", "error");
      }
    });
  }

  bindEvents();
  init();
})();
