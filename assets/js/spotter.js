(function spotterPage() {
  const { mustClient, show, requireAuth, schoolTodayISO, fetchSchoolToday, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const state = {
    today: schoolTodayISO(),
    students: [],
    statuses: new Map(),
    channel: null
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

  async function spotterCheckIn() {
    const number = el("spotter-carpool-input").value.trim();
    if (!number) {
      setMessage("Enter a carpool number.", "error");
      return;
    }

    const client = mustClient();
    setMessage("");

    const family = await client.from("families").select("id").eq("carpool_number", Number(number)).maybeSingle();
    if (family.error) {
      setMessage("Unable to look up family.", "error");
      return;
    }
    if (!family.data) {
      setMessage(`Number not found: ${number}`, "error");
      return;
    }

    const studentsRes = await client
      .from("students")
      .select("id,first_name,last_name")
      .eq("family_id", family.data.id)
      .order("last_name");

    if (studentsRes.error || !studentsRes.data.length) {
      setMessage("No students found for that family.", "error");
      return;
    }

    const payload = studentsRes.data.map((s) => ({
      student_id: s.id,
      date: state.today,
      status: "CALLED",
      called_at: new Date().toISOString(),
      called_by: "spotter"
    }));

    const upsertRes = await client.from("daily_status").upsert(payload, { onConflict: "student_id,date" });
    if (upsertRes.error) {
      setMessage("Failed to check in family.", "error");
      return;
    }

    studentsRes.data.forEach((s) => state.statuses.set(s.id, "CALLED"));
    renderTable();

    setMessage(`${studentsRes.data.map((s) => `${s.first_name} ${s.last_name}`).join(", ")} called`, "success");
    el("spotter-carpool-input").value = "";
    el("spotter-carpool-input").focus();
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
    el("spotter-checkin-btn").addEventListener("click", spotterCheckIn);
    el("spotter-carpool-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        spotterCheckIn();
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
      show("login-section", true);
      el("spotter-login-error").textContent = error.message || "Unable to load spotter dashboard.";
      show("spotter-login-error", true);
    }
  }

  init();
})();
