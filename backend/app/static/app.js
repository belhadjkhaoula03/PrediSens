const $ = (selector) => document.querySelector(selector);
let token = localStorage.getItem("pm_token");
let role = localStorage.getItem("pm_role");
let refreshTimer = null;
let refreshInFlight = false;
let refreshQueued = false;
let managerAcquisitionMode = "hardware";
let managerAlertMode = "hardware";
let managerAlertStatus = "all";
let managerPerformancePeriod = "7d";
let currentManagerPage = "overview";
const measurementUi = window.PrediMaintMeasurements;
let machineId = "";
let managerMachines = [];
let editingMachineId = null;
let editingMachineActive = true;
let editingSensorId = null;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    logout();
    throw new Error("Session expirée. Reconnectez-vous.");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Erreur serveur" }));
    throw new Error(error.detail || "Erreur serveur");
  }
  return response.status === 204 ? null : response.json();
}

async function registerAppShell() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => new URL(registration.scope).pathname === "/static/")
        .map((registration) => registration.unregister()),
    );
    await navigator.serviceWorker.register("/service-worker.js?v=31", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch (error) {
    console.error("La mise en cache de l’interface est indisponible", error);
  }
}

function machineStatusInfo(machine, suffix = "") {
  if (machine?.status === "online") return { css: "", label: `En ligne${suffix}` };
  if (machine?.status === "fault") {
    const sensors = Array.isArray(machine.inactive_sensors) && machine.inactive_sensors.length
      ? ` : capteur ${machine.inactive_sensors.map(escapeHtml).join(", ")} inactif` : "";
    return { css: "offline", label: `En panne${sensors}` };
  }
  return { css: "offline", label: `Hors ligne${suffix}` };
}

function showToast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 2600);
}

let notificationMonitorTimer = null;
let notificationMonitorKnownIds = null;
let notificationMonitorInFlight = false;

const managerPhotoObjectUrls = new Set();

function clearManagerPhotoObjectUrls() {
  managerPhotoObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  managerPhotoObjectUrls.clear();
}

// Affiche les photos jointes par le technicien à une intervention (espace Responsable).
async function loadManagerInterventionPhotos(panel) {
  const interventionId = panel.dataset.managerPhotoPanel;
  const gallery = panel.querySelector("[data-manager-photo-gallery]");
  if (!gallery || gallery.dataset.loading === "true") return;

  // A manager can open an intervention before its technician uploads evidence.
  // Never treat an empty result as permanent: check again every time the panel
  // is reopened so newly uploaded photos become visible without a page reload.
  gallery.dataset.loading = "true";
  for (const image of gallery.querySelectorAll('img[src^="blob:"]')) {
    URL.revokeObjectURL(image.src);
    managerPhotoObjectUrls.delete(image.src);
  }
  gallery.textContent = "Chargement des photos…";
  try {
    const photos = await api(`/interventions/${interventionId}/photos`, { cache: "no-store" });
    const items = [];
    for (const photo of photos) {
      const response = await fetch(`/api/interventions/${interventionId}/photos/${photo.id}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        logout();
        throw new Error("Session expirée. Reconnectez-vous.");
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || `La photo « ${photo.original_name} » n’a pas pu être chargée.`);
      }
      const url = URL.createObjectURL(await response.blob());
      managerPhotoObjectUrls.add(url);
      items.push(`<figure><img src="${url}" alt="Photo de l’intervention ${escapeHtml(interventionId)}">
        <figcaption>${escapeHtml(photo.original_name)} · ${formatDate(photo.created_at)}</figcaption></figure>`);
    }
    gallery.innerHTML = items.join("") || '<p class="muted">Aucune photo jointe pour le moment. Rouvrez cette section pour actualiser.</p>';
  } catch (error) {
    gallery.innerHTML = `<p class="inline-error" role="alert">${escapeHtml(error.message)}</p>`;
  } finally {
    gallery.dataset.loading = "false";
  }
}

const NOTIFICATION_TOAST_MS = 180000; // 3 minutes
const NOTIFICATION_TOAST_MAX = 4;

function notificationHeading(type) {
  return {
    intervention_assigned: "Nouvelle intervention",
    intervention_progress: "Suivi d’intervention",
    intervention_updated: "Intervention mise à jour",    due_reminder: "Rappel d’échéance",
  }[type] || "Nouvelle notification";
}

// Ouvre la page liée à la notification, selon le rôle connecté.
function openNotificationTarget(item) {
  const targetType = item.target_type || "";
  if (role === "technician") {
    const page = targetType === "intervention" ? "interventions"
      : targetType === "alert" ? "alerts" : "notifications";
    document.querySelector(`[data-tech-page="${page}"]`)?.click();
  } else if (role === "manager") {
    const page = targetType === "intervention" ? "interventions"
      : targetType === "alert" ? "alerts" : "overview";
    document.querySelector(`[data-manager-page="${page}"]`)?.click();
  } else if (role === "director") {
    document.querySelector('[data-director-page="notifications"]')?.click();
  } else if (role === "admin") {
    document.querySelector('[data-admin-page="notifications"]')?.click();
  }
}

function showIncomingNotification(item) {
  const container = $("#notification-toasts");
  if (!container) return;
  // Évite l'empilement : on ne garde que les dernières notifications à l'écran.
  while (container.children.length >= NOTIFICATION_TOAST_MAX) container.firstElementChild.remove();
  const toast = document.createElement("article");
  toast.className = "incoming-notification";
  toast.setAttribute("role", "status");
  toast.tabIndex = 0;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "notification-close";
  close.setAttribute("aria-label", "Fermer la notification");
  close.textContent = "×";
  const heading = document.createElement("strong");
  heading.textContent = notificationHeading(item.type);
  const message = document.createElement("p");
  message.textContent = item.message || "Une nouvelle notification vous est adressée.";
  const time = document.createElement("small");
  time.textContent = item.created_at ? new Date(item.created_at).toLocaleString("fr-FR") : "À l’instant";
  toast.append(close, heading, message, time);
  container.append(toast);
  const timer = window.setTimeout(() => toast.remove(), NOTIFICATION_TOAST_MS);
  const dismiss = () => {
    window.clearTimeout(timer);
    toast.remove();
  };
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });
  const open = async () => {
    dismiss();
    openNotificationTarget(item);
    try {
      await api(`/notifications/${encodeURIComponent(item.id)}/read`, { method: "POST" });
    } catch (error) {
      console.debug("Notification non marquée comme lue", error);
    }
  };
  toast.addEventListener("click", open);
  toast.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void open();
    if (event.key === "Escape") dismiss();
  });
}

async function pollIncomingNotifications() {
  if (!token || notificationMonitorInFlight) return;
  const pollingToken = token;
  notificationMonitorInFlight = true;
  try {
    const notifications = await api("/notifications");
    if (!token || token !== pollingToken) return;
    const rows = Array.isArray(notifications) ? notifications : [];
    const currentIds = new Set(rows.map((item) => String(item.id)));
    if (notificationMonitorKnownIds === null) {
      // Initialize silently, but show messages generated just as the session opened.
      const recentCutoff = Date.now() - 180000;
      rows.filter((item) => !item.read && Date.parse(item.created_at) >= recentCutoff)
        .slice().reverse().forEach(showIncomingNotification);
      notificationMonitorKnownIds = currentIds;
      return;
    }
    rows.filter((item) => !notificationMonitorKnownIds.has(String(item.id)))
      .slice().reverse().forEach(showIncomingNotification);
    currentIds.forEach((id) => notificationMonitorKnownIds.add(id));
    if (notificationMonitorKnownIds.size > 500) notificationMonitorKnownIds = currentIds;
  } catch (error) {
    // A failed background poll must not interrupt the active page.
    console.debug("Vérification des notifications indisponible", error);
  } finally {
    notificationMonitorInFlight = false;
  }
}

function startNotificationMonitor() {
  window.clearInterval(notificationMonitorTimer);
  notificationMonitorKnownIds = null;
  void pollIncomingNotifications();
  notificationMonitorTimer = window.setInterval(() => void pollIncomingNotifications(), 5000);
}

function stopNotificationMonitor() {
  window.clearInterval(notificationMonitorTimer);
  notificationMonitorTimer = null;
  notificationMonitorKnownIds = null;
  notificationMonitorInFlight = false;
  $("#notification-toasts")?.replaceChildren();
}

function localDateTimeInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateAssignmentDueMinimum() {
  const input = $("#assignment-form [name='due_at']");
  if (!input) return;
  const minimum = new Date();
  minimum.setSeconds(0, 0);
  minimum.setMinutes(minimum.getMinutes() + 1);
  input.min = localDateTimeInputValue(minimum);
  input.setCustomValidity(input.value && new Date(input.value).getTime() <= Date.now()
    ? "Choisissez une date et une heure futures."
    : "");
}

function logout() {
  if (typeof window.predimaintBeforeLogout === "function" && !window.predimaintBeforeLogout()) return;
  window.dispatchEvent(new CustomEvent("predimaint:logout"));
  stopNotificationMonitor();
  token = null;
  role = null;
  localStorage.removeItem("pm_token");
  localStorage.removeItem("pm_role");
  clearInterval(refreshTimer);
  $("#app").classList.add("hidden");
  $("#app").classList.remove("manager-app");
  $("#admin-app").classList.add("hidden");
  $("#technician-app").classList.add("hidden");
  $("#director-app").classList.add("hidden");
  $("#director-sidebar").classList.remove("open");
  $("#manager-sidebar").classList.add("hidden");
  $("#manager-sidebar").classList.remove("open");
  $("#manager-header").classList.add("hidden");
  $("#generic-welcome").classList.remove("hidden");
  $("#manager-profile-content").replaceChildren();
  document.querySelectorAll("[data-manager-view]").forEach((view) => {
    view.classList.toggle("hidden", view.dataset.managerView !== "overview");
  });
  $("#login").classList.remove("hidden");
  $("#forgot-password").classList.add("hidden");
  $("#reset-password").classList.add("hidden");
  $("#logout").classList.add("hidden");
  document.querySelector(".public-header").classList.remove("hidden");
}

function metricCard(title, value, unit, note) {
  return `<div class="metric"><span>${title}</span><strong>${value}</strong><small>${unit} · ${note}</small></div>`;
}

function fmt(value, decimals = 1) {
  return Number(value).toFixed(decimals);
}

function formatDate(value) {
  return measurementUi.formatDate(value);
}

function formatMachine(machine) {
  machineUiMarkReceived(machine);
  const freshness = machine.measurement_recorded_at
    ? measurementUi.freshness({
      age_seconds: machine.measurement_age_seconds,
      _client_received_at: machine._client_received_at,
    })
    : { label: "Aucune mesure récente", stale: true };
  return `<div class="alert"><span><strong>${escapeHtml(machine.name)}</strong><br>
    <small class="muted">${machine.measurement_recorded_at
    ? `Dernière mesure ${measurementUi.modeBadge(machine.last_measurement_mode)} : ${measurementUi.formatDate(machine.measurement_recorded_at)} · ${escapeHtml(freshness.label)}`
    : "Aucune mesure récente"}</small></span>
    <span class="status ${machineStatusInfo(machine, " (MQTT)").css}">${machineStatusInfo(machine, " (MQTT)").label}${machine.active ? "" : " · Archivée"}</span></div>`;
}

function machineUiMarkReceived(machine) {
  if (!Number.isFinite(machine._client_received_at)) machine._client_received_at = Date.now();
}

function formatTelemetryValue(value, decimals = 1, unit = "") {
  if (value === null || value === undefined || value === "") return "Non disponible";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(decimals)}${unit}` : "Non disponible";
}

async function refreshAssets(machines) {
  if (role !== "manager") return;
  const machineOptions = machines.map((machine) => `<option value="${escapeHtml(machine.id)}">${escapeHtml(machine.name)}</option>`).join("");
  const sensorSelect = $("#sensor-machine-select");
  const previous = sensorSelect.value || machineId;
  sensorSelect.innerHTML = machineOptions;
  if (machines.some((machine) => machine.id === previous)) sensorSelect.value = previous;
  const activeMachines = machines.filter((machine) => machine.active);
  const activeOptions = activeMachines.map((machine) =>
    `<option value="${escapeHtml(machine.id)}">${escapeHtml(machine.name)}</option>`
  ).join("");
  [
    ["#threshold-machine", machineId],
    ["#manager-failure-machine", activeMachines[0]?.id || ""],
  ].forEach(([selector, fallback]) => {
    const select = $(selector);
    const selected = select.value || fallback;
    select.innerHTML = activeOptions;
    if (activeMachines.some((machine) => machine.id === selected)) select.value = selected;
  });
  const comparisonSelect = $("#manager-compare-machines");
  const selectedComparisonIds = new Set(
    Array.from(comparisonSelect.selectedOptions, (option) => option.value),
  );
  comparisonSelect.innerHTML = activeOptions;
  Array.from(comparisonSelect.options).forEach((option) => {
    option.selected = selectedComparisonIds.has(option.value);
  });

  $("#asset-machines").innerHTML = machines.map((machine) => `<div class="asset-row">
    <span><strong>${escapeHtml(machine.name)}</strong><div class="asset-meta">${machine.active ? "Active" : "Archivée"}</div></span>
    <span class="actions"><button type="button" data-machine-edit="${escapeHtml(machine.id)}">Modifier</button>
    <button type="button" data-machine-toggle="${escapeHtml(machine.id)}" data-active="${machine.active}">${machine.active ? "Archiver" : "Réactiver"}</button></span>
  </div>`).join("") || '<p class="empty">Aucune machine.</p>';

  const selectedMachine = sensorSelect.value;
  if (!selectedMachine) {
    $("#asset-sensors").innerHTML = '<p class="empty">Déclarez une machine avant ses capteurs.</p>';
    return;
  }
  const sensors = await api(`/machines/${encodeURIComponent(selectedMachine)}/sensors`);
  $("#asset-sensors").innerHTML = sensors.map((sensor) => `<div class="asset-row">
    <span><strong>${escapeHtml(sensor.metric)} · ${escapeHtml(sensor.sensor_type)}</strong>
    <div class="asset-meta">GPIO ${sensor.gpio ?? "—"} · ${escapeHtml(sensor.unit)} · ${sensor.enabled ? "actif" : "désactivé"}</div></span>
    <span class="actions"><button type="button" data-sensor-edit="${sensor.id}">Modifier</button>
    <button type="button" data-sensor-toggle="${sensor.id}" data-enabled="${sensor.enabled}">${sensor.enabled ? "Désactiver" : "Activer"}</button></span>
  </div>`).join("") || '<p class="empty">Aucun capteur déclaré pour cette machine.</p>';
}

async function loadThresholdForm() {
  const selectedMachine = $("#threshold-machine").value;
  if (role !== "manager" || !selectedMachine) {
    $("#threshold-form [name=warning]").value = "";
    $("#threshold-form [name=critical]").value = "";
    return;
  }
  const metric = $("#threshold-form [name=metric]").value;
  const thresholds = await api(`/thresholds/${encodeURIComponent(selectedMachine)}`);
  const threshold = thresholds.find((item) => item.metric === metric);
  $("#threshold-form [name=warning]").value = threshold ? threshold.warning : "";
  $("#threshold-form [name=critical]").value = threshold ? threshold.critical : "";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} %` : "Non calculable";
}

function formatHours(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} h` : "Non calculable";
}

function renderManagerFailures(failures, target, allowResolution = true) {
  target.innerHTML = failures.map((failure) => `<article class="manager-failure-row">
    <div><strong>${escapeHtml(failure.machine_name)} · ${escapeHtml(failure.failure_type)}</strong>
      <p>${escapeHtml(failure.description)}</p>
      <small>${formatDate(failure.detected_at)} · ${failure.status === "resolved" ? `Rétablie ${formatDate(failure.resolved_at)} · ${formatHours(failure.duration_seconds / 3600)}` : `Déclarée par ${escapeHtml(failure.detected_by)} · En cours`}</small>
      ${failure.result ? `<p class="muted">${escapeHtml(failure.result)}</p>` : ""}
    </div>
    ${allowResolution && failure.status === "open" ? `<form class="manager-failure-resolution" data-manager-failure="${failure.id}">
      <label>Diagnostic<input name="diagnosis" required minlength="3" maxlength="4000"></label>
      <label>Travail réalisé<input name="work_done" required minlength="3" maxlength="4000"></label>
      <label>Résultat / preuve de rétablissement<input name="result" required minlength="3" maxlength="4000"></label>
      <button class="quiet" type="submit">Confirmer le rétablissement</button><span class="muted" role="status"></span>
    </form>` : ""}
  </article>`).join("") || '<p class="empty">Aucune panne confirmée sur la période.</p>';
}

async function loadManagerFailures() {
  try {
    const failures = await api("/manager/failures?limit=100");
    renderManagerFailures(failures, $("#manager-failures"));
    const failureSelect = $("#assignment-failure");
    const selectedFailure = failureSelect.value;
    const selectedMachine = $("#assignment-machine").value;
    const openFailures = failures.filter((failure) =>
      failure.status === "open" && (!selectedMachine || failure.machine_id === selectedMachine)
    );
    failureSelect.innerHTML = `<option value="">Aucune</option>${openFailures.map((failure) =>
      `<option value="${failure.id}">${escapeHtml(failure.machine_name)} · ${escapeHtml(failure.failure_type)} · ${escapeHtml(failure.description)}</option>`
    ).join("")}`;
    if (openFailures.some((failure) => String(failure.id) === selectedFailure)) {
      failureSelect.value = selectedFailure;
    }
  } catch (error) {
    $("#manager-failures").innerHTML = `<p class="inline-error" role="alert">${escapeHtml(error.message)}</p>`;
  }
}

async function loadManagerPerformance() {
  const updated = $("#manager-performance-updated");
  if (!updated || role !== "manager") return;
  updated.classList.remove("inline-error");
  updated.textContent = "Actualisation des indicateurs…";
  try {
    const result = await api(`/manager/performance?period=${managerPerformancePeriod}`);
    const periodLabel = { "24h": "24 dernières heures", "7d": "7 derniers jours", "30d": "30 derniers jours" }[managerPerformancePeriod];
    const availability = result.availability;
    const availabilityNote = availability.value === null
      ? availability.reason
      : `Couverture observée : ${formatPercent(availability.coverage_percentage)}${availability.quality === "insufficient_coverage" ? " · historique incomplet (< 95 %)" : ""}`;
    $("#manager-performance-kpis").innerHTML = [
      metricCard("Machines suivies", result.machine_count, "machines", "parc actif"),
      metricCard("Machines en ligne", result.online_count, "machines", "statut MQTT"),
      metricCard("Machines hors ligne", result.offline_count, "machines", "statut MQTT"),
      metricCard("Sans communication connue", result.unknown_count, "machines", "aucun dernier contact"),
      metricCard("Anomalies actives", result.anomaly_count, "alertes", "hors alertes clôturées ou fausses"),
      metricCard("Pannes confirmées", result.confirmed_failure_count, "pannes", periodLabel),
      metricCard("Disponibilité de supervision", formatPercent(availability.value), "MQTT", availabilityNote || periodLabel),
      metricCard("Indisponibilité observée", formatPercent(availability.value === null ? null : 100 - availability.value), "MQTT", `${formatHours(availability.offline_hours)} hors ligne`),
      metricCard("MTBF", formatHours(result.mtbf.value_hours), "heures", result.mtbf.reason || "Temps en ligne / pannes confirmées"),
      metricCard("MTTR", formatHours(result.mttr.value_hours), "heures", result.mttr.reason || "Durée moyenne avant rétablissement"),
      metricCard("Temps en ligne", formatHours(availability.online_hours), "heures", `sur ${formatHours(availability.observed_hours)} observées`),
      metricCard("Temps hors ligne", formatHours(availability.offline_hours), "heures", "perte de supervision MQTT"),
    ].join("");

    $("#manager-performance-note").textContent = availability.quality === "insufficient_coverage"
      ? `Indicateur calculé sur les transitions MQTT persistées, mais la couverture est inférieure à 95 %. Il est indicatif et ne représente pas une disponibilité mécanique. Période : ${periodLabel}.`
      : "La disponibilité mesure uniquement la supervision MQTT, pas l'état mécanique. Les pannes affichées sont déclarées comme confirmées par le Responsable; les anomalies de capteurs et déconnexions ne sont pas assimilées à des pannes.";

    $("#manager-performance-trend").innerHTML = result.trend.map((bucket) => {
      const value = bucket.availability_percentage;
      const height = value === null ? 0 : Math.max(2, Math.min(100, value));
      const label = new Date(bucket.start).toLocaleDateString("fr-FR");
      return `<div class="manager-trend-item" title="${escapeHtml(formatDate(bucket.start))} · couverture ${escapeHtml(formatPercent(bucket.coverage_percentage))}">
        <strong>${escapeHtml(formatPercent(value))}</strong><span class="manager-trend-bar" style="height:${height}%"></span><small>${escapeHtml(label)}</small>
      </div>`;
    }).join("") || '<p class="empty">Aucune transition d’état sur la période.</p>';

    $("#manager-performance-machines").innerHTML = result.machines.map((machine) => `<tr>
      <td>${escapeHtml(machine.name)}</td>
      <td><span class="status ${machineStatusInfo(machine).css}">${machineStatusInfo(machine).label}</span></td>
      <td>${machine.last_telemetry_at ? formatDate(machine.last_telemetry_at) : "Aucune télémétrie"}</td>
      <td>${formatPercent(machine.availability_percentage)}<small class="manager-cell-note">Couverture ${formatPercent(machine.coverage_percentage)}</small></td>
      <td>${formatHours(machine.mtbf_hours)}</td><td>${formatHours(machine.mttr_hours)}</td><td>${machine.confirmed_failure_count}</td>
    </tr>`).join("") || '<tr><td colspan="7" class="empty">Aucune machine active.</td></tr>';

    renderManagerFailures(result.failures, $("#manager-performance-failures"), false);
    const sla = result.sla;
    if (document.activeElement !== $("#manager-sla-form [name=target_percentage]")) {
      $("#manager-sla-form [name=target_percentage]").value = sla.target_percentage ?? "";
    }
    const slaLabels = {
      unconfigured: "Aucune cible configurée",
      insufficient_coverage: "Couverture insuffisante pour évaluer la cible",
      met: "Objectif respecté",
      missed: "Objectif dépassé",
    };
    $("#manager-sla-summary").innerHTML = `<span class="status ${sla.status === "missed" ? "offline" : ""}">${slaLabels[sla.status] || "État inconnu"}</span>
      <span>Cible : ${sla.target_percentage === null ? "—" : formatPercent(sla.target_percentage)}</span>
      <span>Indisponibilité tolérée : ${formatHours(sla.tolerated_offline_hours)}</span>
      <span>Constatée : ${formatHours(sla.actual_offline_hours)}</span>
      <span>Marge : ${formatHours(sla.margin_hours)}</span>`;
    updated.textContent = `Dernière actualisation : ${formatDate(result.updated_at)} · période ${periodLabel}`;
  } catch (error) {
    updated.textContent = `Indicateurs indisponibles : ${error.message}`;
    updated.classList.add("inline-error");
  }
}

async function refresh() {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  const acquisitionMode = managerAcquisitionMode;
  const alertMode = managerAlertMode;
  try {
    const alertParams = new URLSearchParams();
    if (alertMode !== "all") alertParams.set("acquisition_mode", alertMode);
    if (managerAlertStatus !== "all") alertParams.set("status", managerAlertStatus);
    const alertQuery = alertParams.toString();
    const alertFilter = alertQuery ? `?${alertQuery}` : "";
    const [dashboard, machines, alerts] = await Promise.all([
      api(`/dashboard?acquisition_mode=${acquisitionMode}`), api("/machines"), api(`/alerts${alertFilter}`),
    ]);
    if (acquisitionMode !== managerAcquisitionMode || alertMode !== managerAlertMode) {
      refreshQueued = true;
      return;
    }
    $("#manager-data-error")?.classList.add("hidden");
    const notifications = await api("/admin/notifications/me");
    $("#user-notifications").innerHTML = notifications.map((item) => `<div class="alert">
      <span>${escapeHtml(item.message)}<br><small class="muted">${formatDate(item.created_at)}</small></span>
      <span class="status ${item.delivery_status === "failed" ? "offline" : ""}">${escapeHtml(item.delivery_status)}</span>
    </div>`).join("") || '<p class="empty">Aucune notification.</p>';
    const latestNote = dashboard.latest
      ? `${measurementUi.modeBadge(dashboard.latest.acquisition_mode)} · ${measurementUi.formatDate(dashboard.latest.recorded_at)} · ${measurementUi.freshness(dashboard.latest).label}`
      : `Aucune mesure récente en mode ${measurementUi.modeLabel(managerAcquisitionMode)}`;
    $("#cards").innerHTML = [
      metricCard("Machines en ligne", `${dashboard.online_count}/${dashboard.machine_count}`, "unités", "état du parc"),
      metricCard("Alertes actives", dashboard.active_alert_count, "événements", "seuils"),
      metricCard("Température", dashboard.latest ? fmt(dashboard.latest.temperature) : "—", "°C", latestNote),
      metricCard("Vibration", dashboard.latest ? fmt(dashboard.latest.vibration_rate, 2) : "—", "événements/s", latestNote),
    ].join("");

    managerMachines = machines;
    $("#machine-select").innerHTML = machines.map((machine) => `<option value="${escapeHtml(machine.id)}">${escapeHtml(machine.name)}</option>`).join("");
    if (machines.some((machine) => machine.id === machineId)) $("#machine-select").value = machineId;
    else machineId = machines[0]?.id || "";
    if (machineId) $("#machine-select").value = machineId;
    $("#machine-list").innerHTML = machines.map(formatMachine).join("") || '<p class="empty">Aucune machine active.</p>';

    if (machineId) {
      const measurements = measurementUi.sortAndDedupe(await api(
        `/machines/${encodeURIComponent(machineId)}/telemetry?limit=20&acquisition_mode=${acquisitionMode}`,
      ));
      if (acquisitionMode !== managerAcquisitionMode || alertMode !== managerAlertMode) {
        refreshQueued = true;
        return;
      }
      const latest = measurements[measurements.length - 1];
      $("#manager-measurement-freshness").textContent = latest
        ? `Dernière mesure ${measurementUi.modeBadge(latest.acquisition_mode)} : ${measurementUi.formatDate(latest.recorded_at)} · ${measurementUi.freshness(latest).label}`
        : "Aucune mesure récente dans le mode choisi.";
      $("#measurements").innerHTML = measurements.slice().reverse().map((item) => `<tr>
        <td>${measurementUi.formatDate(item.recorded_at)}</td>
        <td>${formatTelemetryValue(item.temperature, 1, " °C")}</td>
        <td>${formatTelemetryValue(item.humidity, 1, " %")}</td>
        <td>${formatTelemetryValue(item.vibration_rate, 2, " événements/s")}</td>
        <td>${formatTelemetryValue(item.vibration_edges, 0)}</td>
        <td>${measurementUi.currentValue(item)}</td>
        <td>${measurementUi.currentSourceLabel(item)}</td>
        <td>${measurementUi.modeBadge(item.acquisition_mode)}</td></tr>`).join("")
        || '<tr><td colspan="8" class="empty">Aucune mesure récente dans le mode choisi.</td></tr>';
      if (latest) {
        const freshness = measurementUi.freshness(latest);
        $("#manager-measurement-freshness").classList.toggle("inline-error", freshness.stale);
      }
    } else {
      $("#manager-measurement-freshness").textContent = "Aucune machine active.";
      $("#measurements").innerHTML = '<tr><td colspan="8" class="empty">Aucune machine active.</td></tr>';
    }

    const alertStatuses = {
      new: "Nouvelle",
      acknowledged: "Acquittée",
      closed: "Clôturée",
      false_positive: "Fausse alerte",
    };
    $("#alerts").innerHTML = alerts.map((alert) => `<div class="alert">
      <span><strong>${escapeHtml(alert.machine_name || "Machine")}</strong> · ${escapeHtml(alert.metric)} = ${measurementUi.metricValue(alert.metric, alert.value)}<br>
      <small class="muted">${measurementUi.formatDate(alert.created_at)} · ${escapeHtml(alertStatuses[alert.status] || alert.status)} · ${measurementUi.modeLabel(alert.acquisition_mode)}</small></span>
      <span class="severity ${alert.severity === "critical" ? "critical" : ""}">${escapeHtml(alert.severity)}</span>
      <span class="actions">${role === "manager" && !["closed", "false_positive"].includes(alert.status)
        ? `${alert.status === "new" ? `<button data-act="ack" data-id="${alert.id}">Acquitter</button>` : ""}
          <button data-act="close" data-id="${alert.id}">Clôturer</button>
          <button data-act="false-positive" data-id="${alert.id}">Fausse alerte</button>` : ""}
        <button type="button" data-alert-history="${alert.id}">Historique</button></span>
    </div><div id="alert-history-${alert.id}" class="manager-alert-history hidden"></div>`).join("") || '<p class="empty">Aucune alerte pour ces filtres.</p>';

    if (role === "manager") {
      try {
        const interventions = await api("/interventions");
        const statuses = {
          assigned: "À prendre en charge",
          accepted: "Acceptée",
          in_progress: "En cours",
          completed: "Terminée",
          cancelled: "Annulée",
        };
        $("#manager-interventions").innerHTML = interventions.map((item) => {
          const machine = machines.find((candidate) => candidate.id === item.machine_id);
          const deadline = item.due_at ? formatDate(item.due_at) : "Non définie";
          const deadlineTimestamp = item.due_at ? new Date(item.due_at).getTime() : Number.NaN;
          const overdue = !["completed", "cancelled"].includes(item.status)
            && (!Number.isFinite(deadlineTimestamp) || deadlineTimestamp <= Date.now());
          const acceptance = item.accepted_at ? ` · Acceptée : ${formatDate(item.accepted_at)}` : "";
          const completion = item.completed_at
            ? ` · Terminée : ${formatDate(item.completed_at)} · Durée calculée : ${item.duration_minutes} min`
            : item.duration_minutes ? ` · Durée déclarée : ${item.duration_minutes} min` : "";
          const hasReport = Boolean(item.diagnosis || item.work_done || item.result);
          const reportPanel = `<details class="intervention-photo-panel" data-manager-photo-panel="${item.id}">
            <summary>Compte rendu et photos</summary>
            ${hasReport ? `<div class="manager-intervention-report">
              <p><strong>Diagnostic :</strong> ${escapeHtml(item.diagnosis || "Non renseigné")}</p>
              <p><strong>Travail réalisé :</strong> ${escapeHtml(item.work_done || "Non renseigné")}</p>
              <p><strong>Résultat :</strong> ${escapeHtml(item.result || "Non renseigné")}</p>
            </div>` : '<p class="muted">Aucun compte rendu pour le moment.</p>'}
            <div class="intervention-photo-gallery" data-manager-photo-gallery="${item.id}"></div>
          </details>`;
          return `<div class="asset-row intervention-row"><span><strong>${escapeHtml(item.title)}</strong>
            <div class="asset-meta">${escapeHtml(machine ? machine.name : item.machine_id)} · ${escapeHtml(item.assigned_to_name || "Non attribuée")} · Échéance : ${escapeHtml(deadline)}${overdue ? ' · <strong class="overdue-label">ÉCHÉANCE DÉPASSÉE — INTERVENTION BLOQUÉE</strong>' : ""}${escapeHtml(acceptance)}${escapeHtml(completion)}</div></span>
            <span class="status ${overdue ? "overdue" : item.status === "completed" || item.status === "cancelled" ? "offline" : ""}">${escapeHtml(overdue ? "Bloquée" : statuses[item.status] || item.status)}</span>
            ${overdue ? `<form class="reschedule-intervention-form" data-intervention-id="${item.id}" data-revision="${item.revision}"><label>Nouvelle échéance<input name="due_at" type="datetime-local" required></label><button class="quiet" type="submit">Replanifier</button><span class="form-message muted" role="status"></span></form>` : ""}
            ${reportPanel}</div>`;
        }).join("") || '<p class="empty">Aucune intervention enregistrée.</p>';
        clearManagerPhotoObjectUrls();
        document.querySelectorAll("[data-manager-photo-panel]").forEach((panel) => {
          panel.addEventListener("toggle", () => {
            if (panel.open) void loadManagerInterventionPhotos(panel);
          });
        });
        document.querySelectorAll(".reschedule-intervention-form").forEach((form) => {
          const dueInput = form.elements.namedItem("due_at");
          const minimum = new Date();
          minimum.setSeconds(0, 0);
          minimum.setMinutes(minimum.getMinutes() + 1);
          dueInput.min = localDateTimeInputValue(minimum);
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const value = dueInput.value;
            const message = $(".form-message", form);
            if (!value || !Number.isFinite(new Date(value).getTime()) || new Date(value).getTime() <= Date.now()) {
              dueInput.setCustomValidity("Choisissez une nouvelle échéance dans le futur.");
              dueInput.reportValidity();
              message.textContent = "La nouvelle échéance doit être future.";
              message.classList.add("error");
              return;
            }
            dueInput.setCustomValidity("");
            try {
              await api(`/interventions/${form.dataset.interventionId}`, {
                method: "PATCH",
                body: JSON.stringify({
                  due_at: new Date(value).toISOString(),
                  expected_revision: Number(form.dataset.revision),
                }),
              });
              showToast("Nouvelle échéance enregistrée");
              await refresh();
            } catch (error) {
              message.textContent = error.message;
              message.classList.add("error");
            }
          });
        });
      } catch (error) {
        $("#manager-interventions").innerHTML = `<p class="inline-error" role="alert">${escapeHtml(error.message)}</p>`;
      }
    }

    await refreshAssets(machines);
    if (role === "manager" && currentManagerPage === "performance") {
      await loadManagerPerformance();
    }
  } catch (error) {
    console.error(error);
    const errorTarget = $("#manager-data-error");
    if (errorTarget) {
      errorTarget.textContent = error.message;
      errorTarget.classList.remove("hidden");
    }
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh();
    }
  }
}

async function showManagerPage(page) {
  const pages = {
    overview: ["Vue d'ensemble", "Suivez l'état du parc et les mesures récentes."],
    alerts: ["Alertes", "Consultez et traitez les événements de vos équipements."],
    interventions: ["Interventions", "Attribuez le travail et suivez son avancement."],
    equipment: ["Parc et capteurs", "Gérez les équipements et les capteurs enregistrés."],
    comparison: ["Comparer des machines", "Comparez leurs dernières mesures enregistrées."],
    thresholds: ["Seuils d'alerte", "Configurez les limites de surveillance des mesures."],
    performance: ["Performance", "Suivez les indicateurs calculés à partir des états et incidents persistés."],
    profile: ["Mon profil", "Gérez vos informations personnelles et la sécurité de votre compte."],
  };
  if (!Object.prototype.hasOwnProperty.call(pages, page)) return;
  currentManagerPage = page;
  document.querySelectorAll("[data-manager-view]").forEach((view) => {
    view.classList.toggle("hidden", view.dataset.managerView !== page);
  });
  document.querySelectorAll("[data-manager-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.managerPage === page);
  });
  $("#manager-page-title").textContent = pages[page][0];
  $("#manager-page-subtitle").textContent = pages[page][1];
  $("#manager-sidebar").classList.remove("open");
  if (page === "profile") {
    await window.PrediMaintProfile.render({
      container: "#manager-profile-content",
      api,
      showToast,
      onProfileUpdated: (updated) => {
        $("#manager-header-name").textContent = updated.full_name || updated.email;
        $("#manager-avatar").textContent = String(updated.full_name || "R").trim()
          .split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      },
      onPasswordChanged: () => window.setTimeout(logout, 1200),
    });
  } else if (page === "performance") {
    await loadManagerPerformance();
  } else if (page === "alerts") {
    await loadManagerFailures();
  }
}

async function start() {
  try {
    const me = await api("/auth/me");
    role = me.role;
    startNotificationMonitor();
    if (role === "admin") {
      $("#login").classList.add("hidden");
      $("#forgot-password").classList.add("hidden");
      $("#reset-password").classList.add("hidden");
      $("#app").classList.add("hidden");
      $("#technician-app").classList.add("hidden");
      $("#director-app").classList.add("hidden");
      $("#admin-app").classList.remove("hidden");
      $("#logout").classList.add("hidden");
      document.querySelector(".public-header").classList.add("hidden");
      window.dispatchEvent(new CustomEvent("predimaint:admin-authenticated"));
      return;
    }
    if (role === "technician") {
      $("#login").classList.add("hidden");
      $("#forgot-password").classList.add("hidden");
      $("#reset-password").classList.add("hidden");
      $("#app").classList.add("hidden");
      $("#admin-app").classList.add("hidden");
      $("#director-app").classList.add("hidden");
      $("#technician-app").classList.remove("hidden");
      $("#logout").classList.add("hidden");
      document.querySelector(".public-header").classList.add("hidden");
      window.dispatchEvent(new CustomEvent("predimaint:technician-authenticated", { detail: me }));
      return;
    }
    if (role === "manager") {
      $("#login").classList.add("hidden");
      $("#forgot-password").classList.add("hidden");
      $("#reset-password").classList.add("hidden");
      $("#admin-app").classList.add("hidden");
      $("#technician-app").classList.add("hidden");
      $("#director-app").classList.add("hidden");
      $("#app").classList.add("manager-app");
      $("#app").classList.remove("hidden");
      $("#manager-sidebar").classList.remove("hidden");
      $("#manager-header").classList.remove("hidden");
      $("#generic-welcome").classList.add("hidden");
      $("#logout").classList.add("hidden");
      document.querySelector(".public-header").classList.add("hidden");
      $("#manager-header-name").textContent = me.full_name || me.email;
      $("#manager-avatar").textContent = String(me.full_name || "R").trim()
        .split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      $("#assignment-panel").classList.remove("hidden");
      $("#threshold-panel").classList.remove("hidden");
      $("#assets-panel").classList.remove("hidden");
      await showManagerPage("overview");
      await refresh();
      await loadAssignmentOptions();
      await loadThresholdForm();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(refresh, 5000);
      return;
    }
    if (role === "director") {
      $("#login").classList.add("hidden");
      $("#forgot-password").classList.add("hidden");
      $("#reset-password").classList.add("hidden");
      $("#app").classList.add("hidden");
      $("#admin-app").classList.add("hidden");
      $("#technician-app").classList.add("hidden");
      $("#director-app").classList.remove("hidden");
      $("#logout").classList.add("hidden");
      document.querySelector(".public-header").classList.add("hidden");
      window.dispatchEvent(new CustomEvent("predimaint:director-authenticated", {
        detail: { user: me, api, showToast, logout },
      }));
      return;
    }
    $("#login").classList.add("hidden");
    $("#forgot-password").classList.add("hidden");
    $("#reset-password").classList.add("hidden");
    $("#admin-app").classList.add("hidden");
    $("#technician-app").classList.add("hidden");
    document.querySelector(".public-header").classList.remove("hidden");
    $("#app").classList.remove("hidden");
    $("#logout").classList.remove("hidden");
    $("#role-label").textContent = role === "manager" ? "Responsable maintenance" : "Direction";
    $("#threshold-panel").classList.toggle("hidden", role !== "manager");
    $("#assets-panel").classList.toggle("hidden", role !== "manager");
    $("#assignment-panel").classList.toggle("hidden", role !== "manager");
    $("#manager-sidebar").classList.add("hidden");
    $("#manager-header").classList.add("hidden");
    $("#generic-welcome").classList.remove("hidden");
    $("#app").classList.remove("manager-app");
    document.querySelectorAll("[data-manager-view]").forEach((view) => {
      view.classList.toggle("hidden", view.dataset.managerView !== "overview");
    });
    await refresh();
    if (role === "manager") await loadAssignmentOptions();
    await loadThresholdForm();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 5000);
  } catch (error) {
    console.error(error);
  }
}

async function loadAssignmentOptions() {
  try {
    const [machines, technicians] = await Promise.all([api("/machines"), api("/technicians")]);
    $("#assignment-machine").innerHTML = machines.map((item) =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`
    ).join("");
    $("#assignment-technician").innerHTML = technicians.map((item) =>
      `<option value="${item.id}">${escapeHtml(item.full_name)} · ${escapeHtml(item.email)}</option>`
    ).join("");
    if (!technicians.length) $("#assignment-message").textContent = "Aucun compte Technicien actif n'est disponible.";
  } catch (error) {
    $("#assignment-message").textContent = error.message;
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    token = result.access_token;
    role = result.role;
    localStorage.setItem("pm_token", token);
    localStorage.setItem("pm_role", role);
    await start();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

document.querySelectorAll("[data-toggle-password]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.togglePassword);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "Masquer" : "Afficher";
    button.setAttribute("aria-label", visible ? "Masquer le mot de passe" : "Afficher le mot de passe");
  });
});

$("#forgot-password-link").addEventListener("click", (event) => {
  event.preventDefault();
  $("#login").classList.add("hidden");
  $("#forgot-password").classList.remove("hidden");
  $("#forgot-password-message").textContent = "";
});

$("#forgot-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const message = $("#forgot-password-message");
  try {
    const response = await api("/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email") }),
    });
    message.textContent = response.message;
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

$("#assignment-machine").addEventListener("change", () => loadManagerFailures());
$("#assignment-form [name='due_at']").addEventListener("focus", updateAssignmentDueMinimum);
$("#assignment-form [name='due_at']").addEventListener("change", updateAssignmentDueMinimum);
updateAssignmentDueMinimum();

const resetToken = new URLSearchParams(location.hash.slice(1)).get("reset_token");
if (resetToken) {
  $("#login").classList.add("hidden");
  $("#forgot-password").classList.add("hidden");
  $("#reset-password").classList.remove("hidden");
  history.replaceState(null, "", location.pathname);
}

$("#reset-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const message = $("#reset-password-message");
  try {
    const response = await api("/auth/password-reset/complete", {
      method: "POST",
      body: JSON.stringify({ token: resetToken, ...values }),
    });
    if (response.updated) {
      message.textContent = "Votre mot de passe a été modifié. Vous pouvez maintenant vous connecter.";
      event.currentTarget.reset();
      token = null;
      role = null;
      localStorage.removeItem("pm_token");
      localStorage.removeItem("pm_role");
    }
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

$("#logout").addEventListener("click", logout);
$("#technician-logout").addEventListener("click", logout);
$("#manager-logout").addEventListener("click", logout);
$("#director-logout").addEventListener("click", logout);
$("#manager-menu-toggle").addEventListener("click", () => {
  $("#manager-sidebar").classList.toggle("open");
});
document.querySelectorAll("[data-manager-page]").forEach((button) => {
  button.addEventListener("click", () => showManagerPage(button.dataset.managerPage));
});
$("#manager-acquisition-mode").addEventListener("change", (event) => {
  managerAcquisitionMode = event.target.value;
  $("#cards").innerHTML = '<p class="empty" role="status">Chargement du mode sélectionné…</p>';
  $("#measurements").replaceChildren();
  $("#manager-measurement-freshness").textContent = "Chargement du mode sélectionné…";
  refresh();
});
$("#manager-alert-mode").addEventListener("change", (event) => {
  managerAlertMode = event.target.value;
  $("#alerts").innerHTML = '<p class="empty" role="status">Chargement des alertes…</p>';
  refresh();
});
$("#manager-alert-status").addEventListener("change", (event) => {
  managerAlertStatus = event.target.value;
  $("#alerts").innerHTML = '<p class="empty" role="status">Chargement des alertes…</p>';
  refresh();
});
$("#machine-select").addEventListener("change", async (event) => {
  machineId = event.target.value;
  await refresh();
  await loadThresholdForm();
});
$("#sensor-machine-select").addEventListener("change", () => refresh());
$("#threshold-form [name=metric]").addEventListener("change", () => loadThresholdForm());
$("#threshold-machine").addEventListener("change", () => loadThresholdForm());
$("#manager-performance-period").addEventListener("change", (event) => {
  managerPerformancePeriod = event.target.value;
  loadManagerPerformance();
});

$("#threshold-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const thresholdForm = event.currentTarget;
  const form = new FormData(thresholdForm);
  const metric = form.get("metric");
  const selectedMachine = form.get("machine_id");
  try {
    await api(`/thresholds/${encodeURIComponent(selectedMachine)}/${metric}`, {
      method: "PUT",
      body: JSON.stringify({ warning: Number(form.get("warning")), critical: Number(form.get("critical")) }),
    });
    $("#threshold-message").textContent = "Seuil enregistré.";
    showToast("Seuil enregistré");
  } catch (error) {
    $("#threshold-message").textContent = error.message;
  }
});

$("#manager-failure-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const failureForm = event.currentTarget;
  const form = new FormData(failureForm);
  const message = $("#manager-failure-message");
  try {
    await api("/manager/failures", {
      method: "POST",
      body: JSON.stringify({
        machine_id: form.get("machine_id"),
        failure_type: form.get("failure_type"),
        description: form.get("description"),
      }),
    });
    failureForm.reset();
    message.textContent = "Panne confirmée enregistrée.";
    await loadManagerFailures();
    await loadManagerPerformance();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

$("#manager-failures").addEventListener("submit", async (event) => {
  const formElement = event.target.closest("form[data-manager-failure]");
  if (!formElement) return;
  event.preventDefault();
  const form = new FormData(formElement);
  const message = formElement.querySelector('[role="status"]');
  try {
    await api(`/manager/failures/${formElement.dataset.managerFailure}/resolve`, {
      method: "PATCH",
      body: JSON.stringify({
        diagnosis: form.get("diagnosis"),
        work_done: form.get("work_done"),
        result: form.get("result"),
      }),
    });
    await loadManagerFailures();
    await loadManagerPerformance();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

$("#manager-sla-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const targetPercentage = Number(form.get("target_percentage"));
  try {
    await api("/manager/performance/sla", {
      method: "PUT",
      body: JSON.stringify({ target_percentage: targetPercentage }),
    });
    $("#manager-sla-message").textContent = "Cible SLA enregistrée.";
    await loadManagerPerformance();
  } catch (error) {
    $("#manager-sla-message").textContent = error.message;
    $("#manager-sla-message").classList.add("error");
  }
});

$("#manager-comparison-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const selected = Array.from($("#manager-compare-machines").selectedOptions, (option) => option.value);
  const metric = form.get("metric");
  const acquisitionMode = form.get("acquisition_mode");
  const message = $("#manager-comparison-message");
  if (selected.length < 2) {
    message.textContent = "Sélectionnez au moins deux machines.";
    return;
  }
  message.textContent = "Comparaison des dernières mesures enregistrées…";
  $("#manager-comparison-results").innerHTML = "";
  try {
    const rows = await Promise.all(selected.map(async (id) => {
      const machine = managerMachines.find((item) => item.id === id);
      const measurements = await api(
        `/machines/${encodeURIComponent(id)}/telemetry?limit=1&acquisition_mode=${acquisitionMode}`,
      );
      const measurement = measurements[measurements.length - 1];
      const thresholds = await api(`/thresholds/${encodeURIComponent(id)}`);
      const threshold = thresholds.find((item) => item.metric === metric);
      const value = measurement ? measurement[metric] : null;
      return `<tr><td>${escapeHtml(machine ? machine.name : id)}</td>
        <td>${machineStatusInfo(machine).label}</td>
        <td>${measurement ? formatDate(measurement.recorded_at) : "Aucune mesure dans ce mode"}</td>
        <td>${formatTelemetryValue(value, 2)}</td><td>${threshold ? formatTelemetryValue(threshold.critical, 2) : "Non configuré"}</td></tr>`;
    }));
    $("#manager-comparison-results").innerHTML = rows.join("");
    message.textContent = `Comparaison enregistrée à partir des données ${acquisitionMode === "hardware" ? "réelles" : "simulées"} disponibles.`;
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
});

$("#machine-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const machineForm = event.currentTarget;
  const form = new FormData(machineForm);
  try {
    const body = { name: form.get("name"), description: form.get("description"), active: editingMachineActive };
    await api(editingMachineId ? `/machines/${encodeURIComponent(editingMachineId)}` : "/machines", {
      method: editingMachineId ? "PUT" : "POST",
      body: JSON.stringify(editingMachineId ? body : { id: form.get("id"), ...body }),
    });
    resetMachineForm();
    machineForm.reset();
    $("#machine-message").textContent = "Machine déclarée.";
    showToast("Machine ajoutée");
    await refresh();
  } catch (error) {
    $("#machine-message").textContent = error.message;
  }
});

$("#assignment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const assignmentForm = event.currentTarget;
  const form = new FormData(assignmentForm);
  const dueAt = form.get("due_at");
  const dueInput = assignmentForm.elements.namedItem("due_at");
  updateAssignmentDueMinimum();
  if (dueAt && (!Number.isFinite(new Date(dueAt).getTime()) || new Date(dueAt).getTime() <= Date.now())) {
    dueInput.setCustomValidity("Choisissez une date et une heure futures.");
    dueInput.reportValidity();
    $("#assignment-message").textContent = "Impossible d’attribuer une intervention à une échéance passée.";
    return;
  }
  dueInput.setCustomValidity("");
  try {
    await api("/interventions", {
      method: "POST",
      body: JSON.stringify({
        machine_id: form.get("machine_id"),
        assigned_to_id: Number(form.get("assigned_to_id")),
        title: form.get("title"),
        description: form.get("description"),
        priority: form.get("priority"),
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        failure_id: form.get("failure_id") ? Number(form.get("failure_id")) : null,
      }),
    });
    assignmentForm.reset();
    $("#assignment-message").textContent = "L'intervention a été attribuée.";
    showToast("Intervention attribuée");
    await refresh();
    await loadManagerFailures();
  } catch (error) {
    $("#assignment-message").textContent = error.message;
  }
});

$("#sensor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const gpioText = form.get("gpio");
  const gpio = gpioText === "" ? null : Number(gpioText);
  try {
    const body = { sensor_type: form.get("sensor_type"), gpio, unit: form.get("unit") };
    await api(editingSensorId ? `/sensors/${editingSensorId}` : `/machines/${encodeURIComponent(form.get("machine_id"))}/sensors`, {
      method: editingSensorId ? "PATCH" : "POST",
      body: JSON.stringify(editingSensorId ? body : { metric: form.get("metric"), ...body }),
    });
    resetSensorForm();
    $("#sensor-message").textContent = "Capteur déclaré.";
    showToast("Capteur ajouté");
    await refreshAssets(await api("/machines"));
  } catch (error) {
    $("#sensor-message").textContent = error.message;
  }
});

$("#asset-machines").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-machine-edit]");
  if (editButton) {
    try {
      const machines = await api("/machines");
      const machine = machines.find((item) => item.id === editButton.dataset.machineEdit);
      if (!machine) return;
      editingMachineId = machine.id;
      editingMachineActive = machine.active;
      $("#machine-form [name=id]").value = machine.id;
      $("#machine-form [name=id]").readOnly = true;
      $("#machine-form [name=id]").closest("label").classList.add("hidden");
      $("#machine-form [name=name]").value = machine.name;
      $("#machine-form [name=description]").value = machine.description;
      $("#machine-submit").textContent = "Enregistrer les modifications";
      $("#machine-cancel").classList.remove("hidden");
      $("#machine-message").textContent = `Modification de ${machine.name}`;
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  const button = event.target.closest("[data-machine-toggle]");
  if (!button) return;
  try {
    const machines = await api("/machines");
    const machine = machines.find((item) => item.id === button.dataset.machineToggle);
    if (!machine) return;
    await api(`/machines/${encodeURIComponent(machine.id)}`, {
      method: "PUT",
      body: JSON.stringify({ name: machine.name, description: machine.description, active: button.dataset.active !== "true" }),
    });
    await refresh();
    showToast("État de la machine mis à jour");
  } catch (error) {
    showToast(error.message);
  }
});

$("#asset-sensors").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-sensor-edit]");
  if (editButton) {
    try {
      const selectedMachine = $("#sensor-machine-select").value;
      const sensors = await api(`/machines/${encodeURIComponent(selectedMachine)}/sensors`);
      const sensor = sensors.find((item) => item.id === Number(editButton.dataset.sensorEdit));
      if (!sensor) return;
      editingSensorId = sensor.id;
      $("#sensor-form [name=machine_id]").value = sensor.machine_id;
      $("#sensor-form [name=machine_id]").disabled = true;
      $("#sensor-form [name=metric]").value = sensor.metric;
      $("#sensor-form [name=metric]").disabled = true;
      $("#sensor-form [name=sensor_type]").value = sensor.sensor_type;
      $("#sensor-form [name=gpio]").value = sensor.gpio ?? "";
      $("#sensor-form [name=unit]").value = sensor.unit;
      $("#sensor-submit").textContent = "Enregistrer les modifications";
      $("#sensor-cancel").classList.remove("hidden");
      $("#sensor-message").textContent = `Modification du capteur ${sensor.id}`;
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  const button = event.target.closest("[data-sensor-toggle]");
  if (!button) return;
  try {
    await api(`/sensors/${button.dataset.sensorToggle}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }),
    });
    await refreshAssets(await api("/machines"));
    showToast("État du capteur mis à jour");
  } catch (error) {
    showToast(error.message);
  }
});

function resetMachineForm() {
  editingMachineId = null;
  editingMachineActive = true;
  $("#machine-form").reset();
  $("#machine-form [name=id]").readOnly = false;
  $("#machine-form [name=id]").closest("label").classList.remove("hidden");
  $("#machine-submit").textContent = "Ajouter la machine";
  $("#machine-cancel").classList.add("hidden");
}

function resetSensorForm() {
  editingSensorId = null;
  $("#sensor-form").reset();
  $("#sensor-form [name=machine_id]").disabled = false;
  $("#sensor-form [name=metric]").disabled = false;
  $("#sensor-submit").textContent = "Ajouter le capteur";
  $("#sensor-cancel").classList.add("hidden");
}

$("#machine-cancel").addEventListener("click", resetMachineForm);
$("#sensor-cancel").addEventListener("click", resetSensorForm);

void registerAppShell();

$("#alerts").addEventListener("click", async (event) => {
  const historyButton = event.target.closest("button[data-alert-history]");
  if (historyButton) {
    const alertId = historyButton.dataset.alertHistory;
    const historyPanel = $(`#alert-history-${alertId}`);
    try {
      const history = await api(`/alerts/${alertId}/history`);
      historyPanel.innerHTML = history.map((item) => `<p><strong>${escapeHtml(item.action)}</strong> · ${formatDate(item.created_at)}${item.details ? ` · ${escapeHtml(item.details)}` : ""}${item.user_name ? ` · ${escapeHtml(item.user_name)}` : ""}</p>`).join("")
        || '<p class="empty">Aucun événement d’historique.</p>';
      historyPanel.classList.toggle("hidden", false);
    } catch (error) {
      historyPanel.innerHTML = `<p class="inline-error" role="alert">${escapeHtml(error.message)}</p>`;
      historyPanel.classList.remove("hidden");
    }
    return;
  }
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  try {
    const action = button.dataset.act;
    if (action === "false-positive") {
      await api(`/manager/alerts/${button.dataset.id}/false-positive`, { method: "POST" });
    } else {
      const endpoint = action === "ack" ? "acknowledge" : "close";
      await api(`/alerts/${button.dataset.id}/${endpoint}`, { method: "POST" });
    }
    showToast("Alerte mise à jour");
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

if (token && !resetToken) start();
