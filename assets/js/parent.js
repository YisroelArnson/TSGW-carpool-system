(function parentPage() {
  const { mustClient, show, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const STORAGE_KEY = "tsgw_carpool_number";
  const state = {
    number: null,
    students: [],
    selectedStudentIds: new Set()
  };

  function el(id) {
    return document.getElementById(id);
  }

  function hideAllSections() {
    ["cached-section", "number-section", "students-section", "done-section"].forEach((id) => show(id, false));
  }

  function syncNumberUi() {
    const numberText = state.number ? String(state.number) : "";
    const cachedLabel = el("cached-label");
    const cachedDisplay = el("cached-number-display");
    const numberInput = el("carpool-number");

    if (cachedLabel) {
      cachedLabel.textContent = numberText ? `Welcome back! Use carpool #${numberText}?` : "";
    }

    if (cachedDisplay) {
      cachedDisplay.textContent = numberText ? `#${numberText}` : "—";
    }

    if (numberInput) {
      numberInput.value = numberText;
    }
  }

  function showNumberStep(clearError) {
    hideAllSections();
    show("number-section", true);
    show("students-error", false);
    if (clearError) {
      show("number-error", false);
      el("number-error").textContent = "";
    }
    syncNumberUi();
    el("carpool-number").focus();
  }

  function showError(id, message) {
    const node = el(id);
    node.textContent = message;
    show(id, true);
  }

  async function loadStudents(number) {
    const client = mustClient();
    const { data, error } = await client.rpc("get_family_students", {
      p_carpool_number: Number(number)
    });

    if (error) throw error;
    return data || [];
  }

  async function submitCheckIn(studentIds) {
    const client = mustClient();
    const { error } = await client.rpc("submit_parent_check_in", {
      p_carpool_number: Number(state.number),
      p_student_ids: studentIds
    });
    if (error) throw error;
  }

  function updateStudentSelectionUi() {
    const selectedCount = state.selectedStudentIds.size;
    const submitBtn = el("students-submit");
    const summary = el("students-selection-summary");

    if (summary) {
      summary.textContent =
        selectedCount === 0
          ? "Tap one or more students, then submit."
          : selectedCount === 1
            ? "1 student selected"
            : `${selectedCount} students selected`;
    }

    if (submitBtn) {
      submitBtn.disabled = selectedCount === 0;
    }
  }

  function renderStudentButtons() {
    const container = el("students-buttons");
    const students = state.students;
    let html = "";

    if (students.length > 1) {
      html += `
        <div class="students-toolbar">
          <button type="button" class="btn btn-accent" data-select="all">Select all</button>
          <button type="button" class="btn btn-secondary" data-select="clear">Clear</button>
        </div>
      `;
    }

    students.forEach((s) => {
      const studentId = String(s.student_id);
      const selected = state.selectedStudentIds.has(studentId);
      html += `
        <button
          type="button"
          class="btn btn-primary student-pick${selected ? " selected" : ""}"
          data-student="${escapeHtml(studentId)}"
          aria-pressed="${selected ? "true" : "false"}"
        >
          <span>${escapeHtml(`${s.first_name} ${s.last_name}`)}</span>
        </button>
      `;
    });

    html += `
      <p id="students-selection-summary" class="students-selection-summary"></p>
      <button type="button" id="students-submit" class="btn btn-maroon students-submit">Check In Selected Students</button>
    `;

    container.innerHTML = html;

    container.querySelectorAll("[data-student]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const studentId = String(btn.dataset.student);
        if (state.selectedStudentIds.has(studentId)) {
          state.selectedStudentIds.delete(studentId);
        } else {
          state.selectedStudentIds.add(studentId);
        }

        renderStudentButtons();
      });
    });

    container.querySelector('[data-select="all"]')?.addEventListener("click", () => {
      state.selectedStudentIds = new Set(students.map((s) => String(s.student_id)));
      renderStudentButtons();
    });

    container.querySelector('[data-select="clear"]')?.addEventListener("click", () => {
      state.selectedStudentIds.clear();
      renderStudentButtons();
    });

    el("students-submit").addEventListener("click", async () => {
      const selectedIds = Array.from(state.selectedStudentIds);
      if (!selectedIds.length) {
        showError("students-error", "Choose at least one student.");
        return;
      }

      show("students-error", false);
      el("students-submit").disabled = true;

      try {
        await submitCheckIn(selectedIds);

        const picked = students
          .filter((student) => state.selectedStudentIds.has(String(student.student_id)))
          .map((student) => `${student.first_name} ${student.last_name}`);

        el("done-message").textContent = `Done! ${picked.join(", ")} called.`;
        state.selectedStudentIds.clear();
        hideAllSections();
        show("done-section", true);
      } catch (error) {
        showError("students-error", "Unable to check in right now. Please try again.");
      } finally {
        updateStudentSelectionUi();
      }
    });

    updateStudentSelectionUi();
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
      const students = await loadStudents(state.number);
      if (!students.length) {
        showError("number-error", "Carpool number not found. Please check your number.");
        return;
      }

      localStorage.setItem(STORAGE_KEY, String(state.number));
      state.students = students;
      state.selectedStudentIds = new Set();

      hideAllSections();
      show("students-section", true);
      renderStudentButtons();
    } catch (error) {
      showError("number-error", "Unable to connect. Please check your connection and try again.");
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
