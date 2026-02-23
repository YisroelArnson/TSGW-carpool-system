(function parentPage() {
  const { mustClient, show, escapeHtml } = window.carpoolUtils || {};
  if (!mustClient) return;

  const STORAGE_KEY = "tsgw_carpool_number";
  const state = {
    number: null,
    students: []
  };

  function el(id) {
    return document.getElementById(id);
  }

  function hideAllSections() {
    ["cached-section", "number-section", "students-section", "done-section"].forEach((id) => show(id, false));
  }

  function showNumberStep(clearError) {
    hideAllSections();
    show("number-section", true);
    show("students-error", false);
    if (clearError) {
      show("number-error", false);
      el("number-error").textContent = "";
    }
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

  function renderStudentButtons() {
    const container = el("students-buttons");
    const students = state.students;
    const fullNames = students.map((s) => `${s.first_name} ${s.last_name}`);

    let html = "";
    if (students.length > 1) {
      html += `<button class="btn btn-accent" data-student="all">All</button>`;
    }

    students.forEach((s) => {
      html += `<button class="btn btn-primary" data-student="${escapeHtml(s.student_id)}">${escapeHtml(
        `${s.first_name} ${s.last_name}`
      )}</button>`;
    });

    container.innerHTML = html;

    container.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        show("students-error", false);
        btn.disabled = true;
        try {
          const target = btn.dataset.student;
          const ids = target === "all" ? students.map((s) => s.student_id) : [target];
          await submitCheckIn(ids);

          const picked = target === "all" ? fullNames : [fullNames[students.findIndex((s) => s.student_id === target)]];
          el("done-message").textContent = `Done! ${picked.join(", ")} called.`;
          hideAllSections();
          show("done-section", true);
        } catch (error) {
          showError("students-error", "Unable to check in right now. Please try again.");
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async function continueWithNumber(number) {
    show("number-error", false);
    show("students-error", false);

    if (!number) {
      showError("number-error", "Please enter your carpool number.");
      return;
    }

    state.number = Number(number);

    try {
      const students = await loadStudents(state.number);
      if (!students.length) {
        showError("number-error", "Carpool number not found. Please check your number.");
        return;
      }

      localStorage.setItem(STORAGE_KEY, String(state.number));
      state.students = students;

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
      showNumberStep(true);
    });

    el("done-btn").addEventListener("click", () => {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        state.number = Number(cached);
        el("cached-label").textContent = `Welcome back! Use carpool #${cached}?`;
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
      el("cached-label").textContent = `Welcome back! Use carpool #${cached}?`;
      hideAllSections();
      show("cached-section", true);
    } else {
      showNumberStep(true);
    }
  }

  init();
})();
