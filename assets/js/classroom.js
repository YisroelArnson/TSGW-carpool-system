(function classroomPage() {
  const { mustClient, schoolTodayISO, fetchSchoolToday, show, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const state = {
    mode: "hub",
    classIds: [],
    today: schoolTodayISO(),
    classes: [],
    students: [],
    statusesByStudent: new Map(),
    studentToClass: new Map(),
    classTotals: new Map(),
    classCalled: new Map(),
    selectedHubClassIds: new Set(),
    channel: null,
    syncInterval: null,
    calloutTimer: null,
    audioContext: null,
    alertQueue: [],
    activeAlertStudentId: null
  };

  function el(id) {
    return document.getElementById(id);
  }

  function showError(message) {
    el("classroom-error-text").textContent = message;
    show("classroom-error", true);
  }

  function parseClassIds() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const classroomIdx = parts.indexOf("classroom");
    const pathClassId = classroomIdx === -1 ? null : parts[classroomIdx + 1] || null;

    const params = new URLSearchParams(window.location.search);
    const queryIds = params
      .getAll("classId")
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean);

    return Array.from(new Set([pathClassId, ...queryIds].filter(Boolean)));
  }

  function deriveRoute() {
    const classIds = parseClassIds();
    if (!classIds.length) return;

    state.mode = "display";
    state.classIds = classIds;
    document.body.classList.add("projector");

    const brand = el("brand");
    if (brand) brand.classList.add("hidden");
  }

  function navigateToCombined(classIds) {
    const uniqueIds = Array.from(new Set(classIds.filter(Boolean)));
    if (!uniqueIds.length) {
      window.location.href = window.location.pathname;
      return;
    }

    const params = new URLSearchParams();
    params.set("classId", uniqueIds.join(","));
    window.location.href = `?${params.toString()}`;
  }

  function buildMaps() {
    state.studentToClass.clear();
    state.classTotals.clear();
    state.classCalled.clear();

    state.students.forEach((student) => {
      state.studentToClass.set(student.id, student.class_id);
      state.classTotals.set(student.class_id, (state.classTotals.get(student.class_id) || 0) + 1);
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

  function getClassName(classId) {
    return state.classes.find((cls) => cls.id === classId)?.name || "Class";
  }

  function getDisplayClassTitle() {
    const selectedClasses = state.classIds
      .map((classId) => state.classes.find((cls) => cls.id === classId))
      .filter(Boolean);

    if (!selectedClasses.length) return "Classroom";
    if (selectedClasses.length === 1) return selectedClasses[0].name;
    if (selectedClasses.length === 2) return `${selectedClasses[0].name} + ${selectedClasses[1].name}`;
    return `${selectedClasses[0].name} + ${selectedClasses.length - 1} more`;
  }

  function getSortedStudents(classIds) {
    const allowed = classIds ? new Set(classIds) : null;
    const classOrder = new Map(state.classes.map((cls, index) => [cls.id, cls.display_order ?? index]));

    return [...state.students]
      .filter((student) => !allowed || allowed.has(student.class_id))
      .sort((a, b) => {
        const classCmp = (classOrder.get(a.class_id) || 0) - (classOrder.get(b.class_id) || 0);
        if (classCmp !== 0) return classCmp;
        const lastCmp = a.last_name.localeCompare(b.last_name);
        return lastCmp !== 0 ? lastCmp : a.first_name.localeCompare(b.first_name);
      });
  }

  function hubCardHtml(cls) {
    const total = state.classTotals.get(cls.id) || 0;
    const called = state.classCalled.get(cls.id) || 0;
    const complete = total > 0 && called === total;
    const selected = state.selectedHubClassIds.has(cls.id);

    return `<article class="class-card ${complete ? "complete" : ""} ${selected ? "selected-for-combo" : ""}" data-class-id="${escapeHtml(cls.id)}">
      <div><strong>${escapeHtml(cls.name)}</strong></div>
      <div>${called} / ${total}</div>
      <div class="class-card-actions">
        <button type="button" class="class-card-open" data-open-class="${escapeHtml(cls.id)}">Open</button>
        <button
          type="button"
          class="class-card-toggle ${selected ? "active" : ""}"
          data-toggle-class="${escapeHtml(cls.id)}"
          aria-pressed="${selected ? "true" : "false"}"
        >
          ${selected ? "Selected" : "Combine"}
        </button>
      </div>
    </article>`;
  }

  function hubStudentCardHtml(student) {
    const status = state.statusesByStudent.get(student.id) || "WAITING";
    return `<div class="hub-student-card ${status === "CALLED" ? "called" : "waiting"}" data-hub-student-id="${escapeHtml(student.id)}">
      <div class="student-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</div>
      <div class="student-class">${escapeHtml(getClassName(student.class_id))}</div>
      <span class="status ${status === "CALLED" ? "status-called" : "status-waiting"}">${escapeHtml(status)}</span>
    </div>`;
  }

  function updateHubSelectionUi() {
    const count = state.selectedHubClassIds.size;
    const openCombined = el("hub-open-combined");
    const clearCombined = el("hub-clear-combined");
    const status = el("hub-selection-status");

    if (openCombined) openCombined.disabled = count < 2;
    if (clearCombined) clearCombined.disabled = count === 0;

    if (status) {
      status.textContent =
        count >= 2
          ? `${count} classes selected for a combined display.`
          : count === 1
            ? "Select one more class to open a combined display."
            : "Select two or more classes to combine them on one display.";
    }
  }

  function renderHub() {
    show("hub-view", true);
    show("display-view", false);

    const grid = el("hub-grid");
    grid.innerHTML = state.classes.map(hubCardHtml).join("");

    const hubStudents = el("hub-student-grid");
    hubStudents.innerHTML = getSortedStudents().map(hubStudentCardHtml).join("");

    updateHubSelectionUi();
  }

  function displayStudentCardHtml(student) {
    const status = state.statusesByStudent.get(student.id) || "WAITING";
    const klass = status === "CALLED" ? "called" : "waiting";
    return `<div class="student-card ${klass}" data-student-id="${escapeHtml(student.id)}">
      <div>${escapeHtml(`${student.last_name}, ${student.first_name}`)}</div>
    </div>`;
  }

  function renderDisplay() {
    show("hub-view", false);
    show("display-view", true);

    const selectedClasses = state.classIds.filter((classId) => state.classes.some((cls) => cls.id === classId));
    if (!selectedClasses.length) {
      showError("Classroom not found.");
      return;
    }

    state.classIds = selectedClasses;
    el("display-class-name").textContent = getDisplayClassTitle();
    el("display-callout-name").textContent = "";
    el("display-callout").classList.remove("visible");
    el("display-grid").innerHTML = getSortedStudents(selectedClasses).map(displayStudentCardHtml).join("");
  }

  function updateHubCard(classId) {
    const cls = state.classes.find((entry) => entry.id === classId);
    if (!cls) return;

    const card = document.querySelector(`[data-class-id="${classId}"]`);
    if (!card) return;

    const total = state.classTotals.get(classId) || 0;
    const called = state.classCalled.get(classId) || 0;
    const complete = total > 0 && called === total;
    const selected = state.selectedHubClassIds.has(classId);

    card.className = `class-card${complete ? " complete" : ""}${selected ? " selected-for-combo" : ""}`;
    const metric = card.querySelector("div:nth-child(2)");
    if (metric) metric.textContent = `${called} / ${total}`;
  }

  function updateHubStudentCard(studentId) {
    const node = document.querySelector(`[data-hub-student-id="${studentId}"]`);
    if (!node) return;

    const status = state.statusesByStudent.get(studentId) || "WAITING";
    node.classList.toggle("called", status === "CALLED");
    node.classList.toggle("waiting", status !== "CALLED");

    const pill = node.querySelector(".status");
    if (!pill) return;
    pill.textContent = status;
    pill.className = `status ${status === "CALLED" ? "status-called" : "status-waiting"}`;
  }

  function updateDisplayStudent(studentId, shouldPulse) {
    const node = document.querySelector(`[data-student-id="${studentId}"]`);
    if (!node) return;

    const status = state.statusesByStudent.get(studentId) || "WAITING";
    node.classList.remove("waiting", "called", "called-recent");
    node.classList.add(status === "CALLED" ? "called" : "waiting");

    if (shouldPulse && status === "CALLED") {
      node.classList.add("called-recent");
      window.setTimeout(() => node.classList.remove("called-recent"), 1800);
    }
  }

  function applyDelta(oldStatus, newStatus, studentId) {
    const oldCalled = oldStatus === "CALLED" ? 1 : 0;
    const newCalled = newStatus === "CALLED" ? 1 : 0;
    const delta = newCalled - oldCalled;
    if (delta === 0) return;

    const classId = state.studentToClass.get(studentId);
    if (!classId) return;

    state.classCalled.set(classId, (state.classCalled.get(classId) || 0) + delta);
  }

  function playChime() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    if (!state.audioContext) {
      state.audioContext = new AudioCtx();
    }

    const ctx = state.audioContext;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const start = ctx.currentTime + 0.01;
    [
      { freq: 784, duration: 0.14 },
      { freq: 1047, duration: 0.24, offset: 0.16 }
    ].forEach((tone) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = tone.freq;
      gain.gain.setValueAtTime(0.0001, start + (tone.offset || 0));
      gain.gain.exponentialRampToValueAtTime(0.12, start + (tone.offset || 0) + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + (tone.offset || 0) + tone.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start + (tone.offset || 0));
      osc.stop(start + (tone.offset || 0) + tone.duration);
    });
  }

  function processAlertQueue() {
    if (state.activeAlertStudentId || !state.alertQueue.length) return;

    const studentId = state.alertQueue.shift();
    const student = state.students.find((entry) => entry.id === studentId);
    if (!student) {
      processAlertQueue();
      return;
    }

    const callout = el("display-callout");
    const calloutName = el("display-callout-name");
    if (!callout || !calloutName) return;

    state.activeAlertStudentId = studentId;

    calloutName.textContent =
      state.classIds.length > 1
        ? `${student.first_name} ${student.last_name} · ${getClassName(student.class_id)}`
        : `${student.first_name} ${student.last_name}`;
    callout.classList.remove("visible");
    void callout.offsetWidth;
    callout.classList.add("visible");

    if (state.calloutTimer) {
      clearTimeout(state.calloutTimer);
    }

    state.calloutTimer = window.setTimeout(() => {
      callout.classList.remove("visible");
      state.activeAlertStudentId = null;
      processAlertQueue();
    }, 3200);

    playChime();
  }

  function queueCalledStudent(studentId) {
    if (state.activeAlertStudentId === studentId || state.alertQueue.includes(studentId)) return;
    state.alertQueue.push(studentId);
    processAlertQueue();
  }

  function onRealtime(payload) {
    const record = payload.new || payload.old;
    if (!record || record.date !== state.today) return;

    const studentId = record.student_id;
    const oldStatus = payload.old && payload.old.status ? payload.old.status : state.statusesByStudent.get(studentId) || "WAITING";
    const newStatus = payload.new && payload.new.status ? payload.new.status : "WAITING";

    applyDelta(oldStatus, newStatus, studentId);
    state.statusesByStudent.set(studentId, newStatus);

    const classId = state.studentToClass.get(studentId);
    if (classId) updateHubCard(classId);
    updateHubStudentCard(studentId);

    if (state.mode === "display" && state.classIds.includes(classId)) {
      const becameCalled = oldStatus !== "CALLED" && newStatus === "CALLED";
      updateDisplayStudent(studentId, becameCalled);
      if (becameCalled) queueCalledStudent(studentId);
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

  function bindUi() {
    el("hub-grid")?.addEventListener("click", (event) => {
      const openBtn = event.target.closest("[data-open-class]");
      if (openBtn) {
        navigateToCombined([openBtn.dataset.openClass]);
        return;
      }

      const toggleBtn = event.target.closest("[data-toggle-class]");
      if (!toggleBtn) return;

      const classId = toggleBtn.dataset.toggleClass;
      if (state.selectedHubClassIds.has(classId)) {
        state.selectedHubClassIds.delete(classId);
      } else {
        state.selectedHubClassIds.add(classId);
      }

      renderHub();
    });

    el("hub-open-combined")?.addEventListener("click", () => {
      navigateToCombined(Array.from(state.selectedHubClassIds));
    });

    el("hub-clear-combined")?.addEventListener("click", () => {
      state.selectedHubClassIds.clear();
      renderHub();
    });
  }

  async function init() {
    if (!window.carpoolClient) {
      show("config-warning", true);
      return;
    }

    deriveRoute();
    bindUi();

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
    if (state.calloutTimer) clearTimeout(state.calloutTimer);
    if (state.channel && window.carpoolClient) {
      window.carpoolClient.removeChannel(state.channel);
    }
  });

  init();
})();
