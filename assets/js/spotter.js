(function spotterPage() {
  const { mustClient, show, requireAuth, schoolTodayISO, fetchSchoolToday, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const state = {
    today: schoolTodayISO(),
    students: [],
    statuses: new Map(),
    channel: null,
    context: null,
    selectedByFamily: new Map()
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setMessage(text, klass) {
    const node = el("spotter-checkin-message");
    node.className = klass || "";
    node.textContent = text;
    show("spotter-checkin-message", Boolean(text));
  }

  function studentStatus(studentId) {
    return state.statuses.get(studentId) || "WAITING";
  }

  function filteredStudents() {
    const search = el("spotter-search").value.trim().toLowerCase();
    const sortBy = el("spotter-sort").value;

    let list = [...state.students];
    if (search) {
      list = list.filter((s) => {
        const full = `${s.last_name}, ${s.first_name}`.toLowerCase();
        return full.includes(search) || String(s.carpool_number).includes(search);
      });
    }

    if (sortBy === "class") {
      list.sort((a, b) => a.class_name.localeCompare(b.class_name) || a.last_name.localeCompare(b.last_name));
    } else if (sortBy === "status") {
      list.sort((a, b) => studentStatus(a.id).localeCompare(studentStatus(b.id)) || a.last_name.localeCompare(b.last_name));
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
        const toggleTo = status === "CALLED" ? "WAITING" : "CALLED";

        return `<tr>
          <td>${escapeHtml(`${s.last_name}, ${s.first_name}`)}</td>
          <td>${escapeHtml(s.class_name)}</td>
          <td>${escapeHtml(String(s.carpool_number))}</td>
          <td><span class="${tag}">${status}</span></td>
          <td><button class="btn btn-secondary" data-student-id="${escapeHtml(s.id)}" data-toggle-to="${toggleTo}">Set ${toggleTo}</button></td>
        </tr>`;
      })
      .join("");

    const tbody = el("spotter-tbody");
    tbody.innerHTML = rows || '<tr><td colspan="5" class="muted">No students found.</td></tr>';

    tbody.querySelectorAll("button[data-student-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await setStatus(btn.dataset.studentId, btn.dataset.toggleTo, "spotter");
          state.statuses.set(btn.dataset.studentId, btn.dataset.toggleTo);
          renderTable();
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
    const payload = [{
      student_id: studentId,
      date: state.today,
      status,
      called_at: new Date().toISOString(),
      called_by: calledBy
    }];

    const { error } = await client.from("daily_status").upsert(payload, { onConflict: "student_id,date" });
    if (error) throw error;
  }

  async function getCheckinContext(number) {
    const client = mustClient();
    const { data, error } = await client.rpc("get_parent_checkin_context", {
      p_carpool_number: Number(number)
    });
    if (error) throw error;
    return data;
  }

  async function submitCheckInRequest(number, targets) {
    const client = mustClient();
    const { data, error } = await client.rpc("submit_check_in_request", {
      p_requesting_carpool_number: Number(number),
      p_targets: targets,
      p_called_by: "spotter"
    });
    if (error) throw error;
    return data;
  }

  function contextCards() {
    if (!state.context) return [];
    const own = state.context.requesting_family;
    const cards = [{
      family_id: own.family_id,
      carpool_number: own.carpool_number,
      parent_names: own.parent_names,
      label: "Entered Carpool",
      note: "Primary family for this number",
      students: state.context.own_students || []
    }];

    (state.context.authorized_pickups || []).forEach((family) => {
      cards.push({
        family_id: family.family_id,
        carpool_number: family.carpool_number,
        parent_names: family.parent_names,
        label: "Authorized Pickup",
        note: `Authorized from ${family.starts_on} to ${family.ends_on}`,
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

  function cardHtml(card) {
    const selected = state.selectedByFamily.get(card.family_id) || new Set();
    return `
      <article class="spotter-family-card">
        <div class="spotter-family-head">
          <div>
            <p class="spotter-family-label">${escapeHtml(card.label)}</p>
            <h3>${escapeHtml(card.parent_names)}</h3>
            <p class="spotter-family-meta">Carpool #${escapeHtml(String(card.carpool_number))}</p>
          </div>
          <button type="button" class="btn btn-accent" data-select-family="${escapeHtml(card.family_id)}">All ${card.students.length}</button>
        </div>
        <p class="spotter-family-note">${escapeHtml(card.note)}</p>
        <div class="spotter-student-grid">
          ${card.students.map((student) => {
            const studentId = String(student.student_id);
            const isSelected = selected.has(studentId);
            return `
              <button
                type="button"
                class="btn btn-primary spotter-student-pick${isSelected ? " selected" : ""}"
                data-family-id="${escapeHtml(card.family_id)}"
                data-student-id="${escapeHtml(studentId)}"
                aria-pressed="${isSelected ? "true" : "false"}"
              >
                <span class="spotter-student-copy">
                  <span class="spotter-student-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
                  <small>${escapeHtml(student.class_name || "")}</small>
                </span>
              </button>
            `;
          }).join("")}
        </div>
      </article>
    `;
  }

  function renderContextPanel() {
    const panel = el("spotter-context-panel");
    if (!state.context) {
      panel.innerHTML = "";
      show("spotter-context-panel", false);
      return;
    }

    const cards = contextCards();
    panel.innerHTML = `
      <div class="spotter-context-grid">${cards.map(cardHtml).join("")}</div>
      <p id="spotter-selection-summary" class="spotter-selection-summary">${
        selectedCount() ? `${selectedCount()} student${selectedCount() === 1 ? "" : "s"} selected` : "Choose students or tap All."
      }</p>
      <button type="button" id="spotter-submit-selection" class="btn btn-primary spotter-submit-selection" ${selectedCount() ? "" : "disabled"}>Check In Selected Students</button>
    `;
    show("spotter-context-panel", true);
  }

  async function lookupCarpool() {
    const number = el("spotter-carpool-input").value.trim();
    if (!number) {
      setMessage("Enter a carpool number.", "error");
      return;
    }

    try {
      state.context = await getCheckinContext(number);
      resetTopSelections();
      renderContextPanel();
      setMessage("");
    } catch (error) {
      state.context = null;
      renderContextPanel();
      setMessage(error.message || `Number not found: ${number}`, "error");
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
    const number = el("spotter-carpool-input").value.trim();
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
      renderContextPanel();
      el("spotter-carpool-input").value = "";
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
        .select("id,first_name,last_name,class_id,family_id,classes(name),families(carpool_number)"),
      client.from("daily_status").select("student_id,status").eq("date", state.today)
    ]);

    if (studentsRes.error) throw studentsRes.error;
    if (statusRes.error) throw statusRes.error;

    state.students = (studentsRes.data || []).map((s) => ({
      id: s.id,
      first_name: s.first_name,
      last_name: s.last_name,
      class_name: s.classes ? s.classes.name : "",
      carpool_number: s.families ? s.families.carpool_number : ""
    }));

    state.statuses = new Map();
    (statusRes.data || []).forEach((row) => state.statuses.set(row.student_id, row.status));
  }

  function onRealtime(payload) {
    const rec = payload.new || payload.old;
    if (!rec || rec.date !== state.today) return;
    state.statuses.set(rec.student_id, rec.status || "WAITING");
    renderTable();
  }

  function subscribeRealtime() {
    const client = mustClient();
    state.channel = client
      .channel("spotter-daily-status")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_status" }, onRealtime)
      .subscribe();
  }

  function bindUI() {
    el("spotter-checkin-btn").addEventListener("click", lookupCarpool);
    el("spotter-carpool-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        lookupCarpool();
      }
    });

    el("spotter-context-panel").addEventListener("click", (event) => {
      const studentBtn = event.target.closest("[data-student-id]");
      if (studentBtn) {
        const familyId = studentBtn.dataset.familyId;
        const studentId = studentBtn.dataset.studentId;
        const set = state.selectedByFamily.get(familyId) || new Set();
        if (set.has(studentId)) set.delete(studentId);
        else set.add(studentId);
        state.selectedByFamily.set(familyId, set);
        renderContextPanel();
        return;
      }

      const familyBtn = event.target.closest("[data-select-family]");
      if (familyBtn) {
        const familyId = familyBtn.dataset.selectFamily;
        const card = contextCards().find((item) => item.family_id === familyId);
        state.selectedByFamily.set(familyId, new Set((card?.students || []).map((student) => String(student.student_id))));
        renderContextPanel();
        return;
      }

      if (event.target.closest("#spotter-submit-selection")) {
        submitSelected();
      }
    });

    el("spotter-search").addEventListener("input", renderTable);
    el("spotter-sort").addEventListener("change", renderTable);

    el("spotter-logout-btn").addEventListener("click", async () => {
      const client = mustClient();
      await client.auth.signOut();
      window.location.reload();
    });

    el("spotter-login-btn").addEventListener("click", async () => {
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
