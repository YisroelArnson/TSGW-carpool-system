(function adminPage() {
  const { mustClient, show, requireAuth, csvToRows, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const state = {
    classes: [],
    families: [],
    students: []
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setMsg(id, text, klass) {
    const node = el(id);
    node.className = klass || "";
    node.textContent = text;
    show(id, Boolean(text));
  }

  async function fetchAll() {
    const client = mustClient();
    const [classesRes, familiesRes, studentsRes] = await Promise.all([
      client.from("classes").select("id,name,display_order").order("display_order", { ascending: true }),
      client.from("families").select("id,carpool_number,parent_names,contact_info").order("carpool_number", { ascending: true }),
      client
        .from("students")
        .select("id,first_name,last_name,class_id,family_id,classes(name),families(parent_names,carpool_number)")
        .order("last_name", { ascending: true })
    ]);

    if (classesRes.error) throw classesRes.error;
    if (familiesRes.error) throw familiesRes.error;
    if (studentsRes.error) throw studentsRes.error;

    state.classes = classesRes.data || [];
    state.families = familiesRes.data || [];
    state.students = studentsRes.data || [];
  }

  function fillSelects() {
    el("new-student-family").innerHTML = '<option value="">Select Family</option>' + state.families
      .map((f) => `<option value="${escapeHtml(f.id)}">#${escapeHtml(String(f.carpool_number))} - ${escapeHtml(f.parent_names)}</option>`)
      .join("");

    el("new-student-class").innerHTML = '<option value="">Select Class</option>' + state.classes
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
      .join("");
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

    document.querySelectorAll("[data-edit-family]").forEach((btn) => {
      btn.addEventListener("click", () => editFamily(btn.dataset.editFamily));
    });

    document.querySelectorAll("[data-delete-family]").forEach((btn) => {
      btn.addEventListener("click", () => deleteFamily(btn.dataset.deleteFamily));
    });
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

    document.querySelectorAll("[data-edit-class]").forEach((btn) => {
      btn.addEventListener("click", () => editClass(btn.dataset.editClass));
    });

    document.querySelectorAll("[data-delete-class]").forEach((btn) => {
      btn.addEventListener("click", () => deleteClass(btn.dataset.deleteClass));
    });
  }

  function renderStudents() {
    const html = state.students
      .map((s) => {
        return `<tr>
          <td>${escapeHtml(`${s.last_name}, ${s.first_name}`)}</td>
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

    document.querySelectorAll("[data-edit-student]").forEach((btn) => {
      btn.addEventListener("click", () => editStudent(btn.dataset.editStudent));
    });

    document.querySelectorAll("[data-delete-student]").forEach((btn) => {
      btn.addEventListener("click", () => deleteStudent(btn.dataset.deleteStudent));
    });
  }

  function renderOverview() {
    const byClass = new Map();
    state.classes.forEach((cls) => byClass.set(cls.id, { name: cls.name, students: [] }));

    state.students.forEach((s) => {
      if (!byClass.has(s.class_id)) return;
      byClass.get(s.class_id).students.push({
        name: `${s.last_name}, ${s.first_name}`,
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

  function renderAll() {
    fillSelects();
    renderFamilies();
    renderClasses();
    renderStudents();
    renderOverview();
  }

  async function refreshAndRender() {
    await fetchAll();
    renderAll();
  }

  async function addFamily() {
    const client = mustClient();
    const carpool = Number(el("new-family-number").value);
    const parents = el("new-family-parents").value.trim();
    const contact = el("new-family-contact").value.trim() || null;

    if (!carpool || !parents) {
      setMsg("family-form-msg", "Carpool number and parent names are required.", "error");
      return;
    }

    const { error } = await client.from("families").insert({ carpool_number: carpool, parent_names: parents, contact_info: contact });
    if (error) {
      setMsg("family-form-msg", error.message, "error");
      return;
    }

    el("new-family-number").value = "";
    el("new-family-parents").value = "";
    el("new-family-contact").value = "";
    setMsg("family-form-msg", "Family added.", "success");
    await refreshAndRender();
  }

  async function addClass() {
    const client = mustClient();
    const name = el("new-class-name").value.trim();
    const order = Number(el("new-class-order").value || 0);

    if (!name) {
      setMsg("class-form-msg", "Class name is required.", "error");
      return;
    }

    const { error } = await client.from("classes").insert({ name, display_order: order });
    if (error) {
      setMsg("class-form-msg", error.message, "error");
      return;
    }

    el("new-class-name").value = "";
    el("new-class-order").value = "";
    setMsg("class-form-msg", "Class added.", "success");
    await refreshAndRender();
  }

  async function addStudent() {
    const client = mustClient();
    const first = el("new-student-first").value.trim();
    const last = el("new-student-last").value.trim();
    const familyId = el("new-student-family").value;
    const classId = el("new-student-class").value;

    if (!first || !last || !familyId || !classId) {
      setMsg("student-form-msg", "All student fields are required.", "error");
      return;
    }

    const { error } = await client.from("students").insert({ first_name: first, last_name: last, family_id: familyId, class_id: classId });
    if (error) {
      setMsg("student-form-msg", error.message, "error");
      return;
    }

    el("new-student-first").value = "";
    el("new-student-last").value = "";
    el("new-student-family").value = "";
    el("new-student-class").value = "";
    setMsg("student-form-msg", "Student added.", "success");
    await refreshAndRender();
  }

  async function editFamily(id) {
    const fam = state.families.find((f) => f.id === id);
    if (!fam) return;

    const number = prompt("Carpool number", String(fam.carpool_number));
    if (number === null) return;
    const parents = prompt("Parent names", fam.parent_names || "");
    if (parents === null) return;
    const contact = prompt("Contact info", fam.contact_info || "");
    if (contact === null) return;

    const client = mustClient();
    const { error } = await client
      .from("families")
      .update({ carpool_number: Number(number), parent_names: parents.trim(), contact_info: contact.trim() || null })
      .eq("id", id);

    if (error) {
      alert(error.message);
      return;
    }

    await refreshAndRender();
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

  async function editClass(id) {
    const cls = state.classes.find((c) => c.id === id);
    if (!cls) return;

    const name = prompt("Class name", cls.name);
    if (name === null) return;
    const displayOrder = prompt("Display order", String(cls.display_order));
    if (displayOrder === null) return;

    const client = mustClient();
    const { error } = await client
      .from("classes")
      .update({ name: name.trim(), display_order: Number(displayOrder || 0) })
      .eq("id", id);

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

  async function editStudent(id) {
    const student = state.students.find((s) => s.id === id);
    if (!student) return;

    const first = prompt("First name", student.first_name);
    if (first === null) return;
    const last = prompt("Last name", student.last_name);
    if (last === null) return;

    const classOptions = state.classes.map((c) => `${c.id}:${c.name}`).join("\n");
    const classChoice = prompt(`Class ID (choose one):\n${classOptions}`, student.class_id);
    if (classChoice === null) return;

    const familyOptions = state.families.map((f) => `${f.id}:#${f.carpool_number} ${f.parent_names}`).join("\n");
    const familyChoice = prompt(`Family ID (choose one):\n${familyOptions}`, student.family_id);
    if (familyChoice === null) return;

    const client = mustClient();
    const { error } = await client
      .from("students")
      .update({ first_name: first.trim(), last_name: last.trim(), class_id: classChoice.trim(), family_id: familyChoice.trim() })
      .eq("id", id);

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

  async function importCsv() {
    const file = el("csv-file").files && el("csv-file").files[0];
    if (!file) {
      el("csv-result").innerHTML = '<p class="error">Choose a CSV file first.</p>';
      return;
    }

    const text = await file.text();
    const rows = csvToRows(text);

    if (!rows.length) {
      el("csv-result").innerHTML = '<p class="error">CSV is empty.</p>';
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

    el("csv-result").innerHTML = `
      <p class="success">Imported ${results.students_created} students, created ${results.families_created} families, created ${results.classes_created} classes.</p>
      ${results.errors.length ? `<p class="error">${results.errors.length} errors:</p><ul>${results.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
    `;
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

    el("add-family-btn").addEventListener("click", addFamily);
    el("add-class-btn").addEventListener("click", addClass);
    el("add-student-btn").addEventListener("click", addStudent);
    el("csv-import-btn").addEventListener("click", importCsv);
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

      await refreshAndRender();
    } catch (error) {
      show("admin-login-section", true);
      el("admin-login-error").textContent = error.message || "Unable to load admin dashboard.";
      show("admin-login-error", true);
    }
  }

  init();
})();
