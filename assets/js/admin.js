(function adminPage() {
  const { mustClient, show, requireAuth, csvToRows, escapeHtml, schoolTodayISO, fetchSchoolToday } = window.carpoolUtils || {};
  if (!mustClient) return;

  const state = {
    today: schoolTodayISO(),
    classes: [],
    families: [],
    students: [],
    dailyStatus: [],
    currentTab: "today",
    modal: {
      mode: null,
      entityId: null
    }
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
    return `#${family.carpool_number} - ${family.parent_names}`;
  }

  function classLabel(cls) {
    return `${cls.name} (${cls.display_order})`;
  }

  function studentLabel(student) {
    return `${student.last_name}, ${student.first_name}`;
  }

  async function fetchAll() {
    const client = mustClient();
    const [classesRes, familiesRes, studentsRes, dailyStatusRes] = await Promise.all([
      client.from("classes").select("id,name,display_order").order("display_order", { ascending: true }),
      client.from("families").select("id,carpool_number,parent_names,contact_info").order("carpool_number", { ascending: true }),
      client
        .from("students")
        .select("id,first_name,last_name,class_id,family_id,classes(name),families(parent_names,carpool_number)")
        .order("last_name", { ascending: true }),
      client
        .from("daily_status")
        .select("id,student_id,status,called_at,called_by,date")
        .eq("date", state.today)
        .order("called_at", { ascending: false })
    ]);

    if (classesRes.error) throw classesRes.error;
    if (familiesRes.error) throw familiesRes.error;
    if (studentsRes.error) throw studentsRes.error;
    if (dailyStatusRes.error) throw dailyStatusRes.error;

    state.classes = classesRes.data || [];
    state.families = familiesRes.data || [];
    state.students = studentsRes.data || [];
    state.dailyStatus = dailyStatusRes.data || [];
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

    const html = state.families
      .map((f) => {
        const students = byFamily.get(f.id) || [];
        return `<tr>
          <td>${escapeHtml(String(f.carpool_number))}</td>
          <td>${escapeHtml(f.parent_names || "")}</td>
          <td>${escapeHtml(f.contact_info || "")}</td>
          <td>${escapeHtml(students.join(", "))}</td>
          <td class="inline">
            <button class="btn btn-secondary" data-edit-family="${escapeHtml(f.id)}">Edit</button>
            <button class="btn btn-secondary" data-delete-family="${escapeHtml(f.id)}">Delete</button>
          </td>
        </tr>`;
      })
      .join("");

    el("families-tbody").innerHTML = html || '<tr><td colspan="5" class="muted">No families yet.</td></tr>';
  }

  function renderClasses() {
    const counts = new Map();
    state.students.forEach((s) => counts.set(s.class_id, (counts.get(s.class_id) || 0) + 1));

    const html = state.classes
      .map((c) => {
        return `<tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(String(c.display_order))}</td>
          <td>${escapeHtml(String(counts.get(c.id) || 0))}</td>
          <td class="inline">
            <button class="btn btn-secondary" data-edit-class="${escapeHtml(c.id)}">Edit</button>
            <button class="btn btn-secondary" data-delete-class="${escapeHtml(c.id)}">Delete</button>
          </td>
        </tr>`;
      })
      .join("");

    el("classes-tbody").innerHTML = html || '<tr><td colspan="4" class="muted">No classes yet.</td></tr>';
  }

  function renderStudents() {
    const html = state.students
      .map((s) => {
        return `<tr>
          <td>${escapeHtml(studentLabel(s))}</td>
          <td>${escapeHtml(s.classes ? s.classes.name : "")}</td>
          <td>${escapeHtml(s.families ? s.families.parent_names : "")}</td>
          <td>${escapeHtml(s.families ? String(s.families.carpool_number) : "")}</td>
          <td class="inline">
            <button class="btn btn-secondary" data-edit-student="${escapeHtml(s.id)}">Edit</button>
            <button class="btn btn-secondary" data-delete-student="${escapeHtml(s.id)}">Delete</button>
          </td>
        </tr>`;
      })
      .join("");

    el("students-tbody").innerHTML = html || '<tr><td colspan="5" class="muted">No students yet.</td></tr>';
  }

  function renderOverview() {
    const byClass = new Map();
    state.classes.forEach((cls) => byClass.set(cls.id, { name: cls.name, students: [] }));

    state.students.forEach((s) => {
      if (!byClass.has(s.class_id)) return;
      byClass.get(s.class_id).students.push({
        name: studentLabel(s),
        family: s.families ? s.families.parent_names : "",
        carpool: s.families ? s.families.carpool_number : ""
      });
    });

    const html = state.classes
      .map((cls) => {
        const group = byClass.get(cls.id);
        const items = (group.students || [])
          .map((x) => `<li>${escapeHtml(x.name)} - ${escapeHtml(x.family)} (#${escapeHtml(String(x.carpool))})</li>`)
          .join("");

        return `<div class="card"><h3>${escapeHtml(cls.name)}</h3><ul>${items || '<li class="muted">No students</li>'}</ul></div>`;
      })
      .join("");

    el("overview-grid").innerHTML = html || '<p class="muted">No classes configured.</p>';
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
    const rows = state.dailyStatus
      .map((rec) => {
        const stu = byId.get(rec.student_id);
        const time = rec.called_at ? new Date(rec.called_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
        const statusClass = rec.status === "CALLED" ? "status status-called" : "status status-waiting";

        return `<tr>
          <td>${escapeHtml(time)}</td>
          <td>${escapeHtml(stu ? studentLabel(stu) : "Unknown student")}</td>
          <td>${escapeHtml(stu && stu.classes ? stu.classes.name : "")}</td>
          <td>${escapeHtml(stu && stu.families ? stu.families.parent_names : "")}</td>
          <td>${escapeHtml(stu && stu.families ? String(stu.families.carpool_number) : "")}</td>
          <td><span class="${statusClass}">${escapeHtml(rec.status)}</span></td>
          <td>${escapeHtml(rec.called_by || "-")}</td>
        </tr>`;
      })
      .join("");

    el("today-attempts-tbody").innerHTML = rows || '<tr><td colspan="7" class="muted">No dismissal attempts yet today.</td></tr>';
  }

  function renderAll() {
    renderToday();
    renderFamilies();
    renderClasses();
    renderStudents();
    renderOverview();
  }

  async function refreshAndRender() {
    await fetchAll();
    renderAll();
  }

  function modalFieldTemplate(kind, data) {
    if (kind === "family") {
      return `
        <div class="form-row">
          <label for="modal-family-number">Carpool #</label>
          <input id="modal-family-number" type="number" value="${escapeHtml(String(data?.carpool_number || ""))}" required />
        </div>
        <div class="form-row">
          <label for="modal-family-parents">Parent names</label>
          <input id="modal-family-parents" type="text" value="${escapeHtml(data?.parent_names || "")}" required />
        </div>
        <div class="form-row">
          <label for="modal-family-contact">Contact info (optional)</label>
          <input id="modal-family-contact" type="text" value="${escapeHtml(data?.contact_info || "")}" />
        </div>
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

      const classOptions = state.classes
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

    if (kind === "import") {
      return `
        <div class="form-row">
          <label for="modal-csv-file">CSV file</label>
          <input id="modal-csv-file" type="file" accept=".csv,text/csv" required />
        </div>
        <p class="muted" style="margin: 0">Columns: <code>student_first_name,student_last_name,class_name,carpool_number,parent_names</code></p>
      `;
    }

    return "";
  }

  function openModal(mode, entityId) {
    state.modal.mode = mode;
    state.modal.entityId = entityId || null;

    let title = "";
    let submitLabel = "Save";
    let body = "";

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
    } else if (mode === "import-csv") {
      title = "Import CSV";
      submitLabel = "Run Import";
      body = modalFieldTemplate("import");
    }

    el("admin-modal-title").textContent = title;
    el("admin-modal-submit").textContent = submitLabel;
    el("admin-modal-fields").innerHTML = body;
    setNodeMessage("admin-modal-msg", "");
    show("admin-modal", true);
  }

  function closeModal() {
    state.modal.mode = null;
    state.modal.entityId = null;
    show("admin-modal", false);
  }

  async function saveFamily(isEdit) {
    const client = mustClient();
    const carpool = Number(el("modal-family-number").value);
    const parents = el("modal-family-parents").value.trim();
    const contact = el("modal-family-contact").value.trim() || null;

    if (!carpool || !parents) {
      setNodeMessage("admin-modal-msg", "Carpool number and parent names are required.", "error");
      return;
    }

    const query = isEdit
      ? client.from("families").update({ carpool_number: carpool, parent_names: parents, contact_info: contact }).eq("id", state.modal.entityId)
      : client.from("families").insert({ carpool_number: carpool, parent_names: parents, contact_info: contact });

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

  async function importCsvFromModal() {
    const fileInput = el("modal-csv-file");
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      setNodeMessage("admin-modal-msg", "Choose a CSV file first.", "error");
      return;
    }

    const text = await file.text();
    const rows = csvToRows(text);
    if (!rows.length) {
      setNodeMessage("admin-modal-msg", "CSV is empty.", "error");
      return;
    }

    const client = mustClient();
    const results = {
      students_created: 0,
      families_created: 0,
      classes_created: 0,
      errors: []
    };

    for (const row of rows) {
      try {
        const className = (row.class_name || "").trim();
        const carpoolNum = Number(row.carpool_number);
        const parentNames = (row.parent_names || "").trim();
        const first = (row.student_first_name || "").trim();
        const last = (row.student_last_name || "").trim();

        if (!className || !carpoolNum || !parentNames || !first || !last) {
          throw new Error("Missing required columns");
        }

        let classRow = state.classes.find((c) => c.name === className);
        if (!classRow) {
          const ins = await client.from("classes").insert({ name: className, display_order: state.classes.length + 1 }).select("id,name,display_order").single();
          if (ins.error) throw ins.error;
          classRow = ins.data;
          state.classes.push(classRow);
          results.classes_created += 1;
        }

        let familyRow = state.families.find((f) => f.carpool_number === carpoolNum);
        if (!familyRow) {
          const ins = await client
            .from("families")
            .insert({ carpool_number: carpoolNum, parent_names: parentNames })
            .select("id,carpool_number,parent_names,contact_info")
            .single();
          if (ins.error) throw ins.error;
          familyRow = ins.data;
          state.families.push(familyRow);
          results.families_created += 1;
        }

        const stuIns = await client
          .from("students")
          .insert({ first_name: first, last_name: last, class_id: classRow.id, family_id: familyRow.id });

        if (stuIns.error) throw stuIns.error;
        results.students_created += 1;
      } catch (error) {
        results.errors.push(`Row ${row.__row_number}: ${error.message}`);
      }
    }

    await refreshAndRender();
    closeModal();

    const summary = `Imported ${results.students_created} students, created ${results.families_created} families, created ${results.classes_created} classes.${results.errors.length ? ` ${results.errors.length} row(s) failed.` : ""}`;
    el("last-import-summary").innerHTML = `
      <p class="success">${escapeHtml(summary)}</p>
      ${results.errors.length ? `<ul>${results.errors.map((err) => `<li class="error">${escapeHtml(err)}</li>`).join("")}</ul>` : ""}
    `;
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
    if (mode === "import-csv") return importCsvFromModal();
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
    el("open-csv-import").addEventListener("click", () => openModal("import-csv"));

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
      setTab("today");
    } catch (error) {
      show("admin-login-section", true);
      el("admin-login-error").textContent = error.message || "Unable to load admin dashboard.";
      show("admin-login-error", true);
    }
  }

  init();
})();
