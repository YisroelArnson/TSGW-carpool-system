(function classroomPage() {
  const { mustClient, schoolTodayISO, fetchSchoolToday, show, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const state = {
    mode: "hub",
    classId: null,
    today: schoolTodayISO(),
    classes: [],
    students: [],
    statusesByStudent: new Map(),
    studentToClass: new Map(),
    classTotals: new Map(),
    classCalled: new Map(),
    displayStudents: [],
    channel: null,
    syncInterval: null
  };

  function el(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    el("classroom-error-text").textContent = message;
    show("classroom-error", true);
  }

  function deriveRoute() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "classroom") return;

    const classIdFromPath = parts[1] || null;
    const classIdFromQuery = new URLSearchParams(window.location.search).get("classId");
    const classId = classIdFromPath || classIdFromQuery;

    if (classId) {
      state.mode = "display";
      state.classId = classId;
      document.body.classList.add("projector");
      const brand = el("brand");
      if (brand) brand.classList.add("hidden");
    }
  }

  function buildMaps() {
    state.studentToClass.clear();
    state.classTotals.clear();
    state.classCalled.clear();

    state.students.forEach((s) => {
      state.studentToClass.set(s.id, s.class_id);
      state.classTotals.set(s.class_id, (state.classTotals.get(s.class_id) || 0) + 1);
    });

    state.statusesByStudent.forEach((status, studentId) => {
      if (status !== "CALLED") return;
      const classId = state.studentToClass.get(studentId);
      if (!classId) return;
      state.classCalled.set(classId, (state.classCalled.get(classId) || 0) + 1);
    });
  }

  async function fetchBase() {
    const client = mustClient();

    const [classesRes, studentsRes, statusRes] = await Promise.all([
      client.from("classes").select("id,name,display_order").order("display_order", { ascending: true }),
      client.from("students").select("id,first_name,last_name,class_id"),
      client.from("daily_status").select("student_id,status").eq("date", state.today)
    ]);

    if (classesRes.error) throw classesRes.error;
    if (studentsRes.error) throw studentsRes.error;
    if (statusRes.error) throw statusRes.error;

    state.classes = classesRes.data || [];
    state.students = studentsRes.data || [];
    state.statusesByStudent = new Map();

    (statusRes.data || []).forEach((row) => {
      state.statusesByStudent.set(row.student_id, row.status);
    });

    buildMaps();
  }

  function hubCardHtml(cls) {
    const total = state.classTotals.get(cls.id) || 0;
    const called = state.classCalled.get(cls.id) || 0;
    const complete = total > 0 && called === total;

    return `<button class="class-card ${complete ? "complete" : ""}" data-class-id="${escapeHtml(cls.id)}">
      <div><strong>${escapeHtml(cls.name)}</strong></div>
      <div>${called} / ${total}</div>
    </button>`;
  }

  function renderHub() {
    show("hub-view", true);
    show("display-view", false);

    const grid = el("hub-grid");
    grid.innerHTML = state.classes.map(hubCardHtml).join("");

    grid.querySelectorAll("[data-class-id]").forEach((node) => {
      node.addEventListener("click", () => {
        const classId = node.dataset.classId;
        window.location.href = `/classroom/?classId=${classId}`;
      });
    });
  }

  function renderDisplay() {
    show("hub-view", false);
    show("display-view", true);

    const classInfo = state.classes.find((c) => c.id === state.classId);
    if (!classInfo) {
      showError("Classroom not found.");
      return;
    }

    el("display-class-name").textContent = classInfo.name;

    const students = state.students
      .filter((s) => s.class_id === state.classId)
      .sort((a, b) => {
        const ln = a.last_name.localeCompare(b.last_name);
        return ln !== 0 ? ln : a.first_name.localeCompare(b.first_name);
      });

    state.displayStudents = students;

    const html = students
      .map((s) => {
        const status = state.statusesByStudent.get(s.id) || "WAITING";
        const klass = status === "CALLED" ? "called" : "waiting";
        return `<div class="student-card ${klass}" data-student-id="${escapeHtml(s.id)}">${escapeHtml(
          `${s.last_name}, ${s.first_name}`
        )}</div>`;
      })
      .join("");

    el("display-grid").innerHTML = html;
  }

  function updateHubCard(classId) {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) return;

    const card = document.querySelector(`[data-class-id="${classId}"]`);
    if (!card) return;

    const total = state.classTotals.get(classId) || 0;
    const called = state.classCalled.get(classId) || 0;
    const complete = total > 0 && called === total;

    card.className = `class-card${complete ? " complete" : ""}`;
    card.querySelector("div:last-child").textContent = `${called} / ${total}`;
  }

  function updateDisplayStudent(studentId) {
    const node = document.querySelector(`[data-student-id="${studentId}"]`);
    if (!node) return;
    const status = state.statusesByStudent.get(studentId) || "WAITING";
    node.classList.remove("waiting", "called");
    node.classList.add(status === "CALLED" ? "called" : "waiting");
  }

  function applyDelta(oldStatus, newStatus, studentId) {
    const oldCalled = oldStatus === "CALLED" ? 1 : 0;
    const newCalled = newStatus === "CALLED" ? 1 : 0;
    const delta = newCalled - oldCalled;
    if (delta === 0) return;

    const classId = state.studentToClass.get(studentId);
    if (!classId) return;

    state.classCalled.set(classId, (state.classCalled.get(classId) || 0) + delta);
    if (state.mode === "hub") updateHubCard(classId);
  }

  function onRealtime(payload) {
    const record = payload.new || payload.old;
    if (!record || record.date !== state.today) return;

    const studentId = record.student_id;
    const oldStatus = payload.old && payload.old.status ? payload.old.status : state.statusesByStudent.get(studentId) || "WAITING";
    const newStatus = payload.new && payload.new.status ? payload.new.status : "WAITING";

    applyDelta(oldStatus, newStatus, studentId);
    state.statusesByStudent.set(studentId, newStatus);

    if (state.mode === "display") {
      updateDisplayStudent(studentId);
    }
  }

  async function fullResync() {
    const client = mustClient();
    const { data, error } = await client.from("daily_status").select("student_id,status").eq("date", state.today);
    if (error) return;

    state.statusesByStudent = new Map();
    (data || []).forEach((row) => state.statusesByStudent.set(row.student_id, row.status));
    buildMaps();

    if (state.mode === "hub") renderHub();
    else renderDisplay();
  }

  function startRealtime() {
    const client = mustClient();
    state.channel = client
      .channel("classroom-daily-status")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_status" }, onRealtime)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") fullResync();
      });

    state.syncInterval = window.setInterval(fullResync, 45000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fullResync();
    });
  }

  async function init() {
    if (!window.carpoolClient) {
      show("config-warning", true);
      return;
    }

    deriveRoute();

    try {
      state.today = await fetchSchoolToday();
      await fetchBase();
      if (state.mode === "hub") renderHub();
      else renderDisplay();
      startRealtime();
    } catch (error) {
      showError(error.message || "Unable to load classroom view.");
    }
  }

  window.addEventListener("beforeunload", () => {
    if (state.syncInterval) clearInterval(state.syncInterval);
    if (state.channel && window.carpoolClient) {
      window.carpoolClient.removeChannel(state.channel);
    }
  });

  init();
})();
