(function parentPage() {
  const { mustClient, show, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const STORAGE_KEY = "tsgw_carpool_number";
  const state = {
    number: null,
    context: null,
    selectedByFamily: new Map(),
    authorizations: [],
    lookupFamily: null,
    manageSelection: new Set(),
    editingAuthorizationId: null
  };

  const PERMANENT_END_DATE = "9999-12-31";

  function el(id) {
    return document.getElementById(id);
  }

  function hideAllSections() {
    ["cached-section", "number-section", "students-section", "done-section"].forEach((id) => show(id, false));
    show("entry-card", true);
    show("students-section", false);
    show("done-card", false);
  }

  function syncNumberUi() {
    const numberText = state.number ? String(state.number) : "";
    if (el("cached-label")) el("cached-label").textContent = numberText ? `Welcome back! Use carpool #${numberText}?` : "";
    if (el("cached-number-display")) el("cached-number-display").textContent = numberText ? `#${numberText}` : "—";
    if (el("carpool-number")) el("carpool-number").value = numberText;
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function showError(id, message) {
    const node = el(id);
    if (!node) return;
    node.textContent = message;
    show(id, true);
  }

  function setMessage(id, message, klass) {
    const node = el(id);
    if (!node) return;
    node.className = klass || "";
    node.textContent = message || "";
    show(id, Boolean(message));
  }

  function showNumberStep(clearError) {
    hideAllSections();
    show("number-section", true);
    if (clearError) {
      show("number-error", false);
      el("number-error").textContent = "";
    }
    syncNumberUi();
    el("carpool-number").focus();
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

  async function createAuthorization(payload) {
    const client = mustClient();
    const { data, error } = await client.rpc("create_pickup_authorization", payload);
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

  function resetSelections() {
    state.selectedByFamily = new Map();
    const requesting = state.context && state.context.requesting_family ? state.context.requesting_family.family_id : null;
    if (requesting) state.selectedByFamily.set(requesting, new Set());
    (state.context?.authorized_pickups || []).forEach((family) => {
      state.selectedByFamily.set(family.family_id, new Set());
    });
  }

  function familyCards() {
    if (!state.context) return [];
    const cards = [];
    const ownFamily = state.context.requesting_family;
    cards.push({
      family_id: ownFamily.family_id,
      parent_names: ownFamily.parent_names,
      carpool_number: ownFamily.carpool_number,
      students: state.context.own_students || [],
      label: "Your Family",
      note: "Students from your own carpool"
    });

    (state.context.authorized_pickups || []).forEach((family) => {
      cards.push({
        family_id: family.family_id,
        parent_names: family.parent_names,
        carpool_number: family.carpool_number,
        students: family.students || [],
        label: "Authorized Pickup",
        note: `Authorized from ${family.starts_on} to ${family.ends_on}`
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

  function cardHtml(card) {
    const selected = state.selectedByFamily.get(card.family_id) || new Set();
    const studentsHtml = card.students
      .map((student) => {
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
      })
      .join("");

    return `
      <article class="family-card">
        <div class="family-card-head">
          <div class="family-card-hero">
            <p class="family-card-label">${escapeHtml(card.label)}</p>
            <h3>${escapeHtml(card.parent_names)}</h3>
            <p class="family-card-number">#${escapeHtml(String(card.carpool_number))}</p>
            <p class="family-card-meta">${escapeHtml(card.note)}</p>
          </div>
        </div>
        <button type="button" class="btn btn-accent family-card-all" data-select-family="${escapeHtml(card.family_id)}">Select All Students</button>
        <div class="family-students">${studentsHtml}</div>
      </article>
    `;
  }

  function renderCheckinArea() {
    const cards = familyCards();
    el("checkin-groups").innerHTML = cards.map(cardHtml).join("");
    const count = selectedCount();
    el("checkin-selection-summary").textContent =
      count === 0 ? "Choose one or more students to call." : `${count} student${count === 1 ? "" : "s"} selected`;
    el("students-submit").disabled = count === 0;
    show("authorized-pickups-heading", cards.length > 1);
  }

  function authStatus(auth) {
    return auth.status_label || "Active";
  }

  function authCardHtml(auth) {
    const receiving = auth.receiving_family || {};
    const students = (auth.students || []).map((student) => `${student.first_name} ${student.last_name}`).join(", ");
    const endLabel = auth.ends_on === PERMANENT_END_DATE ? "Permanent" : auth.ends_on;
    return `
      <article class="authorization-card">
        <div class="authorization-card-head">
          <div>
            <p class="authorization-status ${escapeHtml(authStatus(auth).toLowerCase())}">${escapeHtml(authStatus(auth))}</p>
            <h3>${escapeHtml(receiving.parent_names || "Family")}</h3>
            <p class="family-card-meta">Carpool #${escapeHtml(String(receiving.carpool_number || ""))}</p>
          </div>
        </div>
        <p class="authorization-dates">${escapeHtml(auth.starts_on)} to ${escapeHtml(endLabel || "")}</p>
        <p class="authorization-students">${escapeHtml(students || "No students")}</p>
        <div class="authorization-actions">
          ${auth.is_revoked ? "" : `<button type="button" class="btn btn-secondary" data-edit-auth="${escapeHtml(auth.authorization_id)}">Edit</button>`}
          ${auth.is_revoked ? "" : `<button type="button" class="btn btn-secondary" data-revoke-auth="${escapeHtml(auth.authorization_id)}">Revoke</button>`}
        </div>
      </article>
    `;
  }

  function renderAuthorizationList() {
    el("authorization-list").innerHTML =
      state.authorizations.length
        ? state.authorizations.map(authCardHtml).join("")
        : '<p class="muted">No pickup permissions yet.</p>';
  }

  function resetManageForm() {
    state.lookupFamily = null;
    state.manageSelection = new Set();
    state.editingAuthorizationId = null;
    el("authorize-carpool-number").value = "";
    el("authorization-start-date").value = todayIso();
    el("authorization-end-date").value = "";
    el("authorization-permanent").checked = false;
    el("authorization-end-date").disabled = false;
    el("authorization-submit").textContent = "Save Permission";
    setMessage("authorization-message", "");
    renderManageLookup();
  }

  function syncPermanentUi() {
    const isPermanent = el("authorization-permanent").checked;
    el("authorization-end-date").disabled = isPermanent;
    if (isPermanent) {
      el("authorization-end-date").value = "";
    }
    if (!el("authorization-start-date").value) {
      el("authorization-start-date").value = todayIso();
    }
  }

  function renderManageLookup() {
    const details = el("authorization-lookup-result");
    if (!state.lookupFamily) {
      details.innerHTML = '<p class="muted">Enter another family\'s carpool number to authorize pickup.</p>';
      el("authorization-submit").disabled = true;
      return;
    }

    const ownStudents = (state.context?.own_students || [])
      .map((student) => {
        const studentId = String(student.student_id);
        const selected = state.manageSelection.has(studentId);
        return `
          <button
            type="button"
            class="btn btn-primary student-pick${selected ? " selected" : ""}"
            data-manage-student="${escapeHtml(studentId)}"
            aria-pressed="${selected ? "true" : "false"}"
          >
            <span class="student-pick-content">
              <span class="student-pick-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
              <small class="student-pick-grade">${escapeHtml(student.class_name || "")}</small>
            </span>
          </button>
        `;
      })
      .join("");

    details.innerHTML = `
      <div class="lookup-family-box">
        <p class="family-card-label">Receiving Family</p>
        <h3>${escapeHtml(state.lookupFamily.parent_names)}</h3>
        <p class="family-card-meta">Carpool #${escapeHtml(String(state.lookupFamily.carpool_number))}</p>
      </div>
      <div class="lookup-family-box">
        <p class="family-card-label">Students You Are Authorizing</p>
        <div class="family-students">${ownStudents}</div>
      </div>
    `;

    el("authorization-submit").disabled =
      !state.manageSelection.size ||
      !el("authorization-start-date").value ||
      (!el("authorization-permanent").checked && !el("authorization-end-date").value);
  }

  async function loadFamily(number) {
    state.context = await getCheckinContext(number);
    state.authorizations = await getFamilyAuthorizations(number);
    resetSelections();
    renderCheckinArea();
    renderAuthorizationList();
    resetManageForm();
  }

  async function continueWithNumber(number) {
    show("number-error", false);
    show("students-error", false);

    if (!number) {
      showError("number-error", "Please enter your carpool number.");
      return;
    }

    state.number = Number(number);
    syncNumberUi();

    try {
      await loadFamily(state.number);
      localStorage.setItem(STORAGE_KEY, String(state.number));
      hideAllSections();
      show("entry-card", false);
      show("students-section", true);
    } catch (error) {
      showError("number-error", error.message || "Unable to connect. Please try again.");
    }
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

  async function submitSelectedStudents() {
    const targets = collectTargets();
    if (!targets.length) {
      showError("students-error", "Choose at least one student.");
      return;
    }

    show("students-error", false);
    el("students-submit").disabled = true;

    try {
      const result = await submitCheckInRequest(targets);
      const calledFamilies = (result.families || []).flatMap((family) =>
        (family.students || []).map((student) => `${student.first_name} ${student.last_name}`)
      );
      el("done-message").textContent = `Done! ${calledFamilies.join(", ")} called.`;
      resetSelections();
      hideAllSections();
      show("entry-card", false);
      show("done-card", true);
      show("done-section", true);
      await loadFamily(state.number);
    } catch (error) {
      showError("students-error", error.message || "Unable to check in right now. Please try again.");
      renderCheckinArea();
    }
  }

  async function lookupReceivingFamily() {
    const number = el("authorize-carpool-number").value.trim();
    setMessage("authorization-message", "");

    if (!number) {
      setMessage("authorization-message", "Enter a carpool number to authorize.", "error");
      return;
    }

    if (Number(number) === Number(state.number)) {
      setMessage("authorization-message", "Choose a different carpool number.", "error");
      return;
    }

    try {
      const data = await getCheckinContext(number);
      state.lookupFamily = data.requesting_family;
      renderManageLookup();
    } catch (error) {
      state.lookupFamily = null;
      renderManageLookup();
      setMessage("authorization-message", "Carpool number not found.", "error");
    }
  }

  function loadAuthIntoForm(auth) {
    state.editingAuthorizationId = auth.authorization_id;
    state.lookupFamily = auth.receiving_family;
    state.manageSelection = new Set((auth.students || []).map((student) => String(student.student_id)));
    el("authorize-carpool-number").value = auth.receiving_family.carpool_number || "";
    el("authorization-start-date").value = auth.starts_on || todayIso();
    const isPermanent = auth.ends_on === PERMANENT_END_DATE;
    el("authorization-permanent").checked = isPermanent;
    el("authorization-end-date").value = isPermanent ? "" : (auth.ends_on || "");
    syncPermanentUi();
    el("authorization-submit").textContent = "Save Changes";
    renderManageLookup();
  }

  async function saveAuthorization() {
    const startDate = el("authorization-start-date").value || todayIso();
    const endDate = el("authorization-permanent").checked ? PERMANENT_END_DATE : el("authorization-end-date").value;
    if (!state.lookupFamily) {
      setMessage("authorization-message", "Look up a receiving family first.", "error");
      return;
    }
    if (!startDate || !endDate) {
      setMessage("authorization-message", "Choose a start date and either an end date or permanent permission.", "error");
      return;
    }
    if (!state.manageSelection.size) {
      setMessage("authorization-message", "Choose at least one student to authorize.", "error");
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
          p_receiving_carpool_number: Number(state.lookupFamily.carpool_number)
        });
      }

      state.authorizations = await getFamilyAuthorizations(state.number);
      renderAuthorizationList();
      resetManageForm();
      setMessage("authorization-message", "Permission saved.", "success");
    } catch (error) {
      setMessage("authorization-message", error.message || "Unable to save permission.", "error");
    }
  }

  async function handleRevoke(authId) {
    try {
      await revokeAuthorization(authId);
      state.authorizations = await getFamilyAuthorizations(state.number);
      renderAuthorizationList();
    } catch (error) {
      setMessage("authorization-message", error.message || "Unable to revoke permission.", "error");
    }
  }

  function bindEvents() {
    el("find-family").addEventListener("click", () => continueWithNumber(el("carpool-number").value.trim()));
    el("carpool-number").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        continueWithNumber(el("carpool-number").value.trim());
      }
    });

    el("cached-yes").addEventListener("click", () => continueWithNumber(state.number));
    el("cached-change").addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      state.number = null;
      syncNumberUi();
      showNumberStep(true);
    });
    el("done-btn").addEventListener("click", () => {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        state.number = Number(cached);
        syncNumberUi();
        hideAllSections();
        show("cached-section", true);
      } else {
        showNumberStep(true);
      }
    });

    el("checkin-groups").addEventListener("click", (event) => {
      const studentBtn = event.target.closest("[data-student-id]");
      if (studentBtn) {
        const familyId = studentBtn.dataset.familyId;
        const studentId = studentBtn.dataset.studentId;
        const set = state.selectedByFamily.get(familyId) || new Set();
        if (set.has(studentId)) set.delete(studentId);
        else set.add(studentId);
        state.selectedByFamily.set(familyId, set);
        renderCheckinArea();
        return;
      }

      const familyBtn = event.target.closest("[data-select-family]");
      if (familyBtn) {
        const familyId = familyBtn.dataset.selectFamily;
        const card = familyCards().find((item) => item.family_id === familyId);
        const set = new Set((card?.students || []).map((student) => String(student.student_id)));
        state.selectedByFamily.set(familyId, set);
        renderCheckinArea();
      }
    });

    el("students-submit").addEventListener("click", submitSelectedStudents);

    el("lookup-authorization-family").addEventListener("click", lookupReceivingFamily);
    el("authorize-carpool-number").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        lookupReceivingFamily();
      }
    });

    el("authorization-lookup-result").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-manage-student]");
      if (!btn) return;
      const studentId = btn.dataset.manageStudent;
      if (state.manageSelection.has(studentId)) state.manageSelection.delete(studentId);
      else state.manageSelection.add(studentId);
      renderManageLookup();
    });

    ["authorization-start-date", "authorization-end-date"].forEach((id) => {
      el(id).addEventListener("input", renderManageLookup);
    });
    el("authorization-permanent").addEventListener("change", () => {
      syncPermanentUi();
      renderManageLookup();
    });

    el("authorization-submit").addEventListener("click", saveAuthorization);
    el("authorization-reset").addEventListener("click", resetManageForm);

    el("authorization-list").addEventListener("click", (event) => {
      const editBtn = event.target.closest("[data-edit-auth]");
      if (editBtn) {
        const auth = state.authorizations.find((item) => item.authorization_id === editBtn.dataset.editAuth);
        if (auth) loadAuthIntoForm(auth);
        return;
      }

      const revokeBtn = event.target.closest("[data-revoke-auth]");
      if (revokeBtn) {
        handleRevoke(revokeBtn.dataset.revokeAuth);
      }
    });
  }

  function init() {
    if (!window.carpoolClient) {
      show("config-warning", true);
      return;
    }

    bindEvents();

    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) {
      state.number = Number(cached);
      syncNumberUi();
      hideAllSections();
      show("cached-section", true);
    } else {
      syncNumberUi();
      showNumberStep(true);
    }
  }

  init();
})();
