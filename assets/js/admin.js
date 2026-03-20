(function adminPage() {
  const { mustClient, show, requireAuth, csvToRows, escapeHtml, schoolTodayISO, fetchSchoolToday } = window.carpoolUtils || {};
  if (!mustClient) return;

  const PERMANENT_END_DATE = "9999-12-31";

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
    return `#${family.carpool_number} - ${family.parent_names}`;
  }

  function classLabel(cls) {
    return cls.name;
  }

  function studentLabel(student) {
    return `${student.last_name}, ${student.first_name}`;
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

  async function setTodayStudentStatus(studentId, status) {
    const client = mustClient();
    const payload = [{
      student_id: studentId,
      date: state.today,
      status,
      called_at: new Date().toISOString(),
      called_by: "admin"
    }];

    const { error } = await client.from("daily_status").upsert(payload, { onConflict: "student_id,date" });
    if (error) throw error;
  }

  function applyTodayStatusLocally(studentId, status) {
    const nextRecord = {
      student_id: studentId,
      date: state.today,
      status,
      called_at: new Date().toISOString(),
      called_by: "admin"
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
    await setTodayStudentStatus(studentId, nextStatus);
    applyTodayStatusLocally(studentId, nextStatus);
    renderToday();
  }

  async function repingTodayStudent(studentId) {
    await setTodayStudentStatus(studentId, "CALLED");
    applyTodayStatusLocally(studentId, "CALLED");
    renderToday();
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
    state.families = familiesRes.data || [];
    state.students = studentsRes.data || [];
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
      if (col === "parents") return f.parent_names || "";
      if (col === "contact") return f.contact_info || "";
      if (col === "students") return (byFamily.get(f.id) || []).length;
      return 0;
    };
    const sorted = sortedBy(state.families, col, dir, valFn);

    const html = sorted
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
          <td class="inline">
            <button class="btn btn-secondary" data-edit-class="${escapeHtml(c.id)}">Edit</button>
            <button class="btn btn-secondary" data-delete-class="${escapeHtml(c.id)}">Delete</button>
          </td>
        </tr>
        <tr class="class-detail-row hidden" data-detail-for="${escapeHtml(c.id)}">
          <td></td>
          <td colspan="4">
            <table class="detail-table">
              <thead><tr><th>Student</th><th>Carpool #</th></tr></thead>
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
      if (col === "family") return s.families ? s.families.parent_names : "";
      if (col === "carpool") return s.families ? s.families.carpool_number : 0;
      return "";
    };
    const sorted = sortedBy(state.students, col, dir, valFn);

    const html = sorted
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
      if (col === "family") return stu && stu.families ? stu.families.parent_names : "";
      if (col === "carpool") return stu && stu.families ? stu.families.carpool_number : 0;
      if (col === "status") return rec.status || "";
      if (col === "source") return rec.called_by || "";
      return "";
    };
    const sorted = sortedBy(enriched, col, dir, valFn);

    const rows = sorted
      .map(({ rec, stu }) => {
        const time = rec.called_at ? new Date(rec.called_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
        const statusClass = rec.status === "CALLED" ? "status status-called" : "status status-waiting";
        return `<tr>
          <td>${escapeHtml(time)}</td>
          <td>${escapeHtml(stu ? studentLabel(stu) : "Unknown student")}</td>
          <td>${escapeHtml(stu && stu.classes ? stu.classes.name : "")}</td>
          <td>${escapeHtml(stu && stu.families ? stu.families.parent_names : "")}</td>
          <td>${escapeHtml(stu && stu.families ? String(stu.families.carpool_number) : "")}</td>
          <td><span class="${statusClass}${stu ? " is-toggle" : ""}" ${stu ? `data-today-student-id="${escapeHtml(stu.id)}"` : ""}>${escapeHtml(rec.status)}</span></td>
          <td>${escapeHtml(rec.called_by || "-")}</td>
          <td>${stu ? `<button class="btn btn-secondary" data-reping-student="${escapeHtml(stu.id)}">${rec.status === "CALLED" ? "Reping" : "Set CALLED"}</button>` : "-"}</td>
        </tr>`;
      })
      .join("");

    el("today-attempts-tbody").innerHTML = rows || '<tr><td colspan="8" class="muted">No dismissal attempts yet today.</td></tr>';
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

    const html = students
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

    el("today-student-grid").innerHTML = html || '<p class="muted">No students yet.</p>';
  }

  function renderAll() {
    renderToday();
    renderFamilies();
    renderClasses();
    renderStudents();
    renderPermissions();
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
                <button class="icon-action-btn" type="button" data-edit-auth="${escapeHtml(auth.id)}" aria-label="Edit permission">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path>
                  </svg>
                </button>
                <button class="icon-action-btn danger" type="button" data-revoke-auth="${escapeHtml(auth.id)}" aria-label="Revoke permission">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M3 6h18"></path>
                    <path d="M8 6V4h8v2"></path>
                    <path d="M19 6l-1 14H6L5 6"></path>
                    <path d="M10 11v6"></path>
                    <path d="M14 11v6"></path>
                  </svg>
                </button>
              </div>
            </td>`;

        return `<tr>
          <td>${escapeHtml(granting ? `#${granting.carpool_number} - ${granting.parent_names}` : "Unknown")}</td>
          <td>${escapeHtml(receiving ? `#${receiving.carpool_number} - ${receiving.parent_names}` : "Unknown")}</td>
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
          <td>${escapeHtml(owner ? `#${owner.carpool_number} - ${owner.parent_names}` : "Unknown")}</td>
          <td>${escapeHtml(preset.name || "")}</td>
          <td>${escapeHtml(students || "No students")}</td>
          <td class="inline">
            <button class="btn btn-secondary" data-edit-preset="${escapeHtml(preset.id)}">Edit</button>
            <button class="btn btn-secondary" data-delete-preset="${escapeHtml(preset.id)}">Delete</button>
          </td>
        </tr>`;
      })
      .join("");

    el("presets-tbody").innerHTML = presetRows || '<tr><td colspan="4" class="muted">No saved carpools yet.</td></tr>';
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
          <td>${escapeHtml(granting ? `#${granting.carpool_number} - ${granting.parent_names}` : "Unknown")}</td>
          <td>${escapeHtml(receiving ? `#${receiving.carpool_number} - ${receiving.parent_names}` : "Unknown")}</td>
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
      const familyText = sourceFamily ? `#${sourceFamily.carpool_number} - ${sourceFamily.parent_names}` : "Unknown family";
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
          <label>Students</label>
          <div id="modal-preset-students" class="checkbox-list">${presetStudentPickerHtml(data?.owner_family_id || "", data?.student_ids || [])}</div>
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
    } else if (mode === "import-csv") {
      title = "Import CSV";
      submitLabel = "Run Import";
      body = modalFieldTemplate("import");
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

    if (!ownerFamilyId || !name || !studentIds.length) {
      setNodeMessage("admin-modal-msg", "Choose an owner family, a name, and at least one student.", "error");
      return;
    }

    const rpcName = isEdit ? "admin_update_carpool_preset" : "admin_create_carpool_preset";
    const params = isEdit
      ? {
          p_preset_id: state.modal.entityId,
          p_owner_family_id: ownerFamilyId,
          p_name: name,
          p_student_ids: studentIds
        }
      : {
          p_owner_family_id: ownerFamilyId,
          p_name: name,
          p_student_ids: studentIds
        };

    const { error } = await client.rpc(rpcName, params);
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
    if (mode === "add-permission") return savePermission(false);
    if (mode === "edit-permission") return savePermission(true);
    if (mode === "add-preset") return savePreset(false);
    if (mode === "edit-preset") return savePreset(true);
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

    el("today-student-grid").addEventListener("click", async (event) => {
      const card = event.target.closest("[data-today-grid-student-id]");
      if (!card) return;
      const studentId = card.dataset.todayGridStudentId;
      if (!studentId) return;
      try {
        const current = dailyStatusMap().get(studentId);
        if (current && current.status === "CALLED") {
          await repingTodayStudent(studentId);
        } else {
          await toggleTodayStudentStatus(studentId);
        }
      } catch (error) {
        alert(error.message || "Unable to update student status.");
      }
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
    if (state.channel && window.carpoolClient) {
      window.carpoolClient.removeChannel(state.channel);
    }
  });
})();
