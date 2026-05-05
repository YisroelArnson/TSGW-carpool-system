(function classroomPage() {
  const { mustClient, schoolTodayISO, fetchSchoolToday, show, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const ALERT_VISIBLE_MS = 3000;
  const ALERT_FADE_MS = 450;

  const state = {
    mode: "hub",
    classIds: [],
    today: schoolTodayISO(),
    classes: [],
    students: [],
    statusesByStudent: new Map(),
    calledAtByStudent: new Map(),
    pickupLabelByStudent: new Map(),
    studentToClass: new Map(),
    classTotals: new Map(),
    classCalled: new Map(),
    selectedHubClassIds: new Set(),
    hubStudentsWaitingOnly: false,
    hubStudentsFullscreen: false,
    hubStudentsFitTimer: null,
    channel: null,
    syncInterval: null,
    alertTimer: null,
    audioContext: null,
    audioReady: false,
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

  function updateAudioUi(messageOverride) {
    const controls = document.querySelector(".display-audio-controls");
    const button = el("display-audio-button");
    const status = el("display-audio-status");
    if (!button || !status) return;

    if (controls) controls.classList.toggle("ready", state.audioReady);
    button.classList.toggle("ready", state.audioReady);
    button.setAttribute("aria-pressed", String(state.audioReady));
    button.setAttribute("aria-label", state.audioReady ? "Sound active. Click to test sound." : "Sound off. Click to enable sound.");
    button.title = state.audioReady ? "Sound active" : "Enable sound";
    status.textContent = messageOverride || (state.audioReady ? "Sound ready" : "Sound locked");
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
      client.from("daily_status").select("student_id,status,called_at,pickup_family_label").eq("date", state.today)
    ]);

    if (classesRes.error) throw classesRes.error;
    if (studentsRes.error) throw studentsRes.error;
    if (statusRes.error) throw statusRes.error;

    state.classes = classesRes.data || [];
    state.students = studentsRes.data || [];
    state.statusesByStudent = new Map();
    state.calledAtByStudent = new Map();
    state.pickupLabelByStudent = new Map();

    (statusRes.data || []).forEach((row) => {
      state.statusesByStudent.set(row.student_id, row.status);
      if (row.called_at) state.calledAtByStudent.set(row.student_id, row.called_at);
      if (row.pickup_family_label) state.pickupLabelByStudent.set(row.student_id, row.pickup_family_label);
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
    return selectedClasses.map((cls) => cls.name).join(" • ");
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

  function fitStudentGrid(panel, grid, cardSelector) {
    if (!panel || !grid) return;

    const cards = Array.from(grid.querySelectorAll(cardSelector));
    if (!panel.classList.contains("is-fullscreen") || !cards.length) {
      grid.classList.remove("is-fitting");
      panel.style.removeProperty("--fit-grid-columns");
      panel.style.removeProperty("--fit-grid-gap");
      panel.style.removeProperty("--fit-card-height");
      panel.style.removeProperty("--fit-card-padding");
      panel.style.removeProperty("--fit-card-radius");
      panel.style.removeProperty("--fit-card-font-size");
      return;
    }

    const rect = grid.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const count = cards.length;
    let best = { columns: 1, rows: count, cardWidth: width, cardHeight: height / count, score: 0, gap: 8 };

    for (let columns = 1; columns <= count; columns += 1) {
      const rows = Math.ceil(count / columns);
      const gap = Math.max(4, Math.min(12, Math.min(width, height) * 0.012));
      const cardWidth = (width - gap * (columns - 1)) / columns;
      const cardHeight = (height - gap * (rows - 1)) / rows;
      const score = Math.min(cardWidth / 2.8, cardHeight);
      if (cardWidth > 34 && cardHeight > 24 && score > best.score) {
        best = { columns, rows, cardWidth, cardHeight, gap, score };
      }
    }

    const sizeBase = Math.min(best.cardHeight * 0.34, best.cardWidth / 11);
    const fontSize = Math.max(0.54, Math.min(1.18, sizeBase / 16));
    const paddingY = Math.max(2, Math.min(10, best.cardHeight * 0.1));
    const paddingX = Math.max(3, Math.min(12, best.cardWidth * 0.06));
    const radius = Math.max(5, Math.min(14, Math.min(best.cardHeight, best.cardWidth) * 0.08));

    panel.style.setProperty("--fit-grid-columns", `repeat(${best.columns}, minmax(0, 1fr))`);
    panel.style.setProperty("--fit-grid-gap", `${best.gap}px`);
    panel.style.setProperty("--fit-card-height", `${Math.max(24, best.cardHeight)}px`);
    panel.style.setProperty("--fit-card-padding", `${paddingY}px ${paddingX}px`);
    panel.style.setProperty("--fit-card-radius", `${radius}px`);
    panel.style.setProperty("--fit-card-font-size", `${fontSize}rem`);
    grid.classList.add("is-fitting");
  }

  function scheduleHubStudentsFit() {
    if (state.hubStudentsFitTimer) window.cancelAnimationFrame(state.hubStudentsFitTimer);
    state.hubStudentsFitTimer = window.requestAnimationFrame(() => {
      state.hubStudentsFitTimer = null;
      fitStudentGrid(el("hub-students-card"), el("hub-student-grid"), ".hub-student-card");
    });
  }

  function setHubStudentsFullscreen(enabled, options = {}) {
    const panel = el("hub-students-card");
    const button = el("hub-students-fullscreen-btn");
    if (!panel) return;

    state.hubStudentsFullscreen = enabled;
    panel.classList.toggle("is-fullscreen", enabled);
    document.body.classList.toggle("grid-fullscreen-active", enabled);

    if (button) {
      button.textContent = enabled ? "Exit Full Screen" : "Full Screen";
      button.setAttribute("aria-pressed", String(enabled));
    }

    if (enabled) {
      if (!options.skipNative && panel.requestFullscreen && document.fullscreenElement !== panel) {
        panel.requestFullscreen().catch(() => {});
      }
      scheduleHubStudentsFit();
      window.setTimeout(scheduleHubStudentsFit, 80);
      return;
    }

    if (!options.skipNative && document.fullscreenElement === panel && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    scheduleHubStudentsFit();
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
      <div class="hub-student-name-line">
        <span class="student-name">${escapeHtml(`${student.first_name} ${student.last_name}`)}</span>
        <span class="student-class">${escapeHtml(getClassName(student.class_id))}</span>
      </div>
    </div>`;
  }

  function renderHubStudentGrid() {
    const students = getSortedStudents();
    const visibleStudents = state.hubStudentsWaitingOnly
      ? students.filter((student) => (state.statusesByStudent.get(student.id) || "WAITING") !== "CALLED")
      : students;
    const count = el("hub-student-grid-count");
    const grid = el("hub-student-grid");

    if (count) {
      count.textContent = state.hubStudentsWaitingOnly
        ? `${visibleStudents.length} waiting of ${students.length}`
        : `${students.length} students`;
    }

    if (grid) {
      grid.innerHTML = visibleStudents.map(hubStudentCardHtml).join("") || `<p class="muted">${state.hubStudentsWaitingOnly ? "Everyone has been called." : "No students yet."}</p>`;
    }

    scheduleHubStudentsFit();
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

    renderHubStudentGrid();

    updateHubSelectionUi();
  }

  function displayStudentCardHtml(student) {
    const status = state.statusesByStudent.get(student.id) || "WAITING";
    const klass = status === "CALLED" ? "called" : "waiting";
    const classLabel = state.classIds.length > 1 ? `<span class="student-card-class">${escapeHtml(getClassName(student.class_id))}</span>` : "";
    const pickupLabel = status === "CALLED" ? state.pickupLabelByStudent.get(student.id) : "";
    const pickupLine = pickupLabel ? `<span class="student-card-pickup">Pickup: ${escapeHtml(pickupLabel)}</span>` : "";
    return `<div class="student-card ${klass}" data-student-id="${escapeHtml(student.id)}">
      <div class="student-card-label">
        <span class="student-card-primary">
          <span class="student-card-name">${escapeHtml(`${student.last_name}, ${student.first_name}`)}</span>
          ${classLabel}
        </span>
        ${pickupLine}
      </div>
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
    if (state.hubStudentsWaitingOnly) {
      renderHubStudentGrid();
      return;
    }

    const node = document.querySelector(`[data-hub-student-id="${studentId}"]`);
    if (!node) return;

    const status = state.statusesByStudent.get(studentId) || "WAITING";
    node.classList.toggle("called", status === "CALLED");
    node.classList.toggle("waiting", status !== "CALLED");
    scheduleHubStudentsFit();
  }

  function updateDisplayStudent(studentId) {
    const node = document.querySelector(`[data-student-id="${studentId}"]`);
    if (!node) return;

    const student = state.students.find((entry) => entry.id === studentId);
    if (!student) return;

    node.outerHTML = displayStudentCardHtml(student);
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

  async function ensureAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    if (!state.audioContext) {
      state.audioContext = new AudioCtx();
    }

    const ctx = state.audioContext;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch (error) {
        state.audioReady = false;
        updateAudioUi("Tap Enable Sound");
        return null;
      }
    }

    state.audioReady = ctx.state === "running";
    updateAudioUi();
    return state.audioReady ? ctx : null;
  }

  function unlockAudio() {
    ensureAudioContext().catch(() => {});
  }

  function autoEnableSound() {
    updateAudioUi("Trying sound");
    ensureAudioContext()
      .then((ctx) => {
        if (ctx) {
          updateAudioUi("Sound ready");
          return;
        }
        updateAudioUi("Tap if sound stays off");
      })
      .catch(() => {
        updateAudioUi("Tap if sound stays off");
      });
  }

  async function playChime() {
    const ctx = await ensureAudioContext();
    if (!ctx) return;

    const start = ctx.currentTime + 0.01;
    const honks = [
      { startOffset: 0, duration: 0.24, peak: 0.26 },
      { startOffset: 0.34, duration: 0.24, peak: 0.28 },
      { startOffset: 0.68, duration: 0.3, peak: 0.3 }
    ];

    honks.forEach((honk) => {
      const honkStart = start + honk.startOffset;
      const honkEnd = honkStart + honk.duration;
      const master = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      const compressor = ctx.createDynamicsCompressor();
      const tones = [
        { frequency: 392, type: "sawtooth", gain: 0.62 },
        { frequency: 466.16, type: "square", gain: 0.38 }
      ];

      filter.type = "bandpass";
      filter.frequency.setValueAtTime(720, honkStart);
      filter.frequency.exponentialRampToValueAtTime(520, honkEnd);
      filter.Q.value = 1.1;

      compressor.threshold.value = -22;
      compressor.knee.value = 18;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.14;

      master.gain.setValueAtTime(0.0001, honkStart);
      master.gain.exponentialRampToValueAtTime(honk.peak, honkStart + 0.025);
      master.gain.setTargetAtTime(honk.peak * 0.86, honkStart + 0.08, 0.12);
      master.gain.exponentialRampToValueAtTime(0.0001, honkEnd);

      tones.forEach((tone, index) => {
        const osc = ctx.createOscillator();
        const toneGain = ctx.createGain();
        osc.type = tone.type;
        osc.frequency.setValueAtTime(tone.frequency, honkStart);
        osc.detune.setValueAtTime(index === 0 ? -4 : 5, honkStart);
        osc.frequency.exponentialRampToValueAtTime(tone.frequency * 0.985, honkEnd);
        toneGain.gain.value = tone.gain;
        osc.connect(toneGain);
        toneGain.connect(filter);
        osc.start(honkStart);
        osc.stop(honkEnd + 0.04);
      });

      filter.connect(master);
      master.connect(compressor);
      compressor.connect(ctx.destination);

      window.setTimeout(() => {
        filter.disconnect();
        master.disconnect();
        compressor.disconnect();
      }, Math.ceil((honk.startOffset + honk.duration + 0.2) * 1000));
    });
  }

  function bindAudioUnlock() {
    document.addEventListener("pointerdown", unlockAudio, { passive: true });
    document.addEventListener("touchstart", unlockAudio, { passive: true });
    document.addEventListener("keydown", unlockAudio);
  }

  function processAlertQueue() {
    if (state.activeAlertStudentId || !state.alertQueue.length) return;

    const studentId = state.alertQueue.shift();
    const student = state.students.find((entry) => entry.id === studentId);
    if (!student) {
      processAlertQueue();
      return;
    }

    const alertOverlay = el("display-alert-overlay");
    const alertTitle = el("display-alert-title");
    const alertClass = el("display-alert-class");
    if (!alertOverlay || !alertTitle || !alertClass) return;

    state.activeAlertStudentId = studentId;
    const className = getClassName(student.class_id);

    alertTitle.textContent = `${student.first_name} ${student.last_name}`;
    alertClass.textContent = className;
    alertOverlay.classList.remove("visible");
    void alertOverlay.offsetWidth;
    alertOverlay.classList.add("visible");

    if (state.alertTimer) {
      clearTimeout(state.alertTimer);
    }

    playChime();

    state.alertTimer = window.setTimeout(() => {
      alertOverlay.classList.remove("visible");

      state.alertTimer = window.setTimeout(() => {
        state.activeAlertStudentId = null;
        processAlertQueue();
      }, ALERT_FADE_MS);
    }, ALERT_VISIBLE_MS);
  }

  function replayActiveAlert(studentId) {
    const student = state.students.find((entry) => entry.id === studentId);
    if (!student) return;

    const alertOverlay = el("display-alert-overlay");
    const alertTitle = el("display-alert-title");
    const alertClass = el("display-alert-class");
    if (!alertOverlay || !alertTitle || !alertClass) return;

    const className = getClassName(student.class_id);
    alertTitle.textContent = `${student.first_name} ${student.last_name}`;
    alertClass.textContent = className;

    if (state.alertTimer) {
      clearTimeout(state.alertTimer);
    }

    alertOverlay.classList.remove("visible");
    void alertOverlay.offsetWidth;
    alertOverlay.classList.add("visible");
    playChime();

    state.alertTimer = window.setTimeout(() => {
      alertOverlay.classList.remove("visible");

      state.alertTimer = window.setTimeout(() => {
        state.activeAlertStudentId = null;
        processAlertQueue();
      }, ALERT_FADE_MS);
    }, ALERT_VISIBLE_MS);
  }

  function queueCalledStudent(studentId, options = {}) {
    const forceReplay = Boolean(options.forceReplay);
    if (forceReplay && state.activeAlertStudentId === studentId) {
      replayActiveAlert(studentId);
      return;
    }

    if (!forceReplay && (state.activeAlertStudentId === studentId || state.alertQueue.includes(studentId))) return;
    state.alertQueue.push(studentId);
    processAlertQueue();
  }

  function onRealtime(payload) {
    const record = payload.new || payload.old;
    if (!record || record.date !== state.today) return;

    const studentId = record.student_id;
    const oldStatus = payload.old && payload.old.status ? payload.old.status : state.statusesByStudent.get(studentId) || "WAITING";
    const newStatus = payload.new && payload.new.status ? payload.new.status : "WAITING";
    const oldCalledAt = payload.old && payload.old.called_at ? payload.old.called_at : state.calledAtByStudent.get(studentId) || null;
    const newCalledAt = payload.new && payload.new.called_at ? payload.new.called_at : null;
    const pickupLabel = payload.new && payload.new.pickup_family_label ? payload.new.pickup_family_label : "";

    applyDelta(oldStatus, newStatus, studentId);
    state.statusesByStudent.set(studentId, newStatus);
    if (newCalledAt) state.calledAtByStudent.set(studentId, newCalledAt);
    else state.calledAtByStudent.delete(studentId);
    if (newStatus === "CALLED" && pickupLabel) state.pickupLabelByStudent.set(studentId, pickupLabel);
    else state.pickupLabelByStudent.delete(studentId);

    const classId = state.studentToClass.get(studentId);
    if (classId) updateHubCard(classId);
    updateHubStudentCard(studentId);

    if (state.mode === "display" && state.classIds.includes(classId)) {
      const becameCalled = oldStatus !== "CALLED" && newStatus === "CALLED";
      const refreshedCalled = oldStatus === "CALLED" && newStatus === "CALLED" && Boolean(newCalledAt) && newCalledAt !== oldCalledAt;
      updateDisplayStudent(studentId);
      if (becameCalled) queueCalledStudent(studentId);
      if (refreshedCalled) queueCalledStudent(studentId, { forceReplay: true });
    }
  }

  async function fullResync() {
    const client = mustClient();
    const { data, error } = await client.from("daily_status").select("student_id,status,called_at,pickup_family_label").eq("date", state.today);
    if (error) return;

    state.statusesByStudent = new Map();
    state.calledAtByStudent = new Map();
    state.pickupLabelByStudent = new Map();
    (data || []).forEach((row) => {
      state.statusesByStudent.set(row.student_id, row.status);
      if (row.called_at) state.calledAtByStudent.set(row.student_id, row.called_at);
      if (row.pickup_family_label) state.pickupLabelByStudent.set(row.student_id, row.pickup_family_label);
    });
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

    el("hub-waiting-only-toggle")?.addEventListener("change", (event) => {
      state.hubStudentsWaitingOnly = event.target.checked;
      renderHubStudentGrid();
    });

    el("hub-students-fullscreen-btn")?.addEventListener("click", () => {
      setHubStudentsFullscreen(!state.hubStudentsFullscreen);
    });

    document.addEventListener("fullscreenchange", () => {
      const panel = el("hub-students-card");
      if (state.hubStudentsFullscreen && document.fullscreenElement !== panel) {
        setHubStudentsFullscreen(false, { skipNative: true });
      } else if (state.hubStudentsFullscreen) {
        scheduleHubStudentsFit();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.hubStudentsFullscreen) {
        setHubStudentsFullscreen(false);
      }
    });

    window.addEventListener("resize", scheduleHubStudentsFit);

    el("display-audio-button")?.addEventListener("click", async () => {
      const ctx = await ensureAudioContext();
      if (!ctx) {
        updateAudioUi("Tap Enable Sound");
        return;
      }

      updateAudioUi("Playing test sound");
      await playChime();
      window.setTimeout(() => updateAudioUi(), 900);
    });
  }

  async function init() {
    if (!window.carpoolClient) {
      show("config-warning", true);
      return;
    }

    deriveRoute();
    bindUi();
    bindAudioUnlock();

    try {
      state.today = await fetchSchoolToday();
      await fetchBase();

      if (state.mode === "hub") renderHub();
      else {
        renderDisplay();
        updateAudioUi();
        window.setTimeout(autoEnableSound, 100);
      }

      startRealtime();
    } catch (error) {
      showError(error.message || "Unable to load classroom view.");
    }
  }

  window.addEventListener("beforeunload", () => {
    if (state.syncInterval) clearInterval(state.syncInterval);
    if (state.alertTimer) clearTimeout(state.alertTimer);
    if (state.hubStudentsFitTimer) window.cancelAnimationFrame(state.hubStudentsFitTimer);
    if (state.channel && window.carpoolClient) {
      window.carpoolClient.removeChannel(state.channel);
    }
  });

  init();
})();
