(function adminPage() {
  const {
    mustClient,
    show,
    requireAuth,
    csvToArrays,
    escapeHtml,
    schoolTodayISO,
    fetchSchoolToday,
    familyDisplayName,
    normalizeText,
    attendanceBadgeHtml,
    attendanceStatusLabel,
    CARPOOL_WEEKDAYS,
    normalizeWeekdays,
    formatWeekdays
  } = window.carpoolUtils || {};
  if (!mustClient) return;

  const PERMANENT_END_DATE = "9999-12-31";
  const RECALL_ANALYTICS_DAYS = 30;
  const STUDENT_AUDIO_BUCKET = "student-call-audio";
  const STUDENT_AUDIO_MAX_MS = 10000;
  const METERS_PER_MILE = 1609.344;
  const STUDENT_BASE_SELECT = "id,first_name,last_name,class_id,family_id,classes(name),families(carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name)";
  const STUDENT_AUDIO_SELECT = "id,first_name,last_name,class_id,family_id,call_audio_path,call_audio_mime_type,call_audio_updated_at,classes(name),families(carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name)";
  const STUDENT_AUDIO_MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  const IMPORT_EDITABLE_FIELDS = [
    "carpool_number",
    "student_first_name",
    "student_last_name",
    "class_name",
    "parent_one_title",
    "parent_one_first_name",
    "parent_one_last_name",
    "parent_two_title",
    "parent_two_first_name",
    "parent_two_last_name",
    "notification_email",
    "notification_enabled"
  ];
  const REQUIRED_IMPORT_FIELDS = ["carpool_number", "student_first_name", "student_last_name", "class_name"];
  const IMPORT_HEADER_ALIASES = {
    lastname: "student_last_name",
    studentlastname: "student_last_name",
    firstname: "student_first_name",
    studentfirstname: "student_first_name",
    grade: "grade",
    class: "class_name",
    classname: "class_name",
    classgroup: "class_name",
    carpool: "carpool_number",
    carpoolnumber: "carpool_number",
    carpoolno: "carpool_number",
    carpoolnum: "carpool_number",
    carpoolid: "carpool_number",
    parentnames: "legacy_parent_names",
    parent1title: "parent_one_title",
    parent1firstname: "parent_one_first_name",
    parent1lastname: "parent_one_last_name",
    parent2title: "parent_two_title",
    parent2firstname: "parent_two_first_name",
    parent2lastname: "parent_two_last_name",
    notificationemail: "notification_email",
    familyemail: "notification_email",
    parentemail: "notification_email",
    email: "notification_email",
    notificationsenabled: "notification_enabled",
    notificationenabled: "notification_enabled",
    alerts: "notification_enabled",
    alertsenabled: "notification_enabled",
    student_first_name: "student_first_name",
    student_last_name: "student_last_name",
    class_name: "class_name",
    carpool_number: "carpool_number",
    parent_one_title: "parent_one_title",
    parent_one_first_name: "parent_one_first_name",
    parent_one_last_name: "parent_one_last_name",
    parent_two_title: "parent_two_title",
    parent_two_first_name: "parent_two_first_name",
    parent_two_last_name: "parent_two_last_name",
    notification_email: "notification_email",
    notification_enabled: "notification_enabled"
  };

  const state = {
    today: schoolTodayISO(),
    classes: [],
    families: [],
    students: [],
    dailyStatus: [],
    callEvents: [],
    callEventsAvailable: false,
    callEventsError: "",
    recallWindowStart: "",
    recallWindowEnd: "",
    recallRangeStart: "",
    recallRangeEnd: "",
    recallRangeMessage: "",
    pickupAuthorizations: [],
    pickupAuthorizationStudents: [],
    pickupAuthorizationAudit: [],
    carpoolPresets: [],
    carpoolPresetStudents: [],
    geofenceSettings: defaultGeofenceSettings(),
    geofenceSettingsError: "",
    geofenceSaving: false,
    geofenceLocating: false,
    currentTab: "today",
    channel: null,
    refreshTimer: null,
    todayAttemptSearch: "",
    todayGridWaitingOnly: false,
    todayGridFullscreen: false,
    todayGridFitTimer: null,
    importPreview: {
      fileName: "",
      rows: [],
      headerIssues: [],
      classOrderHints: [],
      parseError: "",
      resultHtml: "No import run in this session."
    },
    modal: {
      mode: null,
      entityId: null,
      isSaving: false,
      audio: emptyStudentAudioState()
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

  function emptyStudentAudioState() {
    return {
      recorder: null,
      stream: null,
      chunks: [],
      blob: null,
      mimeType: "",
      objectUrl: "",
      existingPath: "",
      existingMimeType: "",
      deleteRequested: false,
      isRecording: false,
      timer: null
    };
  }

  function el(id) {
    return document.getElementById(id);
  }

  function defaultGeofenceSettings() {
    return {
      is_enabled: false,
      is_configured: false,
      school_latitude: null,
      school_longitude: null,
      radius_meters: 300,
      updated_at: null
    };
  }

  function normalizeGeofenceSettings(settings) {
    return {
      ...defaultGeofenceSettings(),
      ...(settings || {}),
      school_latitude: settings?.school_latitude == null ? null : Number(settings.school_latitude),
      school_longitude: settings?.school_longitude == null ? null : Number(settings.school_longitude),
      radius_meters: Number(settings?.radius_meters || 300)
    };
  }

  function trimNumberText(value) {
    return String(value).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  function metersToMiles(meters) {
    return Number(meters || 0) / METERS_PER_MILE;
  }

  function milesToMeters(miles) {
    return Math.round(Number(miles || 0) * METERS_PER_MILE);
  }

  function formatMilesInput(meters) {
    return trimNumberText(metersToMiles(meters).toFixed(2));
  }

  function formatMiles(value) {
    return `${trimNumberText(Number(value || 0).toFixed(2))} mi`;
  }

  function setNodeMessage(nodeId, text, klass) {
    const node = el(nodeId);
    if (!node) return;
    node.className = klass || "";
    node.textContent = text;
    show(nodeId, Boolean(text));
  }

  function familyLabel(family) {
    return `#${family.carpool_number} - ${familyDisplayName(family)}`;
  }

  function classLabel(cls) {
    return cls.name;
  }

  function studentLabel(student) {
    return `${student.last_name}, ${student.first_name}`;
  }

  function weekdayCheckboxesHtml(selectedDays) {
    const selected = new Set(normalizeWeekdays(selectedDays || []));
    return (CARPOOL_WEEKDAYS || []).map((day) => {
      const checked = selected.has(day.key) ? "checked" : "";
      return `<label class="checkbox-option">
        <input type="checkbox" data-preset-weekday value="${escapeHtml(day.key)}" ${checked} />
        <span class="checkbox-option-row">
          <span class="checkbox-option-main">
            <span class="checkbox-option-toggle" aria-hidden="true"></span>
            <span class="checkbox-option-copy">
              <span class="checkbox-option-name">${escapeHtml(day.label)}</span>
              <span class="checkbox-option-meta">${escapeHtml(day.short)}</span>
            </span>
          </span>
        </span>
      </label>`;
    }).join("");
  }

  async function currentActorLabel(client, fallback) {
    try {
      const { data } = await client.auth.getUser();
      return data?.user?.email || fallback;
    } catch (error) {
      return fallback;
    }
  }

  async function fetchGeofenceSettings(client) {
    const { data, error } = await client.rpc("get_pickup_geofence_settings");
    if (error) throw error;
    return normalizeGeofenceSettings(data);
  }

  async function updateGeofenceSettings(payload) {
    const client = mustClient();
    const { data, error } = await client.rpc("update_pickup_geofence_settings", {
      p_is_enabled: payload.is_enabled,
      p_school_latitude: payload.school_latitude,
      p_school_longitude: payload.school_longitude,
      p_radius_meters: payload.radius_meters
    });
    if (error) throw error;
    return normalizeGeofenceSettings(data);
  }

  function checkInSourceLabel(record) {
    const source = record?.called_by || "";
    const actor = record?.checked_in_by || "";
    const sourceLabel = source ? source.charAt(0).toUpperCase() + source.slice(1) : "";
    if (!source && !actor) return "-";
    if (!actor || actor.toLowerCase() === source.toLowerCase()) return sourceLabel || actor;
    if (!source) return actor;
    return `${sourceLabel}: ${actor}`;
  }

  function cleanValue(value) {
    return String(value || "").trim();
  }

  function importKey(value) {
    return cleanValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function normalizedClassName(value) {
    return cleanValue(value).replace(/\s+/g, " ");
  }

  function canonicalCarpool(value) {
    const text = cleanValue(value);
    return /^\d+$/.test(text) ? String(Number(text)) : text;
  }

  function normalizedStudentName(value) {
    return normalizeText(value);
  }

  function personDisplayName(firstName, lastName) {
    return [cleanValue(firstName), cleanValue(lastName)].filter(Boolean).join(" ");
  }

  function familyNamePayload(prefix, data) {
    return {
      [`${prefix}_title`]: cleanValue(data?.[`${prefix}_title`]) || null,
      [`${prefix}_first_name`]: cleanValue(data?.[`${prefix}_first_name`]) || null,
      [`${prefix}_last_name`]: cleanValue(data?.[`${prefix}_last_name`]) || null
    };
  }

  function notificationEnabledFromValue(value, defaultValue = true) {
    if (typeof value === "boolean") return value;
    const text = cleanValue(value).toLowerCase();
    if (!text) return defaultValue;
    if (["false", "no", "n", "0", "off", "disabled"].includes(text)) return false;
    return true;
  }

  function familyPayloadFromValues(values, options = {}) {
    const includeNotification = options.includeNotification !== false;
    const payload = {
      carpool_number: Number(values.carpool_number),
      ...familyNamePayload("parent_one", values),
      ...familyNamePayload("parent_two", values),
      contact_info: cleanValue(values.contact_info) || null
    };

    if (includeNotification) {
      payload.notification_email = cleanValue(values.notification_email) || null;
      payload.notification_enabled = notificationEnabledFromValue(values.notification_enabled, true);
    }

    return payload;
  }

  function sameFamilyData(a, b) {
    const fields = [
      "parent_one_title",
      "parent_one_first_name",
      "parent_one_last_name",
      "parent_two_title",
      "parent_two_first_name",
      "parent_two_last_name"
    ];
    if (Object.prototype.hasOwnProperty.call(b || {}, "notification_email")) fields.push("notification_email");
    if (Object.prototype.hasOwnProperty.call(b || {}, "notification_enabled")) fields.push("notification_enabled");
    return fields.every((field) => {
      if (field === "notification_enabled") {
        return notificationEnabledFromValue(a?.[field], true) === notificationEnabledFromValue(b?.[field], true);
      }
      return cleanValue(a?.[field]) === cleanValue(b?.[field]);
    });
  }

  function legacyParentParts(value) {
    const pieces = String(value || "")
      .split(/\s*(?:&|\/| and )\s*/i)
      .map((part) => cleanValue(part))
      .filter(Boolean)
      .slice(0, 2);

    return pieces.map((piece) => {
      const words = piece.split(/\s+/).filter(Boolean);
      if (words.length <= 1) {
        return { first: piece, last: "" };
      }
      return {
        first: words.slice(0, -1).join(" "),
        last: words.slice(-1).join("")
      };
    });
  }

  function applyLegacyParentNames(row) {
    if (!cleanValue(row.legacy_parent_names)) return row;
    const [one, two] = legacyParentParts(row.legacy_parent_names);
    if (one) {
      row.parent_one_first_name = row.parent_one_first_name || one.first;
      row.parent_one_last_name = row.parent_one_last_name || one.last;
    }
    if (two) {
      row.parent_two_first_name = row.parent_two_first_name || two.first;
      row.parent_two_last_name = row.parent_two_last_name || two.last;
    }
    return row;
  }

  function canonicalImportRow(sourceRowNumber, values) {
    const row = {
      row_number: sourceRowNumber,
      skipped: false,
      errors: [],
      planned_action: "",
      carpool_number: cleanValue(values.carpool_number),
      student_first_name: cleanValue(values.student_first_name),
      student_last_name: cleanValue(values.student_last_name),
      class_name: cleanValue(values.class_name),
      grade: cleanValue(values.grade),
      parent_one_title: cleanValue(values.parent_one_title),
      parent_one_first_name: cleanValue(values.parent_one_first_name),
      parent_one_last_name: cleanValue(values.parent_one_last_name),
      parent_two_title: cleanValue(values.parent_two_title),
      parent_two_first_name: cleanValue(values.parent_two_first_name),
      parent_two_last_name: cleanValue(values.parent_two_last_name),
      notification_email: cleanValue(values.notification_email),
      notification_enabled: cleanValue(values.notification_enabled),
      legacy_parent_names: cleanValue(values.legacy_parent_names)
    };
    return applyLegacyParentNames(row);
  }

  function expectedHeader(field) {
    return field.replaceAll("_", " ");
  }

  function familyFieldsFromRow(row, options = {}) {
    const includeBlankNotification = Boolean(options.includeBlankNotification);
    const fields = {
      parent_one_title: row.parent_one_title,
      parent_one_first_name: row.parent_one_first_name,
      parent_one_last_name: row.parent_one_last_name,
      parent_two_title: row.parent_two_title,
      parent_two_first_name: row.parent_two_first_name,
      parent_two_last_name: row.parent_two_last_name
    };
    if (includeBlankNotification || cleanValue(row.notification_email)) {
      fields.notification_email = cleanValue(row.notification_email) || null;
    }
    if (includeBlankNotification || cleanValue(row.notification_enabled)) {
      fields.notification_enabled = notificationEnabledFromValue(row.notification_enabled, true);
    }
    return fields;
  }

  function hydrateFamily(family) {
    return {
      ...family,
      display_name: familyDisplayName(family)
    };
  }

  function hydrateStudent(student) {
    const family = student.families ? hydrateFamily(student.families) : null;
    return {
      ...student,
      families: family
    };
  }

  function baseAudioMimeType(mimeType) {
    return String(mimeType || "").split(";")[0].trim().toLowerCase() || "audio/webm";
  }

  function preferredRecordingMimeType() {
    if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== "function") return "";
    return STUDENT_AUDIO_MIME_CANDIDATES.find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType)) || "";
  }

  function audioExtensionForMime(mimeType) {
    const baseType = baseAudioMimeType(mimeType);
    if (baseType === "audio/mp4") return "m4a";
    if (baseType === "audio/mpeg") return "mp3";
    if (baseType === "audio/wav") return "wav";
    if (baseType === "audio/ogg") return "ogg";
    return "webm";
  }

  function newStudentId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function studentAudioPublicUrl(path) {
    if (!path) return "";
    const { data } = mustClient().storage.from(STUDENT_AUDIO_BUCKET).getPublicUrl(path);
    return data?.publicUrl || "";
  }

  function revokeStudentAudioObjectUrl() {
    const audio = state.modal.audio;
    if (audio?.objectUrl) {
      URL.revokeObjectURL(audio.objectUrl);
      audio.objectUrl = "";
    }
  }

  function stopStudentAudioStream() {
    const audio = state.modal.audio;
    if (!audio?.stream) return;
    audio.stream.getTracks().forEach((track) => track.stop());
    audio.stream = null;
  }

  function clearStudentAudioTimer() {
    const audio = state.modal.audio;
    if (audio?.timer) {
      clearTimeout(audio.timer);
      audio.timer = null;
    }
  }

  function cleanupStudentAudioState() {
    const audio = state.modal.audio;
    if (!audio) {
      state.modal.audio = emptyStudentAudioState();
      return;
    }

    clearStudentAudioTimer();
    if (audio.recorder && audio.recorder.state !== "inactive") {
      audio.recorder.ondataavailable = null;
      audio.recorder.onstop = null;
      audio.recorder.onerror = null;
      try {
        audio.recorder.stop();
      } catch (error) {
        // Ignore cleanup errors while closing the modal.
      }
    }
    stopStudentAudioStream();
    revokeStudentAudioObjectUrl();
    state.modal.audio = emptyStudentAudioState();
  }

  function setStudentAudioStatus(message, klass) {
    const node = el("modal-student-audio-status");
    if (!node) return;
    node.className = ["student-audio-status", klass].filter(Boolean).join(" ");
    node.textContent = message;
  }

  function refreshStudentAudioUi(messageOverride, klass) {
    const audio = state.modal.audio;
    const recordBtn = el("modal-student-audio-record");
    const stopBtn = el("modal-student-audio-stop");
    const deleteBtn = el("modal-student-audio-delete");
    const preview = el("modal-student-audio-preview");
    const supportsRecording = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    const hasPendingRecording = Boolean(audio?.blob);
    const hasSavedRecording = Boolean(audio?.existingPath && !audio.deleteRequested);
    const previewUrl = hasPendingRecording ? audio.objectUrl : hasSavedRecording ? studentAudioPublicUrl(audio.existingPath) : "";

    if (recordBtn) {
      recordBtn.disabled = Boolean(audio?.isRecording) || !supportsRecording;
      recordBtn.textContent = hasPendingRecording || hasSavedRecording ? "Replace Recording" : "Record";
    }
    if (stopBtn) stopBtn.disabled = !audio?.isRecording;
    if (deleteBtn) deleteBtn.disabled = Boolean(audio?.isRecording) || (!hasPendingRecording && !hasSavedRecording);

    if (preview) {
      if (previewUrl) {
        if (preview.src !== previewUrl) {
          preview.src = previewUrl;
          preview.load();
        }
        preview.classList.remove("hidden");
      } else {
        preview.removeAttribute("src");
        preview.classList.add("hidden");
      }
    }

    if (messageOverride) {
      setStudentAudioStatus(messageOverride, klass);
    } else if (!supportsRecording) {
      setStudentAudioStatus("This browser cannot record audio.", "error");
    } else if (audio?.isRecording) {
      setStudentAudioStatus("Recording... stops automatically after 10 seconds.", "recording");
    } else if (hasPendingRecording) {
      setStudentAudioStatus("New recording ready. Save changes to use it.", "success");
    } else if (audio?.deleteRequested) {
      setStudentAudioStatus("Recording will be removed when you save.", "warning");
    } else if (hasSavedRecording) {
      setStudentAudioStatus("Recording saved for classroom calls.", "success");
    } else {
      setStudentAudioStatus("No recording saved. Classroom will use the spoken-name fallback.", "");
    }
  }

  function clearPendingStudentAudioRecording() {
    const audio = state.modal.audio;
    revokeStudentAudioObjectUrl();
    audio.blob = null;
    audio.mimeType = "";
    audio.chunks = [];
  }

  function stopStudentAudioRecording() {
    const audio = state.modal.audio;
    if (!audio?.recorder || !audio.isRecording) return;

    clearStudentAudioTimer();
    try {
      if (audio.recorder.state !== "inactive") audio.recorder.stop();
    } catch (error) {
      audio.isRecording = false;
      stopStudentAudioStream();
      refreshStudentAudioUi("Unable to finish this recording. Please try again.", "error");
    }
  }

  async function startStudentAudioRecording() {
    const audio = state.modal.audio;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      refreshStudentAudioUi("This browser cannot record audio.", "error");
      return;
    }
    if (audio.isRecording) return;

    clearPendingStudentAudioRecording();
    audio.deleteRequested = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorderMimeType = preferredRecordingMimeType();
      const recorder = recorderMimeType ? new MediaRecorder(stream, { mimeType: recorderMimeType }) : new MediaRecorder(stream);
      const baseMimeType = baseAudioMimeType(recorderMimeType || recorder.mimeType);

      audio.recorder = recorder;
      audio.stream = stream;
      audio.chunks = [];
      audio.mimeType = baseMimeType;
      audio.isRecording = true;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) audio.chunks.push(event.data);
      };
      recorder.onerror = () => {
        stopStudentAudioRecording();
        refreshStudentAudioUi("Recording failed. Please try again.", "error");
      };
      recorder.onstop = () => {
        clearStudentAudioTimer();
        stopStudentAudioStream();
        audio.recorder = null;
        audio.isRecording = false;

        const recordedBlob = audio.chunks.length ? new Blob(audio.chunks, { type: audio.mimeType || "audio/webm" }) : null;
        audio.chunks = [];
        if (!recordedBlob || recordedBlob.size === 0) {
          audio.blob = null;
          audio.mimeType = "";
          refreshStudentAudioUi("No audio was captured. Please try again.", "error");
          return;
        }

        audio.blob = recordedBlob;
        audio.objectUrl = URL.createObjectURL(recordedBlob);
        audio.deleteRequested = false;
        refreshStudentAudioUi();
      };

      recorder.start();
      audio.timer = window.setTimeout(stopStudentAudioRecording, STUDENT_AUDIO_MAX_MS);
      refreshStudentAudioUi();
    } catch (error) {
      stopStudentAudioStream();
      audio.recorder = null;
      audio.isRecording = false;
      refreshStudentAudioUi("Microphone access was denied or unavailable.", "error");
    }
  }

  function requestStudentAudioDelete() {
    const audio = state.modal.audio;
    clearPendingStudentAudioRecording();
    audio.deleteRequested = Boolean(audio.existingPath);
    refreshStudentAudioUi();
  }

  function bindStudentAudioUi(student) {
    cleanupStudentAudioState();
    state.modal.audio = {
      ...emptyStudentAudioState(),
      existingPath: student?.call_audio_path || "",
      existingMimeType: student?.call_audio_mime_type || ""
    };

    el("modal-student-audio-record")?.addEventListener("click", startStudentAudioRecording);
    el("modal-student-audio-stop")?.addEventListener("click", stopStudentAudioRecording);
    el("modal-student-audio-delete")?.addEventListener("click", requestStudentAudioDelete);
    refreshStudentAudioUi();
  }

  async function uploadStudentAudio(client, studentId, blob, mimeType) {
    const safeMimeType = baseAudioMimeType(mimeType || blob?.type);
    const path = `students/${studentId}/call-${newStudentId()}.${audioExtensionForMime(safeMimeType)}`;
    const { error } = await client.storage
      .from(STUDENT_AUDIO_BUCKET)
      .upload(path, blob, {
        cacheControl: "3600",
        contentType: safeMimeType,
        upsert: false
      });
    if (error) throw error;
    return {
      call_audio_path: path,
      call_audio_mime_type: safeMimeType,
      call_audio_updated_at: new Date().toISOString()
    };
  }

  async function removeStudentAudio(client, path) {
    if (!path) return;
    try {
      await client.storage.from(STUDENT_AUDIO_BUCKET).remove([path]);
    } catch (error) {
      console.warn("Unable to remove student audio", error);
    }
  }

  function editIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path>
    </svg>`;
  }

  function trashIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M19 6l-1 14H6L5 6"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
    </svg>`;
  }

  function bellIconSvg() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M15 17H9"></path>
      <path d="M10 21h4"></path>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"></path>
    </svg>`;
  }

  function editActionButton(datasetAttr, value, label) {
    return `<button class="icon-action-btn" type="button" ${datasetAttr}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
      ${editIconSvg()}
    </button>`;
  }

  function deleteActionButton(datasetAttr, value, label) {
    return `<button class="icon-action-btn danger" type="button" ${datasetAttr}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
      ${trashIconSvg()}
    </button>`;
  }

  function bellActionButton(datasetAttr, value, label) {
    return `<button class="icon-action-btn" type="button" ${datasetAttr}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">
      ${bellIconSvg()}
    </button>`;
  }

  function studentAudioPill(student) {
    const hasAudio = Boolean(student?.call_audio_path);
    const label = hasAudio ? "Recorded" : "Fallback";
    const title = hasAudio
      ? `Recording saved${student.call_audio_updated_at ? ` ${student.call_audio_updated_at}` : ""}`
      : "No custom recording saved";
    return `<span class="audio-status-pill ${hasAudio ? "has-audio" : "no-audio"}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  }

  function formatDateLabel(value) {
    if (!value || value === PERMANENT_END_DATE) return "Permanent";
    return value;
  }

  function offsetISODate(isoDate, dayOffset) {
    const [year, month, day] = String(isoDate || "").split("-").map(Number);
    if (!year || !month || !day) return schoolTodayISO();
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + dayOffset);
    return date.toISOString().slice(0, 10);
  }

  function defaultRecallWindowStartDate() {
    return offsetISODate(state.today, -(RECALL_ANALYTICS_DAYS - 1));
  }

  function ensureRecallDateRange() {
    if (!state.recallRangeEnd) state.recallRangeEnd = state.today;
    if (!state.recallRangeStart) state.recallRangeStart = defaultRecallWindowStartDate();
  }

  function minISODate(firstDate, secondDate) {
    return String(firstDate) <= String(secondDate) ? firstDate : secondDate;
  }

  function maxISODate(firstDate, secondDate) {
    return String(firstDate) >= String(secondDate) ? firstDate : secondDate;
  }

  function isCallEventsMissingError(error) {
    const message = String(error?.message || "").toLowerCase();
    return error?.code === "42P01"
      || message.includes("could not find the table")
      || (message.includes("student_call_events") && message.includes("does not exist"));
  }

  function attemptTypeLabel(record) {
    if (!record?.attempt_type) return record?.status || "";
    return record.attempt_type === "recall" ? "Recall" : "Initial";
  }

  function formatEventDateTime(value, dateValue) {
    if (!value) return "-";
    const time = formatAttemptTime(value);
    if (!dateValue || dateValue === state.today) return time;
    const date = new Date(`${dateValue}T00:00:00`);
    return `${date.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${time}`;
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

  function attendanceStatusForStudent(studentId) {
    return dailyStatusMap().get(studentId)?.attendance_status || "";
  }

  function attendanceBadgeForStatus(status) {
    return attendanceBadgeHtml ? attendanceBadgeHtml(status) : "";
  }

  function attendanceStatusText(status) {
    return attendanceStatusLabel ? attendanceStatusLabel(status) : "";
  }

  function attendanceActionButton(studentId, status, label, currentStatus) {
    const isClear = !status;
    const active = status && currentStatus === status;
    const disabled = isClear && !currentStatus;
    return `<button
      class="attendance-action-btn${active ? " active" : ""}"
      type="button"
      data-attendance-student="${escapeHtml(studentId)}"
      data-attendance-status="${escapeHtml(status)}"
      aria-pressed="${active ? "true" : "false"}"
      ${disabled ? "disabled" : ""}
    >${escapeHtml(label)}</button>`;
  }

  function attendanceControlsHtml(studentId) {
    const currentStatus = attendanceStatusForStudent(studentId);
    return `<div class="attendance-actions">
      ${attendanceActionButton(studentId, "ABSENT", "Absent", currentStatus)}
      ${attendanceActionButton(studentId, "LEFT_EARLY", "Left early", currentStatus)}
      ${attendanceActionButton(studentId, "", "Back", currentStatus)}
    </div>`;
  }

  function attendanceCellHtml(studentId) {
    const currentStatus = attendanceStatusForStudent(studentId);
    const badge = attendanceBadgeForStatus(currentStatus);
    return `<div class="attendance-cell">
      ${badge || '<span class="attendance-cell-empty">In school</span>'}
      ${attendanceControlsHtml(studentId)}
    </div>`;
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
      panel.style.removeProperty("--fit-panel-padding");
      return;
    }

    const rect = grid.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const count = cards.length;
    let best = { columns: 1, rows: count, cardWidth: width, cardHeight: height / count, score: 0 };

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
    panel.style.setProperty("--fit-panel-padding", `${Math.max(8, Math.min(16, best.gap * 1.25))}px`);
    grid.classList.add("is-fitting");
  }

  function scheduleTodayGridFit() {
    if (state.todayGridFitTimer) window.cancelAnimationFrame(state.todayGridFitTimer);
    state.todayGridFitTimer = window.requestAnimationFrame(() => {
      state.todayGridFitTimer = null;
      fitStudentGrid(el("today-student-grid-card"), el("today-student-grid"), ".all-students-card");
    });
  }

  function setTodayGridFullscreen(enabled, options = {}) {
    const panel = el("today-student-grid-card");
    const button = el("today-grid-fullscreen-btn");
    if (!panel) return;

    state.todayGridFullscreen = enabled;
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
      scheduleTodayGridFit();
      window.setTimeout(scheduleTodayGridFit, 80);
      return;
    }

    if (!options.skipNative && document.fullscreenElement === panel && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    scheduleTodayGridFit();
  }

  async function setTodayStudentStatus(studentId, status) {
    const client = mustClient();
    const isCalled = status === "CALLED";
    const checkedInBy = isCalled ? await currentActorLabel(client, "Admin") : null;
    const payload = [{
      student_id: studentId,
      date: state.today,
      status,
      called_at: isCalled ? new Date().toISOString() : null,
      called_by: isCalled ? "admin" : null,
      checked_in_by: checkedInBy,
      pickup_family_id: null,
      pickup_family_label: null
    }];

    const { error } = await client.from("daily_status").upsert(payload, { onConflict: "student_id,date" });
    if (error) throw error;
    return checkedInBy;
  }

  function applyTodayStatusLocally(studentId, status, checkedInBy) {
    const isCalled = status === "CALLED";
    const nextRecord = {
      student_id: studentId,
      date: state.today,
      status,
      called_at: isCalled ? new Date().toISOString() : null,
      called_by: isCalled ? "admin" : null,
      checked_in_by: isCalled ? (checkedInBy || "Admin") : null,
      pickup_family_id: null,
      pickup_family_label: null
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
    const checkedInBy = await setTodayStudentStatus(studentId, nextStatus);
    applyTodayStatusLocally(studentId, nextStatus, checkedInBy);
    renderToday();
  }

  async function repingTodayStudent(studentId) {
    const checkedInBy = await setTodayStudentStatus(studentId, "CALLED");
    applyTodayStatusLocally(studentId, "CALLED", checkedInBy);
    renderToday();
  }

  function applyDailyStatusRecordLocally(record) {
    if (!record?.student_id) return;
    const existingIndex = state.dailyStatus.findIndex((row) => row.student_id === record.student_id && row.date === record.date);
    if (existingIndex >= 0) {
      state.dailyStatus[existingIndex] = {
        ...state.dailyStatus[existingIndex],
        ...record
      };
    } else {
      state.dailyStatus.unshift(record);
    }
  }

  async function setStudentAttendanceStatus(studentId, attendanceStatus) {
    const client = mustClient();
    const actor = await currentActorLabel(client, "Admin");
    const { data, error } = await client.rpc("set_student_attendance_status", {
      p_student_id: studentId,
      p_attendance_status: attendanceStatus || null,
      p_actor: actor
    });
    if (error) throw error;
    applyDailyStatusRecordLocally(data);
    renderToday();
  }

  function formatAttemptTime(value) {
    return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
  }

  function todayCallEvents() {
    return state.callEvents.filter((event) => event.date === state.today);
  }

  function analyticsCallEvents() {
    ensureRecallDateRange();
    return state.callEvents.filter((event) =>
      event.date >= state.recallRangeStart && event.date <= state.recallRangeEnd
    );
  }

  function pickupFamilyLabel(record) {
    if (!record?.pickup_family_id) return record?.pickup_family_label || "";
    const family = state.families.find((entry) => entry.id === record.pickup_family_id);
    return family ? familyLabel(family) : (record.pickup_family_label || "");
  }

  function recentAttemptRows() {
    const byId = new Map(state.students.map((s) => [s.id, s]));
    if (state.callEventsAvailable) {
      return todayCallEvents().map((rec) => ({
        rec,
        stu: byId.get(rec.student_id),
        isEvent: true
      }));
    }

    return state.dailyStatus.map((rec) => ({
      rec,
      stu: byId.get(rec.student_id),
      isEvent: false
    }));
  }

  function attemptRowTime(row) {
    return row.isEvent ? row.rec.attempted_at : row.rec.called_at;
  }

  function attemptRowType(row) {
    return row.isEvent ? attemptTypeLabel(row.rec) : (row.rec.status || "");
  }

  function attemptRowClass(row) {
    if (row.isEvent) {
      return row.rec.attempt_type === "recall" ? "status status-recall" : "status status-initial";
    }
    return row.rec.status === "CALLED" ? "status status-called" : "status status-waiting";
  }

  function todayAttemptMatchesSearch(row) {
    const { rec, stu } = row;
    const query = normalizeText(state.todayAttemptSearch);
    if (!query) return true;

    const family = stu && stu.families ? stu.families : null;
    const haystack = normalizeText([
      formatAttemptTime(attemptRowTime(row)),
      stu ? studentLabel(stu) : "Unknown student",
      stu ? `${stu.first_name} ${stu.last_name}` : "",
      stu && stu.classes ? stu.classes.name : "",
      family ? familyDisplayName(family) : "",
      family ? family.carpool_number : "",
      attemptRowType(row),
      stu ? attendanceStatusText(dailyStatusMap().get(stu.id)?.attendance_status) : "",
      checkInSourceLabel(rec),
      pickupFamilyLabel(rec)
    ].join(" "));

    return query.split(" ").every((term) => haystack.includes(term));
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
      client
        .from("families")
        .select("id,carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,contact_info,notification_email,notification_enabled")
        .order("carpool_number", { ascending: true }),
      fetchAdminStudents(client),
      client
        .from("daily_status")
        .select("id,student_id,status,called_at,called_by,checked_in_by,pickup_family_id,pickup_family_label,date,attendance_status,attendance_marked_at,attendance_marked_by,attendance_cleared_at,attendance_cleared_by")
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

    const [callEventsRes, geofenceRes] = await Promise.all([
      fetchCallEvents(client),
      fetchGeofenceSettings(client)
        .then((data) => ({ data, errorMessage: "" }))
        .catch((error) => ({
          data: defaultGeofenceSettings(),
          errorMessage: error.message || "Unable to load pickup location settings."
        }))
    ]);

    state.classes = classesRes.data || [];
    state.families = (familiesRes.data || []).map(hydrateFamily);
    state.students = (studentsRes.data || []).map(hydrateStudent);
    state.dailyStatus = dailyStatusRes.data || [];
    state.callEvents = callEventsRes.data;
    state.callEventsAvailable = callEventsRes.available;
    state.callEventsError = callEventsRes.errorMessage;
    state.recallWindowStart = callEventsRes.startDate;
    state.recallWindowEnd = callEventsRes.endDate;
    state.pickupAuthorizations = pickupAuthRes.data || [];
    state.pickupAuthorizationStudents = pickupAuthStudentsRes.data || [];
    state.pickupAuthorizationAudit = pickupAuditRes.data || [];
    state.carpoolPresets = presetsRes.data || [];
    state.carpoolPresetStudents = presetStudentsRes.data || [];
    state.geofenceSettings = geofenceRes.data;
    state.geofenceSettingsError = geofenceRes.errorMessage;
  }

  async function fetchCallEvents(client) {
    ensureRecallDateRange();
    const startDate = state.recallRangeStart;
    const endDate = state.recallRangeEnd;
    const queryStartDate = minISODate(startDate, state.today);
    const queryEndDate = maxISODate(endDate, state.today);
    const { data, error } = await client
      .from("student_call_events")
      .select("id,daily_status_id,student_id,date,attempted_at,attempt_type,called_by,checked_in_by,pickup_family_id,pickup_family_label,previous_called_at,previous_called_by")
      .gte("date", queryStartDate)
      .lte("date", queryEndDate)
      .order("attempted_at", { ascending: false });

    if (!error) {
      return {
        data: data || [],
        available: true,
        errorMessage: "",
        startDate,
        endDate
      };
    }

    const message = isCallEventsMissingError(error)
      ? "Recall tracking migration has not been applied yet."
      : (error.message || "Recall tracking is unavailable.");
    console.warn("Unable to load recall events", error);
    return {
      data: [],
      available: false,
      errorMessage: message,
      startDate,
      endDate
    };
  }

  async function fetchAdminStudents(client) {
    const withAudio = await client
      .from("students")
      .select(STUDENT_AUDIO_SELECT)
      .order("last_name", { ascending: true });

    if (!withAudio.error || !String(withAudio.error.message || "").includes("call_audio")) {
      return withAudio;
    }

    return client
      .from("students")
      .select(STUDENT_BASE_SELECT)
      .order("last_name", { ascending: true });
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
      if (col === "parents") return familyDisplayName(f);
      if (col === "contact") return f.contact_info || "";
      if (col === "notification") return f.notification_email || "";
      if (col === "students") return (byFamily.get(f.id) || []).length;
      return 0;
    };
    const sorted = sortedBy(state.families, col, dir, valFn);

    const html = sorted
      .map((f) => {
        const students = byFamily.get(f.id) || [];
        return `<tr>
          <td>${escapeHtml(String(f.carpool_number))}</td>
          <td>${escapeHtml(familyDisplayName(f))}</td>
          <td>${escapeHtml(f.contact_info || "")}</td>
          <td>${escapeHtml(f.notification_enabled === false ? "Off" : (f.notification_email || "On, no email"))}</td>
          <td>${escapeHtml(students.join(", "))}</td>
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-family", f.id, "Edit family")}
              ${deleteActionButton("data-delete-family", f.id, "Delete family")}
            </div>
          </td>
        </tr>`;
      })
      .join("");

    el("families-tbody").innerHTML = html || '<tr><td colspan="6" class="muted">No families yet.</td></tr>';
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
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-class", c.id, "Edit class")}
              ${deleteActionButton("data-delete-class", c.id, "Delete class")}
            </div>
          </td>
        </tr>
        <tr class="class-detail-row hidden" data-detail-for="${escapeHtml(c.id)}">
          <td></td>
          <td colspan="4">
            <table class="detail-table">
              <thead><tr><th>Student</th><th>Family #</th></tr></thead>
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
      if (col === "family") return s.families ? familyDisplayName(s.families) : "";
      if (col === "carpool") return s.families ? s.families.carpool_number : 0;
      if (col === "audio") return s.call_audio_path ? 1 : 0;
      return "";
    };
    const sorted = sortedBy(state.students, col, dir, valFn);

    const html = sorted
      .map((s) => {
        return `<tr>
          <td>${escapeHtml(studentLabel(s))}</td>
          <td>${escapeHtml(s.classes ? s.classes.name : "")}</td>
          <td>${escapeHtml(s.families ? familyDisplayName(s.families) : "")}</td>
          <td>${escapeHtml(s.families ? String(s.families.carpool_number) : "")}</td>
          <td>${studentAudioPill(s)}</td>
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-student", s.id, "Edit student")}
              ${deleteActionButton("data-delete-student", s.id, "Delete student")}
            </div>
          </td>
        </tr>`;
      })
      .join("");

    el("students-tbody").innerHTML = html || '<tr><td colspan="6" class="muted">No students yet.</td></tr>';
    applySortHeaders("students-table", col, dir);
  }

  function renderToday() {
    const calledRows = state.dailyStatus.filter((s) => s.status === "CALLED");
    const todaysEvents = todayCallEvents();
    const parentRows = state.dailyStatus.filter((s) => (s.called_by || "").toLowerCase() === "parent");
    const parentAttemptCount = state.callEventsAvailable
      ? todaysEvents.filter((event) => (event.called_by || "").toLowerCase() === "parent").length
      : parentRows.length;
    const calledIds = new Set(calledRows.map((s) => s.student_id));
    const waiting = state.students.length - calledIds.size;

    el("today-attempts-count").textContent = String(state.callEventsAvailable ? todaysEvents.length : state.dailyStatus.length);
    el("today-dismissed-count").textContent = String(calledRows.length);
    el("today-waiting-count").textContent = String(Math.max(waiting, 0));
    el("today-parent-count").textContent = String(parentAttemptCount);

    const enriched = recentAttemptRows();
    const statusByStudent = dailyStatusMap();

    const { col, dir } = sortState.today;
    const valFn = (row) => {
      const { rec, stu } = row;
      if (col === "time") return attemptRowTime(row) || "";
      if (col === "student") return stu ? `${stu.last_name} ${stu.first_name}` : "";
      if (col === "class") return stu && stu.classes ? stu.classes.name : "";
      if (col === "family") return stu && stu.families ? familyDisplayName(stu.families) : "";
      if (col === "carpool") return stu && stu.families ? stu.families.carpool_number : 0;
      if (col === "status") return attemptRowType(row);
      if (col === "source") return checkInSourceLabel(rec);
      return "";
    };
    const visible = enriched.filter(todayAttemptMatchesSearch);
    const sorted = sortedBy(visible, col, dir, valFn);
    const visibleCount = el("today-attempts-visible-count");
    if (visibleCount) {
      const searchActive = Boolean(normalizeText(state.todayAttemptSearch));
      visibleCount.textContent = searchActive
        ? `${visible.length} of ${enriched.length} shown`
        : `${enriched.length} shown`;
    }

    const rows = sorted
      .map((row) => {
        const { rec, stu } = row;
        const time = formatAttemptTime(attemptRowTime(row));
        const statusClass = attemptRowClass(row);
        const status = attemptRowType(row);
        const currentStatus = stu ? statusByStudent.get(stu.id)?.status : "";
        const actionLabel = currentStatus === "CALLED" ? "Reping student" : "Call student";
        const toggleAttr = !row.isEvent && stu ? `data-today-student-id="${escapeHtml(stu.id)}"` : "";
        const toggleClass = !row.isEvent && stu ? " is-toggle" : "";
        return `<tr>
          <td>${escapeHtml(time)}</td>
          <td>${escapeHtml(stu ? studentLabel(stu) : "Unknown student")}</td>
          <td>${escapeHtml(stu && stu.classes ? stu.classes.name : "")}</td>
          <td>${escapeHtml(stu && stu.families ? familyDisplayName(stu.families) : "")}</td>
          <td>${escapeHtml(stu && stu.families ? String(stu.families.carpool_number) : "")}</td>
          <td><span class="${statusClass}${toggleClass}" ${toggleAttr}>${escapeHtml(status)}</span></td>
          <td>${stu ? attendanceCellHtml(stu.id) : "-"}</td>
          <td>${escapeHtml(checkInSourceLabel(rec))}</td>
          <td>${stu ? bellActionButton("data-reping-student", stu.id, actionLabel) : "-"}</td>
        </tr>`;
      })
      .join("");

    const emptyMessage = enriched.length
      ? "No attempts match your search."
      : (state.callEventsAvailable ? "No call attempts logged yet today." : "No dismissal attempts yet today.");
    el("today-attempts-tbody").innerHTML = rows || `<tr><td colspan="9" class="muted">${emptyMessage}</td></tr>`;
    applySortHeaders("today-table", col, dir);
    renderTodayStudentGrid();
  }

  function recallEventsInWindow() {
    return analyticsCallEvents().filter((event) => event.attempt_type === "recall");
  }

  function eventSortDescending(a, b) {
    return new Date(b.lastAt || b.attempted_at || 0).getTime() - new Date(a.lastAt || a.attempted_at || 0).getTime();
  }

  function recallFamilyRows() {
    const familyById = new Map(state.families.map((family) => [family.id, family]));
    const studentById = new Map(state.students.map((student) => [student.id, student]));
    const grouped = new Map();

    recallEventsInWindow().forEach((event) => {
      if (!event.pickup_family_id) return;
      const existing = grouped.get(event.pickup_family_id) || {
        family: familyById.get(event.pickup_family_id),
        fallbackLabel: event.pickup_family_label || "Unknown pickup family",
        count: 0,
        studentIds: new Set(),
        lastAt: "",
        lastDate: ""
      };
      existing.count += 1;
      existing.studentIds.add(event.student_id);
      if (!existing.lastAt || new Date(event.attempted_at) > new Date(existing.lastAt)) {
        existing.lastAt = event.attempted_at;
        existing.lastDate = event.date;
      }
      grouped.set(event.pickup_family_id, existing);
    });

    return Array.from(grouped.values())
      .map((row) => {
        const studentNames = Array.from(row.studentIds)
          .map((studentId) => studentById.get(studentId))
          .filter(Boolean)
          .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
          .map((student) => `${student.first_name} ${student.last_name}`);
        return {
          ...row,
          studentNames
        };
      })
      .sort((a, b) => b.count - a.count || eventSortDescending(a, b))
      .slice(0, 8);
  }

  function recallStudentRows() {
    const studentById = new Map(state.students.map((student) => [student.id, student]));
    const grouped = new Map();

    recallEventsInWindow().forEach((event) => {
      const existing = grouped.get(event.student_id) || {
        student: studentById.get(event.student_id),
        count: 0,
        lastAt: "",
        lastDate: ""
      };
      existing.count += 1;
      if (!existing.lastAt || new Date(event.attempted_at) > new Date(existing.lastAt)) {
        existing.lastAt = event.attempted_at;
        existing.lastDate = event.date;
      }
      grouped.set(event.student_id, existing);
    });

    return Array.from(grouped.values())
      .filter((row) => row.student)
      .sort((a, b) => b.count - a.count || eventSortDescending(a, b))
      .slice(0, 8);
  }

  function compactStudentList(names) {
    if (!names.length) return "-";
    const visible = names.slice(0, 3);
    const remaining = names.length - visible.length;
    return remaining > 0 ? `${visible.join(", ")} +${remaining}` : visible.join(", ");
  }

  function renderRecallAnalytics() {
    const warning = el("recall-tracking-warning");
    if (!warning) return;

    ensureRecallDateRange();
    const rangeStartInput = el("recall-start-date");
    const rangeEndInput = el("recall-end-date");
    if (rangeStartInput) rangeStartInput.value = state.recallRangeStart;
    if (rangeEndInput) rangeEndInput.value = state.recallRangeEnd;

    const todaysEvents = todayCallEvents();
    const todaysRecalls = todaysEvents.filter((event) => event.attempt_type === "recall");
    const windowEvents = analyticsCallEvents();
    const windowRecalls = recallEventsInWindow();
    const windowCallCount = windowEvents.length;
    const recallRate = windowCallCount ? Math.round((windowRecalls.length / windowCallCount) * 100) : 0;
    const familyRows = recallFamilyRows();
    const studentRows = recallStudentRows();
    const topFamily = familyRows[0];

    warning.textContent = state.recallRangeMessage || (state.callEventsAvailable ? "" : state.callEventsError);
    warning.classList.toggle("hidden", !warning.textContent);

    el("recall-window-label").textContent = state.callEventsAvailable
      ? `${state.recallWindowStart} to ${state.recallWindowEnd}`
      : "Recall tracking unavailable";
    el("recall-today-call-count").textContent = state.callEventsAvailable ? String(todaysEvents.length) : "-";
    el("recall-today-recall-count").textContent = state.callEventsAvailable ? String(todaysRecalls.length) : "-";
    el("recall-window-recall-count").textContent = state.callEventsAvailable ? String(windowRecalls.length) : "-";
    el("recall-rate").textContent = state.callEventsAvailable ? `${recallRate}%` : "-";
    el("recall-top-family").textContent = state.callEventsAvailable && topFamily
      ? `${topFamily.family ? familyLabel(topFamily.family) : topFamily.fallbackLabel} (${topFamily.count})`
      : "None";

    const familyRowsHtml = familyRows.map((row) => {
      const familyText = row.family ? familyLabel(row.family) : row.fallbackLabel;
      return `<tr>
        <td>${escapeHtml(familyText)}</td>
        <td>${escapeHtml(String(row.count))}</td>
        <td>${escapeHtml(compactStudentList(row.studentNames))}</td>
        <td>${escapeHtml(formatEventDateTime(row.lastAt, row.lastDate))}</td>
      </tr>`;
    }).join("");
    el("recall-families-tbody").innerHTML = familyRowsHtml
      || `<tr><td colspan="4" class="muted">${state.callEventsAvailable ? "No recalls logged in this window." : "Apply the recall tracking migration to populate this table."}</td></tr>`;

    const studentRowsHtml = studentRows.map((row) => {
      const student = row.student;
      const family = student?.families;
      return `<tr>
        <td>${escapeHtml(student ? `${student.last_name}, ${student.first_name}` : "Unknown student")}</td>
        <td>${escapeHtml(family ? familyDisplayName(family) : "")}</td>
        <td>${escapeHtml(student?.classes ? student.classes.name : "")}</td>
        <td>${escapeHtml(String(row.count))}</td>
        <td>${escapeHtml(formatEventDateTime(row.lastAt, row.lastDate))}</td>
      </tr>`;
    }).join("");
    el("recall-students-tbody").innerHTML = studentRowsHtml
      || `<tr><td colspan="5" class="muted">${state.callEventsAvailable ? "No students have recalls in this window." : "Apply the recall tracking migration to populate this table."}</td></tr>`;
  }

  async function applyRecallDateRange(event) {
    event?.preventDefault();
    const startDate = el("recall-start-date")?.value || "";
    const endDate = el("recall-end-date")?.value || "";

    if (!startDate || !endDate) {
      state.recallRangeMessage = "Choose both a start date and an end date.";
      renderRecallAnalytics();
      return;
    }

    if (startDate > endDate) {
      state.recallRangeMessage = "Start date must be before end date.";
      renderRecallAnalytics();
      return;
    }

    state.recallRangeStart = startDate;
    state.recallRangeEnd = endDate;
    state.recallRangeMessage = "";
    await refreshAndRender();
  }

  async function resetRecallDateRange() {
    state.recallRangeStart = defaultRecallWindowStartDate();
    state.recallRangeEnd = state.today;
    state.recallRangeMessage = "";
    await refreshAndRender();
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
    const visibleStudents = state.todayGridWaitingOnly
      ? students.filter((student) => {
        const rec = statusByStudent.get(student.id);
        return !rec || rec.status !== "CALLED";
      })
      : students;
    const count = el("today-student-grid-count");
    if (count) {
      count.textContent = state.todayGridWaitingOnly
        ? `${visibleStudents.length} waiting of ${students.length}`
        : `${students.length} students`;
    }

    const html = visibleStudents
      .map((student) => {
        const rec = statusByStudent.get(student.id);
        const status = rec ? rec.status : "WAITING";
        const attendanceStatus = rec?.attendance_status || "";
        const cardClass = status === "CALLED" ? "all-students-card called" : "all-students-card";
        const className = student.classes ? student.classes.name : "";
        return `<div class="${cardClass}" data-today-grid-student-id="${escapeHtml(student.id)}">
          <div class="all-students-name-line">
            <span class="all-students-name">${escapeHtml(student.first_name)} ${escapeHtml(student.last_name)}</span>
            <span class="all-students-meta">${escapeHtml(className)}</span>
          </div>
          ${attendanceBadgeForStatus(attendanceStatus)}
          ${attendanceControlsHtml(student.id)}
        </div>`;
      })
      .join("");

    el("today-student-grid").innerHTML = html || `<p class="muted">${state.todayGridWaitingOnly ? "Everyone has been called." : "No students yet."}</p>`;
    scheduleTodayGridFit();
  }

  function setGeofenceMessage(message, klass) {
    const node = el("geofence-settings-message");
    if (!node) return;
    node.className = `settings-message${klass ? ` ${klass}` : ""}`;
    node.textContent = message || "";
    show("geofence-settings-message", Boolean(message));
  }

  function renderGeofenceSettings() {
    const settings = state.geofenceSettings || defaultGeofenceSettings();
    const latitude = el("geofence-latitude");
    const longitude = el("geofence-longitude");
    const radius = el("geofence-radius-miles");
    const enabled = el("geofence-enabled");
    const save = el("geofence-save-btn");
    const current = el("geofence-use-current-btn");
    const summary = el("geofence-settings-summary");

    if (enabled) enabled.checked = Boolean(settings.is_enabled);
    if (latitude && document.activeElement !== latitude) {
      latitude.value = settings.school_latitude == null ? "" : Number(settings.school_latitude).toFixed(6);
    }
    if (longitude && document.activeElement !== longitude) {
      longitude.value = settings.school_longitude == null ? "" : Number(settings.school_longitude).toFixed(6);
    }
    if (radius && document.activeElement !== radius) {
      radius.value = formatMilesInput(settings.radius_meters || 300);
    }
    if (save) {
      save.disabled = state.geofenceSaving;
      save.textContent = state.geofenceSaving ? "Saving..." : "Save Location";
    }
    if (current) {
      current.disabled = state.geofenceLocating || state.geofenceSaving || !navigator.geolocation;
      current.textContent = state.geofenceLocating ? "Locating..." : "Use Current Location";
    }

    if (summary) {
      const status = settings.is_enabled ? "Auto call is enabled." : "Auto call is disabled.";
      const configured = settings.is_configured
        ? `School point: ${Number(settings.school_latitude).toFixed(6)}, ${Number(settings.school_longitude).toFixed(6)}.`
        : "School point is not configured.";
      const radiusText = `Radius: ${formatMiles(metersToMiles(settings.radius_meters || 300))}.`;
      const updated = settings.updated_at ? `Updated ${new Date(settings.updated_at).toLocaleString()}.` : "";
      summary.innerHTML = [status, configured, radiusText, updated].filter(Boolean).map(escapeHtml).join("<br>");
    }

    if (state.geofenceSettingsError) {
      setGeofenceMessage(state.geofenceSettingsError, "error");
    }
  }

  function geofenceNumberValue(id) {
    const value = el(id)?.value;
    if (value == null || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  async function saveGeofenceSettings(event) {
    event?.preventDefault();
    if (state.geofenceSaving) return;

    const isEnabled = Boolean(el("geofence-enabled")?.checked);
    const latitude = geofenceNumberValue("geofence-latitude");
    const longitude = geofenceNumberValue("geofence-longitude");
    const radiusMiles = geofenceNumberValue("geofence-radius-miles");

    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(radiusMiles)) {
      setGeofenceMessage("Enter valid numeric location settings.", "error");
      return;
    }
    if (latitude != null && (latitude < -90 || latitude > 90)) {
      setGeofenceMessage("Latitude must be between -90 and 90.", "error");
      return;
    }
    if (longitude != null && (longitude < -180 || longitude > 180)) {
      setGeofenceMessage("Longitude must be between -180 and 180.", "error");
      return;
    }
    if (isEnabled && (latitude == null || longitude == null)) {
      setGeofenceMessage("Latitude and longitude are required before enabling auto call.", "error");
      return;
    }

    const radiusMeters = milesToMeters(radiusMiles || metersToMiles(state.geofenceSettings?.radius_meters || 300));
    if (radiusMeters < 15 || radiusMeters > 5000) {
      setGeofenceMessage("Radius must be between 0.05 and 3 miles.", "error");
      return;
    }

    state.geofenceSaving = true;
    state.geofenceSettingsError = "";
    setGeofenceMessage("Saving pickup location...", "pending");
    renderGeofenceSettings();

    try {
      state.geofenceSettings = await updateGeofenceSettings({
        is_enabled: isEnabled,
        school_latitude: latitude,
        school_longitude: longitude,
        radius_meters: radiusMeters
      });
      setGeofenceMessage("Pickup location saved.", "success");
    } catch (error) {
      setGeofenceMessage(error.message || "Unable to save pickup location.", "error");
    } finally {
      state.geofenceSaving = false;
      renderGeofenceSettings();
    }
  }

  function useCurrentLocationForGeofence() {
    if (state.geofenceLocating || !navigator.geolocation) {
      setGeofenceMessage("This browser cannot provide a location.", "error");
      return;
    }

    state.geofenceLocating = true;
    setGeofenceMessage("Getting current location...", "pending");
    renderGeofenceSettings();

    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.geofenceLocating = false;
        const latitude = el("geofence-latitude");
        const longitude = el("geofence-longitude");
        const current = el("geofence-use-current-btn");
        if (latitude) latitude.value = Number(position.coords.latitude).toFixed(6);
        if (longitude) longitude.value = Number(position.coords.longitude).toFixed(6);
        if (current) {
          current.disabled = false;
          current.textContent = "Use Current Location";
        }
        setGeofenceMessage("Location filled. Save when ready.", "success");
      },
      (error) => {
        state.geofenceLocating = false;
        const current = el("geofence-use-current-btn");
        if (current) {
          current.disabled = false;
          current.textContent = "Use Current Location";
        }
        setGeofenceMessage(error.message || "Unable to get this device location.", "error");
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
  }

  function renderAll() {
    renderToday();
    renderRecallAnalytics();
    renderFamilies();
    renderClasses();
    renderStudents();
    renderPermissions();
    renderImportPreview();
    renderGeofenceSettings();
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
                ${editActionButton("data-edit-auth", auth.id, "Edit permission")}
                ${deleteActionButton("data-revoke-auth", auth.id, "Revoke permission")}
              </div>
            </td>`;

        return `<tr>
          <td>${escapeHtml(granting ? familyLabel(granting) : "Unknown")}</td>
          <td>${escapeHtml(receiving ? familyLabel(receiving) : "Unknown")}</td>
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
      if (presetsCol === "days") return formatWeekdays(preset.weekdays || []);
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
          <td>${escapeHtml(owner ? familyLabel(owner) : "Unknown")}</td>
          <td>${escapeHtml(preset.name || "")}</td>
          <td>${escapeHtml(formatWeekdays(preset.weekdays || [], true))}</td>
          <td>${escapeHtml(students || "No students")}</td>
          <td>
            <div class="permissions-actions">
              ${editActionButton("data-edit-preset", preset.id, "Edit saved carpool")}
              ${deleteActionButton("data-delete-preset", preset.id, "Delete saved carpool")}
            </div>
          </td>
        </tr>`;
      })
      .join("");

    el("presets-tbody").innerHTML = presetRows || '<tr><td colspan="5" class="muted">No saved carpools yet.</td></tr>';
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
          <td>${escapeHtml(granting ? familyLabel(granting) : "Unknown")}</td>
          <td>${escapeHtml(receiving ? familyLabel(receiving) : "Unknown")}</td>
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
      const familyText = sourceFamily ? familyLabel(sourceFamily) : "Unknown family";
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
          <label for="modal-family-number">Family #</label>
          <input id="modal-family-number" type="number" value="${escapeHtml(String(data?.carpool_number || ""))}" required />
        </div>
        <div class="form-row">
          <label for="modal-parent-one-title">Parent 1 Title</label>
          <input id="modal-parent-one-title" type="text" value="${escapeHtml(data?.parent_one_title || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-one-first">Parent 1 First Name</label>
          <input id="modal-parent-one-first" type="text" value="${escapeHtml(data?.parent_one_first_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-one-last">Parent 1 Last Name</label>
          <input id="modal-parent-one-last" type="text" value="${escapeHtml(data?.parent_one_last_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-two-title">Parent 2 Title</label>
          <input id="modal-parent-two-title" type="text" value="${escapeHtml(data?.parent_two_title || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-two-first">Parent 2 First Name</label>
          <input id="modal-parent-two-first" type="text" value="${escapeHtml(data?.parent_two_first_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-parent-two-last">Parent 2 Last Name</label>
          <input id="modal-parent-two-last" type="text" value="${escapeHtml(data?.parent_two_last_name || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-family-contact">Contact info (optional)</label>
          <input id="modal-family-contact" type="text" value="${escapeHtml(data?.contact_info || "")}" />
        </div>
        <div class="form-row">
          <label for="modal-family-notification-email">Alert email (optional)</label>
          <input id="modal-family-notification-email" type="email" value="${escapeHtml(data?.notification_email || "")}" />
        </div>
        <label class="modal-toggle" for="modal-family-notification-enabled">
          <input id="modal-family-notification-enabled" type="checkbox" ${data?.notification_enabled === false ? "" : "checked"} />
          <span>Send pickup permission email alerts</span>
        </label>
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
        <div class="form-row student-audio-section">
          <label>Call audio</label>
          <div class="student-audio-card">
            <div id="modal-student-audio-status" class="student-audio-status"></div>
            <audio id="modal-student-audio-preview" class="student-audio-preview hidden" controls></audio>
            <div class="student-audio-actions">
              <button id="modal-student-audio-record" class="btn-action maroon" type="button">Record</button>
              <button id="modal-student-audio-stop" class="btn-action ghost" type="button" disabled>Stop</button>
              <button id="modal-student-audio-delete" class="btn-action ghost" type="button" disabled>Delete</button>
            </div>
            <p class="student-audio-hint">Record up to 10 seconds. This plays after the classroom chime.</p>
          </div>
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
          <label>Days of the Week</label>
          <div class="checkbox-list weekday-checkbox-list">${weekdayCheckboxesHtml(data?.weekdays || [])}</div>
        </div>
        <div class="form-row">
          <label>Students</label>
          <div id="modal-preset-students" class="checkbox-list">${presetStudentPickerHtml(data?.owner_family_id || "", data?.student_ids || [])}</div>
        </div>
      `;
    }

    return "";
  }

  function bindModalSpecificUi(mode, data) {
    if (mode === "add-student" || mode === "edit-student") {
      bindStudentAudioUi(data || null);
    }

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
    state.modal.isSaving = false;

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
      modalData = null;
      body = modalFieldTemplate("student");
    } else if (mode === "edit-student") {
      const student = state.students.find((s) => s.id === entityId);
      if (!student) return;
      title = "Edit Student";
      submitLabel = "Save Changes";
      modalData = student;
      body = modalFieldTemplate("student", student);
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
        weekdays: preset.weekdays || [],
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

  function setModalSaving(isSaving) {
    const submit = el("admin-modal-submit");
    const cancel = el("admin-modal-cancel");
    const close = el("admin-modal-close");
    if (submit) submit.disabled = Boolean(isSaving);
    if (cancel) cancel.disabled = Boolean(isSaving);
    if (close) close.disabled = Boolean(isSaving);
  }

  function closeModal() {
    cleanupStudentAudioState();
    state.modal.mode = null;
    state.modal.entityId = null;
    state.modal.isSaving = false;
    setModalSaving(false);
    show("admin-modal", false);
  }

  async function saveFamily(isEdit) {
    const client = mustClient();
    const carpool = Number(el("modal-family-number").value);
    const contact = el("modal-family-contact").value.trim() || null;
    const payload = familyPayloadFromValues({
      carpool_number: carpool,
      contact_info: contact,
      notification_email: el("modal-family-notification-email").value,
      notification_enabled: el("modal-family-notification-enabled").checked,
      parent_one_title: el("modal-parent-one-title").value,
      parent_one_first_name: el("modal-parent-one-first").value,
      parent_one_last_name: el("modal-parent-one-last").value,
      parent_two_title: el("modal-parent-two-title").value,
      parent_two_first_name: el("modal-parent-two-first").value,
      parent_two_last_name: el("modal-parent-two-last").value
    });
    const hasAnyParentName = [
      payload.parent_one_first_name,
      payload.parent_one_last_name,
      payload.parent_two_first_name,
      payload.parent_two_last_name
    ].some(Boolean);

    if (!carpool || !hasAnyParentName) {
      setNodeMessage("admin-modal-msg", "Family number and at least one parent name are required.", "error");
      return;
    }

    const query = isEdit
      ? client.from("families").update(payload).eq("id", state.modal.entityId)
      : client.from("families").insert(payload);

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
    const audio = state.modal.audio || emptyStudentAudioState();

    if (!first || !last || !familyId || !classId) {
      setNodeMessage("admin-modal-msg", "All student fields are required.", "error");
      return;
    }

    if (audio.isRecording) {
      setNodeMessage("admin-modal-msg", "Stop the recording before saving.", "error");
      return;
    }

    const existingStudent = isEdit ? state.students.find((student) => student.id === state.modal.entityId) : null;
    const studentId = isEdit ? state.modal.entityId : newStudentId();
    let uploadedAudio = null;

    try {
      if (audio.blob) {
        uploadedAudio = await uploadStudentAudio(client, studentId, audio.blob, audio.mimeType);
      }
    } catch (error) {
      setNodeMessage("admin-modal-msg", error.message || "Unable to upload the student recording.", "error");
      return;
    }

    const payload = { first_name: first, last_name: last, family_id: familyId, class_id: classId };
    if (uploadedAudio) {
      Object.assign(payload, uploadedAudio);
    } else if (audio.deleteRequested) {
      Object.assign(payload, {
        call_audio_path: null,
        call_audio_mime_type: null,
        call_audio_updated_at: null
      });
    }

    const query = isEdit
      ? client.from("students").update(payload).eq("id", state.modal.entityId)
      : client.from("students").insert({ id: studentId, ...payload });

    const { error } = await query;
    if (error) {
      if (uploadedAudio) await removeStudentAudio(client, uploadedAudio.call_audio_path);
      setNodeMessage("admin-modal-msg", error.message, "error");
      return;
    }

    if (
      existingStudent?.call_audio_path &&
      (uploadedAudio || audio.deleteRequested) &&
      existingStudent.call_audio_path !== uploadedAudio?.call_audio_path
    ) {
      await removeStudentAudio(client, existingStudent.call_audio_path);
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
    const weekdays = normalizeWeekdays(Array.from(document.querySelectorAll("[data-preset-weekday]:checked")).map((input) => input.value));

    if (!ownerFamilyId || !name || !studentIds.length || !weekdays.length) {
      setNodeMessage("admin-modal-msg", "Choose an owner family, a name, at least one day, and at least one student.", "error");
      return;
    }

    const rpcName = isEdit ? "admin_update_carpool_preset" : "admin_create_carpool_preset";
    const params = isEdit
      ? {
          p_preset_id: state.modal.entityId,
          p_owner_family_id: ownerFamilyId,
          p_name: name,
          p_student_ids: studentIds,
          p_weekdays: weekdays
        }
      : {
          p_owner_family_id: ownerFamilyId,
          p_name: name,
          p_student_ids: studentIds,
          p_weekdays: weekdays
        };

    const { error } = await client.rpc(rpcName, params);
    if (error) {
      setNodeMessage("admin-modal-msg", error.message, "error");
      return;
    }

    await refreshAndRender();
    closeModal();
  }

  function parseClassOrderHints(rawRows, headerRowIndex) {
    if (headerRowIndex < 1) return [];
    const banner = cleanValue(rawRows[headerRowIndex - 1]?.[0]);
    if (!banner || !banner.includes("/")) return [];
    return banner.split("/").map((value) => normalizedClassName(value)).filter(Boolean);
  }

  function detectHeaderRow(rawRows) {
    let bestIndex = 0;
    let bestScore = -1;
    const maxRows = Math.min(rawRows.length, 10);
    for (let idx = 0; idx < maxRows; idx += 1) {
      const score = (rawRows[idx] || []).reduce((total, cell) => {
        const mapped = IMPORT_HEADER_ALIASES[importKey(cell)];
        return total + (mapped ? 1 : 0);
      }, 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }
    return bestIndex;
  }

  function normalizedRowsFromMatrix(rawRows) {
    if (!rawRows.length) return { rows: [], headerIssues: [], classOrderHints: [] };

    const headerRowIndex = detectHeaderRow(rawRows);
    const headerRow = rawRows[headerRowIndex] || [];
    const headerMap = new Map();

    headerRow.forEach((cell, index) => {
      const mapped = IMPORT_HEADER_ALIASES[importKey(cell)];
      if (mapped && !headerMap.has(mapped)) {
        headerMap.set(mapped, index);
      }
    });

    const headerIssues = REQUIRED_IMPORT_FIELDS
      .filter((field) => !headerMap.has(field))
      .map((field) => `Missing column in upload: ${expectedHeader(field)}. Added as editable blank cells in preview.`);

    const rows = rawRows
      .slice(headerRowIndex + 1)
      .map((cells, offset) => {
        const values = {};
        [...headerMap.keys(), ...REQUIRED_IMPORT_FIELDS].forEach((field) => {
          const sourceIndex = headerMap.get(field);
          values[field] = sourceIndex == null ? "" : cells[sourceIndex];
        });
        return canonicalImportRow(headerRowIndex + offset + 2, values);
      })
      .filter((row) => IMPORT_EDITABLE_FIELDS.some((field) => cleanValue(row[field])) || cleanValue(row.grade));

    return {
      rows,
      headerIssues,
      classOrderHints: parseClassOrderHints(rawRows, headerRowIndex)
    };
  }

  async function rawRowsFromFile(file) {
    const name = cleanValue(file?.name).toLowerCase();
    if (name.endsWith(".csv")) {
      return csvToArrays(await file.text());
    }

    if (!window.XLSX) {
      throw new Error("Excel parser is unavailable on this page.");
    }

    const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(firstSheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false
    });
  }

  function importSummaryCounts(rows) {
    const activeRows = rows.filter((row) => !row.skipped);
    return {
      total: rows.length,
      active: activeRows.length,
      skipped: rows.length - activeRows.length,
      invalid: activeRows.filter((row) => row.errors.length).length,
      ready: activeRows.filter((row) => !row.errors.length).length
    };
  }

  function recomputeImportPreview() {
    const rows = state.importPreview.rows;
    const existingClasses = new Map(state.classes.map((cls) => [normalizeText(cls.name), cls]));
    const existingFamilies = new Map(state.families.map((family) => [String(family.carpool_number), family]));
    const existingStudents = new Map();

    state.students.forEach((student) => {
      const key = `${student.family_id}::${normalizedStudentName(student.first_name)}::${normalizedStudentName(student.last_name)}`;
      const list = existingStudents.get(key) || [];
      list.push(student);
      existingStudents.set(key, list);
    });

    const familyConflicts = new Map();
    const familySnapshots = new Map();
    const batchStudentKeys = new Map();

    rows.forEach((row) => {
      row.errors = [];
      row.planned_action = "";
      if (row.skipped) return;

      REQUIRED_IMPORT_FIELDS.forEach((field) => {
        if (!cleanValue(row[field])) {
          row.errors.push(`${expectedHeader(field)} is required.`);
        }
      });

      const carpoolText = canonicalCarpool(row.carpool_number);
      if (carpoolText && !/^\d+$/.test(carpoolText)) {
        row.errors.push("Family number must be a whole number.");
      }

      const className = normalizedClassName(row.class_name);
      if (cleanValue(row.class_name) && !className) {
        row.errors.push("Class name is invalid.");
      }

      const carpoolKey = carpoolText;
      if (carpoolKey) {
        const snapshot = familyFieldsFromRow(row);
        const existingSnapshot = familySnapshots.get(carpoolKey);
        if (!existingSnapshot) {
          familySnapshots.set(carpoolKey, snapshot);
        } else if (!sameFamilyData(existingSnapshot, snapshot)) {
          familyConflicts.set(carpoolKey, true);
        }
      }

      const batchKey = `${carpoolText}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
      if (carpoolText && normalizedStudentName(row.student_first_name) && normalizedStudentName(row.student_last_name)) {
        const list = batchStudentKeys.get(batchKey) || [];
        list.push(row.row_number);
        batchStudentKeys.set(batchKey, list);
      }
    });

    rows.forEach((row) => {
      if (row.skipped) return;

      const carpoolText = canonicalCarpool(row.carpool_number);
      if (carpoolText && familyConflicts.get(carpoolText)) {
        row.errors.push("This import has conflicting parent data for the same family number.");
      }

      const batchKey = `${carpoolText}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
      if (batchStudentKeys.get(batchKey)?.length > 1) {
        row.errors.push("This student appears more than once in the current import batch.");
      }

      if (row.errors.length) {
        row.planned_action = "Fix row";
        return;
      }

      const actions = [];
      const classExists = existingClasses.has(normalizeText(row.class_name));
      if (!classExists) actions.push("Create class");

      const family = existingFamilies.get(carpoolText);
      if (!family) {
        actions.push("Create family");
      } else if (!sameFamilyData(family, familyFieldsFromRow(row))) {
        actions.push("Update family");
      }

      if (family) {
        const key = `${family.id}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
        const matches = existingStudents.get(key) || [];
        if (matches.length > 1) {
          row.errors.push("This student matches multiple existing students in the database.");
          row.planned_action = "Fix row";
          return;
        }
        if (!matches.length) {
          actions.push("Create student");
        } else if (matches[0].class_id !== existingClasses.get(normalizeText(row.class_name))?.id || matches[0].first_name !== row.student_first_name || matches[0].last_name !== row.student_last_name) {
          actions.push("Update student");
        } else if (!actions.length) {
          actions.push("No change");
        }
      } else {
        actions.push("Create student");
      }

      row.planned_action = actions.join(", ");
    });
  }

  function renderImportResultsHtml(result) {
    const lines = [
      `Students created: ${result.students_created}`,
      `Students updated: ${result.students_updated}`,
      `Families created: ${result.families_created}`,
      `Families updated: ${result.families_updated}`,
      `Classes created: ${result.classes_created}`,
      `Rows skipped: ${result.rows_skipped}`,
      `Rows failed: ${result.errors.length}`
    ];
    return `
      <p class="success">${escapeHtml(lines.join(" | "))}</p>
      ${result.errors.length ? `<ul>${result.errors.map((err) => `<li class="error">${escapeHtml(err)}</li>`).join("")}</ul>` : ""}
    `;
  }

  function renderImportPreview() {
    const emptyState = el("imports-empty-state");
    const reviewState = el("imports-review-state");
    const status = el("imports-status");
    const summary = el("imports-preview-summary");
    const tbody = el("imports-preview-tbody");
    const confirmBtn = el("imports-confirm-btn");
    if (!emptyState || !reviewState || !status || !summary || !tbody || !confirmBtn) return;

    const hasRows = state.importPreview.rows.length > 0;
    emptyState.classList.toggle("hidden", hasRows);
    reviewState.classList.toggle("hidden", !hasRows);

    if (!hasRows) {
      status.innerHTML = [
        state.importPreview.parseError ? `<p class="error">${escapeHtml(state.importPreview.parseError)}</p>` : "",
        state.importPreview.resultHtml || '<p class="muted">No import run in this session.</p>'
      ].join("");
      return;
    }

    const counts = importSummaryCounts(state.importPreview.rows);
    const issues = state.importPreview.headerIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("");
    status.innerHTML = `
      <p class="muted"><strong>${escapeHtml(state.importPreview.fileName)}</strong></p>
      <p class="muted">${escapeHtml(`${counts.ready} ready, ${counts.invalid} invalid, ${counts.skipped} skipped.`)}</p>
      ${issues ? `<ul class="import-issues">${issues}</ul>` : ""}
      ${state.importPreview.parseError ? `<p class="error">${escapeHtml(state.importPreview.parseError)}</p>` : ""}
      ${state.importPreview.resultHtml ? `<div class="import-result-copy">${state.importPreview.resultHtml}</div>` : ""}
    `;

    summary.textContent = `Review ${counts.total} row${counts.total === 1 ? "" : "s"} before importing.`;
    confirmBtn.disabled = counts.invalid > 0 || counts.ready === 0;

    tbody.innerHTML = state.importPreview.rows.map((row, index) => {
      const rowClass = row.skipped ? "import-row skipped" : row.errors.length ? "import-row invalid" : "import-row ready";
      const errorText = row.errors.length ? row.errors.join(" ") : row.skipped ? "Skipped" : "Ready";
      const editableCells = IMPORT_EDITABLE_FIELDS.map((field) => `
        <td>
          <input
            type="${field === "carpool_number" ? "number" : "text"}"
            class="import-cell-input"
            data-import-row="${escapeHtml(String(index))}"
            data-import-field="${escapeHtml(field)}"
            value="${escapeHtml(row[field] || "")}"
            ${row.skipped ? "disabled" : ""}
          />
        </td>
      `).join("");

      return `
        <tr class="${rowClass}">
          <td>
            <label class="import-keep-toggle">
              <input type="checkbox" data-import-skip="${escapeHtml(String(index))}" ${row.skipped ? "" : "checked"} />
              <span>${row.skipped ? "Skipped" : "Keep"}</span>
            </label>
          </td>
          <td>${escapeHtml(String(row.row_number))}</td>
          <td>${escapeHtml(row.planned_action || "Review")}</td>
          <td class="${row.errors.length ? "error" : row.skipped ? "muted" : "success"}">${escapeHtml(errorText)}</td>
          ${editableCells}
          <td>${escapeHtml(row.grade || "")}</td>
        </tr>
      `;
    }).join("");
  }

  function clearImportPreviewRows() {
    state.importPreview.rows = [];
    state.importPreview.headerIssues = [];
    state.importPreview.classOrderHints = [];
    state.importPreview.parseError = "";
    state.importPreview.fileName = "";
    renderImportPreview();
  }

  async function stageImportFile(file) {
    try {
      const rawRows = await rawRowsFromFile(file);
      if (!rawRows.length) throw new Error("The selected file is empty.");
      const normalized = normalizedRowsFromMatrix(rawRows);
      if (!normalized.rows.length) {
        throw new Error("No importable rows were found in this file.");
      }
      state.importPreview = {
        fileName: file.name,
        rows: normalized.rows,
        headerIssues: normalized.headerIssues,
        classOrderHints: normalized.classOrderHints,
        parseError: "",
        resultHtml: ""
      };
      recomputeImportPreview();
      renderImportPreview();
      setTab("imports");
    } catch (error) {
      state.importPreview = {
        ...state.importPreview,
        fileName: file?.name || "",
        rows: [],
        headerIssues: [],
        classOrderHints: [],
        parseError: error.message || "Unable to parse this file."
      };
      renderImportPreview();
      setTab("imports");
    }
  }

  function classDisplayOrderForName(name) {
    const hints = state.importPreview.classOrderHints || [];
    const hintIndex = hints.findIndex((hint) => normalizeText(hint) === normalizeText(name));
    if (hintIndex >= 0) return hintIndex + 1;
    return state.classes.length + 1;
  }

  async function confirmImportPreview() {
    recomputeImportPreview();
    renderImportPreview();

    const rows = state.importPreview.rows.filter((row) => !row.skipped && !row.errors.length);
    if (!rows.length) return;

    const client = mustClient();
    const results = {
      students_created: 0,
      students_updated: 0,
      families_created: 0,
      families_updated: 0,
      classes_created: 0,
      rows_skipped: state.importPreview.rows.filter((row) => row.skipped).length,
      errors: []
    };

    const classMap = new Map(state.classes.map((cls) => [normalizeText(cls.name), cls]));
    const familyMap = new Map(state.families.map((family) => [String(family.carpool_number), family]));
    const studentMap = new Map();
    state.students.forEach((student) => {
      const key = `${student.family_id}::${normalizedStudentName(student.first_name)}::${normalizedStudentName(student.last_name)}`;
      const list = studentMap.get(key) || [];
      list.push(student);
      studentMap.set(key, list);
    });

    for (const row of rows) {
      try {
        const classKey = normalizeText(row.class_name);
        let classRow = classMap.get(classKey);
        if (!classRow) {
          const classInsert = await client
            .from("classes")
            .insert({ name: normalizedClassName(row.class_name), display_order: classDisplayOrderForName(row.class_name) })
            .select("id,name,display_order")
            .single();
          if (classInsert.error) throw classInsert.error;
          classRow = classInsert.data;
          classMap.set(classKey, classRow);
          state.classes.push(classRow);
          results.classes_created += 1;
        }

        const familyKey = canonicalCarpool(row.carpool_number);
        let familyRow = familyMap.get(familyKey);
        const rowFamilyFields = familyFieldsFromRow(row);
        const rowIncludesNotifications =
          Object.prototype.hasOwnProperty.call(rowFamilyFields, "notification_email") ||
          Object.prototype.hasOwnProperty.call(rowFamilyFields, "notification_enabled");
        const familyPayload = familyPayloadFromValues({
          carpool_number: row.carpool_number,
          ...rowFamilyFields
        }, { includeNotification: rowIncludesNotifications });

        if (!familyRow) {
          const familyInsert = await client
            .from("families")
            .insert(familyPayload)
            .select("id,carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,contact_info,notification_email,notification_enabled")
            .single();
          if (familyInsert.error) throw familyInsert.error;
          familyRow = hydrateFamily(familyInsert.data);
          familyMap.set(familyKey, familyRow);
          state.families.push(familyRow);
          results.families_created += 1;
        } else if (!sameFamilyData(familyRow, rowFamilyFields)) {
          const familyUpdate = await client
            .from("families")
            .update(familyPayload)
            .eq("id", familyRow.id)
            .select("id,carpool_number,parent_names,parent_one_title,parent_one_first_name,parent_one_last_name,parent_two_title,parent_two_first_name,parent_two_last_name,contact_info,notification_email,notification_enabled")
            .single();
          if (familyUpdate.error) throw familyUpdate.error;
          familyRow = hydrateFamily(familyUpdate.data);
          familyMap.set(familyKey, familyRow);
          state.families = state.families.map((family) => family.id === familyRow.id ? familyRow : family);
          results.families_updated += 1;
        }

        const studentKey = `${familyRow.id}::${normalizedStudentName(row.student_first_name)}::${normalizedStudentName(row.student_last_name)}`;
        const matches = studentMap.get(studentKey) || [];
        if (matches.length > 1) {
          throw new Error("This student matches multiple existing students.");
        }

        if (!matches.length) {
          const studentInsert = await client
            .from("students")
            .insert({
              first_name: row.student_first_name,
              last_name: row.student_last_name,
              family_id: familyRow.id,
              class_id: classRow.id
            })
            .select(STUDENT_AUDIO_SELECT)
            .single();
          if (studentInsert.error) throw studentInsert.error;
          const newStudent = hydrateStudent(studentInsert.data);
          const list = studentMap.get(studentKey) || [];
          list.push(newStudent);
          studentMap.set(studentKey, list);
          state.students.push(newStudent);
          results.students_created += 1;
        } else {
          const existingStudent = matches[0];
          if (
            existingStudent.class_id !== classRow.id ||
            existingStudent.first_name !== row.student_first_name ||
            existingStudent.last_name !== row.student_last_name
          ) {
            const studentUpdate = await client
              .from("students")
              .update({
                first_name: row.student_first_name,
                last_name: row.student_last_name,
                class_id: classRow.id,
                family_id: familyRow.id
              })
              .eq("id", existingStudent.id)
              .select(STUDENT_AUDIO_SELECT)
              .single();
            if (studentUpdate.error) throw studentUpdate.error;
            const updatedStudent = hydrateStudent(studentUpdate.data);
            studentMap.set(studentKey, [updatedStudent]);
            state.students = state.students.map((student) => student.id === updatedStudent.id ? updatedStudent : student);
            results.students_updated += 1;
          }
        }
      } catch (error) {
        results.errors.push(`Row ${row.row_number}: ${error.message || "Import failed"}`);
      }
    }

    await refreshAndRender();
    state.importPreview.rows = [];
    state.importPreview.parseError = "";
    state.importPreview.headerIssues = [];
    state.importPreview.classOrderHints = [];
    state.importPreview.resultHtml = renderImportResultsHtml(results);
    renderImportPreview();
    setTab("imports");
  }

  async function handleModalSubmit(event) {
    event.preventDefault();
    if (state.modal.isSaving) return;

    const mode = state.modal.mode;
    state.modal.isSaving = true;
    setModalSaving(true);

    try {
      if (mode === "add-family") return await saveFamily(false);
      if (mode === "edit-family") return await saveFamily(true);
      if (mode === "add-class") return await saveClass(false);
      if (mode === "edit-class") return await saveClass(true);
      if (mode === "add-student") return await saveStudent(false);
      if (mode === "edit-student") return await saveStudent(true);
      if (mode === "add-permission") return await savePermission(false);
      if (mode === "edit-permission") return await savePermission(true);
      if (mode === "add-preset") return await savePreset(false);
      if (mode === "edit-preset") return await savePreset(true);
    } finally {
      state.modal.isSaving = false;
      setModalSaving(false);
    }
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
    const student = state.students.find((entry) => entry.id === id);
    const { error } = await client.from("students").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }

    await removeStudentAudio(client, student?.call_audio_path);
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
    el("recall-date-range-form")?.addEventListener("submit", applyRecallDateRange);
    el("recall-last-30-btn")?.addEventListener("click", resetRecallDateRange);
    el("open-csv-import").addEventListener("click", () => {
      setTab("imports");
      el("imports-file-input").click();
    });
    el("imports-browse-btn").addEventListener("click", () => el("imports-file-input").click());
    el("imports-file-input").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      await stageImportFile(file);
      event.target.value = "";
    });
    el("imports-cancel-btn").addEventListener("click", clearImportPreviewRows);
    el("imports-confirm-btn").addEventListener("click", confirmImportPreview);
    el("geofence-settings-form").addEventListener("submit", saveGeofenceSettings);
    el("geofence-use-current-btn").addEventListener("click", useCurrentLocationForGeofence);
    el("imports-preview-tbody").addEventListener("change", (event) => {
      const input = event.target.closest("[data-import-field]");
      if (input) {
        const row = state.importPreview.rows[Number(input.dataset.importRow)];
        if (!row) return;
        row[input.dataset.importField] = cleanValue(input.value);
        recomputeImportPreview();
        renderImportPreview();
        return;
      }

      const toggle = event.target.closest("[data-import-skip]");
      if (!toggle) return;
      const row = state.importPreview.rows[Number(toggle.dataset.importSkip)];
      if (!row) return;
      row.skipped = !toggle.checked;
      recomputeImportPreview();
      renderImportPreview();
    });

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
      const attendanceBtn = event.target.closest("[data-attendance-student]");
      if (attendanceBtn) {
        const studentId = attendanceBtn.dataset.attendanceStudent;
        if (!studentId) return;
        try {
          await setStudentAttendanceStatus(studentId, attendanceBtn.dataset.attendanceStatus || null);
        } catch (error) {
          alert(error.message || "Unable to update attendance status.");
        }
        return;
      }

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

    el("today-attempts-search")?.addEventListener("input", (event) => {
      state.todayAttemptSearch = event.target.value;
      renderToday();
    });

    el("today-student-grid").addEventListener("click", async (event) => {
      const attendanceBtn = event.target.closest("[data-attendance-student]");
      if (attendanceBtn) {
        const studentId = attendanceBtn.dataset.attendanceStudent;
        if (!studentId) return;
        try {
          await setStudentAttendanceStatus(studentId, attendanceBtn.dataset.attendanceStatus || null);
        } catch (error) {
          alert(error.message || "Unable to update attendance status.");
        }
        return;
      }

      const card = event.target.closest("[data-today-grid-student-id]");
      if (!card) return;
      const studentId = card.dataset.todayGridStudentId;
      if (!studentId) return;
      try {
        await toggleTodayStudentStatus(studentId);
      } catch (error) {
        alert(error.message || "Unable to update student status.");
      }
    });

    el("today-waiting-only-toggle")?.addEventListener("change", (event) => {
      state.todayGridWaitingOnly = event.target.checked;
      renderTodayStudentGrid();
    });

    el("today-grid-fullscreen-btn")?.addEventListener("click", () => {
      setTodayGridFullscreen(!state.todayGridFullscreen);
    });

    document.addEventListener("fullscreenchange", () => {
      const panel = el("today-student-grid-card");
      if (state.todayGridFullscreen && document.fullscreenElement !== panel) {
        setTodayGridFullscreen(false, { skipNative: true });
      } else if (state.todayGridFullscreen) {
        scheduleTodayGridFit();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.todayGridFullscreen) {
        setTodayGridFullscreen(false);
      }
    });

    window.addEventListener("resize", scheduleTodayGridFit);

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
      ensureRecallDateRange();
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
    if (state.todayGridFitTimer) window.cancelAnimationFrame(state.todayGridFitTimer);
    if (state.channel && window.carpoolClient) {
      window.carpoolClient.removeChannel(state.channel);
    }
  });
})();
