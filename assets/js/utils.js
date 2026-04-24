(function initUtils() {
  function mustClient() {
    if (!window.carpoolClient) {
      throw new Error("Supabase client is not configured. Update assets/js/config.js first.");
    }
    return window.carpoolClient;
  }

  function schoolTodayISO() {
    const tz = (window.CARPOOL_CONFIG && window.CARPOOL_CONFIG.schoolTimezone) || "America/New_York";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const year = parts.find((x) => x.type === "year").value;
    const month = parts.find((x) => x.type === "month").value;
    const day = parts.find((x) => x.type === "day").value;
    return `${year}-${month}-${day}`;
  }

  async function fetchSchoolToday() {
    const client = mustClient();
    const { data, error } = await client.rpc("school_today");
    if (error || !data) {
      return schoolTodayISO();
    }
    return data;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function show(id, visible) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("hidden", !visible);
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  const CARPOOL_WEEKDAYS = [
    { key: "sunday", label: "Sunday", short: "Sun" },
    { key: "monday", label: "Monday", short: "Mon" },
    { key: "tuesday", label: "Tuesday", short: "Tue" },
    { key: "wednesday", label: "Wednesday", short: "Wed" },
    { key: "thursday", label: "Thursday", short: "Thu" },
    { key: "friday", label: "Friday", short: "Fri" }
  ];

  function normalizeWeekdays(values) {
    const submitted = new Set((values || []).map((value) => normalizeText(value)));
    return CARPOOL_WEEKDAYS
      .map((day) => day.key)
      .filter((key) => submitted.has(key));
  }

  function weekdayLabel(key, useShort) {
    const day = CARPOOL_WEEKDAYS.find((entry) => entry.key === normalizeText(key));
    if (!day) return "";
    return useShort ? day.short : day.label;
  }

  function formatWeekdays(values, useShort) {
    const days = normalizeWeekdays(values).map((key) => weekdayLabel(key, useShort));
    return days.length ? days.join(", ") : "No days selected";
  }

  function weekdayKeyForISO(value) {
    const [year, month, day] = String(value || "").split("-").map(Number);
    if (!year || !month || !day) return "";
    const weekday = new Date(year, month - 1, day).getDay();
    return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][weekday] || "";
  }

  function schoolTodayWeekday() {
    return weekdayKeyForISO(schoolTodayISO());
  }

  function cleanedText(value) {
    const text = String(value || "").trim();
    return text ? text : "";
  }

  function buildPersonName(firstName, lastName) {
    return [cleanedText(firstName), cleanedText(lastName)].filter(Boolean).join(" ");
  }

  function familyDisplayName(family) {
    const direct = cleanedText(family?.display_name);
    if (direct) return direct;

    const parentOne = buildPersonName(family?.parent_one_first_name, family?.parent_one_last_name);
    const parentTwo = buildPersonName(family?.parent_two_first_name, family?.parent_two_last_name);

    if (parentOne && parentTwo) return `${parentOne} & ${parentTwo}`;
    if (parentOne) return parentOne;
    if (parentTwo) return parentTwo;

    const legacy = cleanedText(family?.parent_names);
    return legacy || "Family";
  }

  function familySearchText(family) {
    return normalizeText([
      familyDisplayName(family),
      family?.parent_names,
      family?.parent_one_title,
      family?.parent_one_first_name,
      family?.parent_one_last_name,
      family?.parent_two_title,
      family?.parent_two_first_name,
      family?.parent_two_last_name
    ].filter(Boolean).join(" "));
  }

  function csvToArrays(csvText) {
    const rows = [];
    let row = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i += 1) {
      const char = csvText[i];
      const next = csvText[i + 1];

      if (char === '"' && inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        row.push(current.trim());
        current = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(current.trim());
        current = "";
        if (row.some((cell) => cell.length > 0)) rows.push(row);
        row = [];
      } else {
        current += char;
      }
    }

    if (current.length > 0 || row.length > 0) {
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
    }

    return rows;
  }

  function csvToRows(csvText) {
    const rows = csvToArrays(csvText);
    if (!rows.length) return [];

    const headers = rows[0].map((h) => cleanedText(h));
    return rows.slice(1).map((vals, idx) => {
      const obj = { __row_number: idx + 2 };
      headers.forEach((h, i) => {
        obj[h] = vals[i] || "";
      });
      return obj;
    });
  }

  async function requireAuth(role) {
    const client = mustClient();
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    const session = data.session;
    if (!session) return { ok: false, reason: "no_session" };

    if (!role) return { ok: true, session };

    const { data: profile, error: profileError } = await client
      .from("app_users")
      .select("role")
      .eq("id", session.user.id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile || (profile.role !== role && profile.role !== "admin")) {
      return { ok: false, reason: "insufficient_role", session };
    }

    return { ok: true, session, profile };
  }

  window.carpoolUtils = {
    mustClient,
    schoolTodayISO,
    fetchSchoolToday,
    setText,
    show,
    escapeHtml,
    normalizeText,
    CARPOOL_WEEKDAYS,
    normalizeWeekdays,
    weekdayLabel,
    formatWeekdays,
    weekdayKeyForISO,
    schoolTodayWeekday,
    familyDisplayName,
    familySearchText,
    csvToArrays,
    csvToRows,
    requireAuth
  };
})();
