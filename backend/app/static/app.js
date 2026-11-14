const $ = (selector) => document.querySelector(selector);
let token = localStorage.getItem("pm_token");
let role = localStorage.getItem("pm_role");
let refreshTimer = null;
let machineId = "";
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
    await navigator.serviceWorker.register("/service-worker.js?v=9", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch (error) {
    console.error("La mise en cache de l’interface est indisponible", error);
  }
}

function showToast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 2600);
}

function logout() {
  if (typeof window.predimaintBeforeLogout === "function" && !window.predimaintBeforeLogout()) return;
  window.dispatchEvent(new CustomEvent("predimaint:logout"));
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

function formatMachine(machine) {
  return `<div class="alert"><span><strong>${escapeHtml(machine.name)}</strong><br>
    <small class="muted">${machine.last_seen ? `Dernière mesure : ${new Date(machine.last_seen).toLocaleString("fr-FR")}` : "Aucune mesure reçue"}</small></span>
    <span class="status ${machine.status === "online" ? "" : "offline"}">${machine.status === "online" ? "En ligne" : "Hors ligne"}${machine.active ? "" : " · Archivée"}</span></div>`;
}

async function refreshAssets(machines) {
  if (role !== "manager") return;
  const machineOptions = machines.map((machine) => `<option value="${escapeHtml(machine.id)}">${escapeHtml(machine.name)}</option>`).join("");
  const sensorSelect = $("#sensor-machine-select");
  const previous = sensorSelect.value || machineId;
  sensorSelect.innerHTML = machineOptions;
  if (machines.some((machine) => machine.id === previous)) sensorSelect.value = previous;

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
  if (role !== "manager" || !machineId) return;
  const metric = $("#threshold-form [name=metric]").value;
  const thresholds = await api(`/thresholds/${encodeURIComponent(machineId)}`);
  const threshold = thresholds.find((item) => item.metric === metric);
  $("#threshold-form [name=warning]").value = threshold ? threshold.warning : "";
  $("#threshold-form [name=critical]").value = threshold ? threshold.critical : "";
}

async function refresh() {
  try {
    const [dashboard, machines, alerts] = await Promise.all([
      api("/dashboard"), api("/machines"), api("/alerts"),
    ]);
    const notifications = await api("/admin/notifications/me");
    $("#user-notifications").innerHTML = notifications.map((item) => `<div class="alert">
      <span>${escapeHtml(item.message)}<br><small class="muted">${new Date(item.created_at).toLocaleString("fr-FR")}</small></span>
      <span class="status ${item.delivery_status === "failed" ? "offline" : ""}">${escapeHtml(item.delivery_status)}</span>
    </div>`).join("") || '<p class="empty">Aucune notification.</p>';
    $("#cards").innerHTML = [
      metricCard("Machines en ligne", `${dashboard.online_count}/${dashboard.machine_count}`, "unités", "état du parc"),
      metricCard("Alertes actives", dashboard.active_alert_count, "événements", "seuils"),
      metricCard("Température", dashboard.latest ? fmt(dashboard.latest.temperature) : "—", "°C", "dernière lecture"),
      metricCard("Vibration", dashboard.latest ? fmt(dashboard.latest.vibration_rate) : "—", "événements/s", "sortie numérique"),
    ].join("");

    $("#machine-select").innerHTML = machines.map((machine) => `<option value="${escapeHtml(machine.id)}">${escapeHtml(machine.name)}</option>`).join("");
    if (machines.some((machine) => machine.id === machineId)) $("#machine-select").value = machineId;
    else machineId = machines[0]?.id || "";
    if (machineId) $("#machine-select").value = machineId;
    $("#machine-list").innerHTML = machines.map(formatMachine).join("") || '<p class="empty">Aucune machine active.</p>';

    if (machineId) {
      const measurements = await api(`/machines/${encodeURIComponent(machineId)}/telemetry?limit=20`);
      $("#measurements").innerHTML = measurements.slice().reverse().map((item) => `<tr>
        <td>${new Date(item.recorded_at).toLocaleTimeString("fr-FR")}</td><td>${fmt(item.temperature)}</td>
        <td>${fmt(item.humidity)}</td><td>${fmt(item.vibration_rate, 2)}</td><td>${fmt(item.current_rms, 2)}</td>
        <td>${item.current_source === "simulated" ? "Courant simulé" : "ACS712"}</td></tr>`).join("")
        || '<tr><td colspan="6" class="empty">En attente de mesures MQTT.</td></tr>';
    } else {
      $("#measurements").innerHTML = '<tr><td colspan="6" class="empty">Aucune machine active.</td></tr>';
    }

    $("#alerts").innerHTML = alerts.map((alert) => `<div class="alert">
      <span><strong>${escapeHtml(alert.machine_name || "Machine")}</strong> · ${escapeHtml(alert.metric)} = ${fmt(alert.value)}<br>
      <small class="muted">${new Date(alert.created_at).toLocaleString("fr-FR")} · ${escapeHtml(alert.status)}</small></span>
      <span class="severity ${alert.severity === "critical" ? "critical" : ""}">${escapeHtml(alert.severity)}</span>
      <span class="actions">${role !== "director" && alert.status !== "closed" ? `<button data-act="ack" data-id="${alert.id}">Acquitter</button><button data-act="close" data-id="${alert.id}">Clôturer</button>` : ""}</span>
    </div>`).join("") || '<p class="empty">Aucune alerte.</p>';

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
          const deadline = item.due_at ? new Date(item.due_at).toLocaleString("fr-FR") : "Non définie";
          return `<div class="asset-row"><span><strong>${escapeHtml(item.title)}</strong>
            <div class="asset-meta">${escapeHtml(machine ? machine.name : item.machine_id)} · ${escapeHtml(item.assigned_to_name || "Non attribuée")} · Échéance : ${escapeHtml(deadline)}</div></span>
            <span class="status ${item.status === "completed" || item.status === "cancelled" ? "offline" : ""}">${escapeHtml(statuses[item.status] || item.status)}</span></div>`;
        }).join("") || '<p class="empty">Aucune intervention enregistrée.</p>';
      } catch (error) {
        $("#manager-interventions").innerHTML = `<p class="inline-error" role="alert">${escapeHtml(error.message)}</p>`;
      }
    }

    await refreshAssets(machines);
  } catch (error) {
    console.error(error);
  }
}

async function showManagerPage(page) {
  const pages = {
    overview: ["Vue d'ensemble", "Suivez l'état du parc et les mesures récentes."],
    alerts: ["Alertes", "Consultez et traitez les événements de vos équipements."],
    interventions: ["Interventions", "Attribuez le travail et suivez son avancement."],
    equipment: ["Parc et capteurs", "Gérez les équipements et les capteurs enregistrés."],
    thresholds: ["Seuils d'alerte", "Configurez les limites de surveillance des mesures."],
    performance: ["Performance", "Consultez les indicateurs lorsque les données nécessaires sont disponibles."],
    profile: ["Mon profil", "Gérez vos informations personnelles et la sécurité de votre compte."],
  };
  if (!Object.prototype.hasOwnProperty.call(pages, page)) return;
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
  }
}

async function start() {
  try {
    const me = await api("/auth/me");
    role = me.role;
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
$("#machine-select").addEventListener("change", async (event) => {
  machineId = event.target.value;
  await refresh();
  await loadThresholdForm();
});
$("#sensor-machine-select").addEventListener("change", () => refresh());
$("#threshold-form [name=metric]").addEventListener("change", () => loadThresholdForm());

$("#threshold-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const metric = form.get("metric");
  try {
    await api(`/thresholds/${encodeURIComponent(machineId)}/${metric}`, {
      method: "PUT",
      body: JSON.stringify({ warning: Number(form.get("warning")), critical: Number(form.get("critical")) }),
    });
    $("#threshold-message").textContent = "Seuil enregistré.";
    showToast("Seuil enregistré");
  } catch (error) {
    $("#threshold-message").textContent = error.message;
  }
});

$("#machine-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const body = { name: form.get("name"), description: form.get("description"), active: editingMachineActive };
    await api(editingMachineId ? `/machines/${encodeURIComponent(editingMachineId)}` : "/machines", {
      method: editingMachineId ? "PUT" : "POST",
      body: JSON.stringify(editingMachineId ? body : { id: form.get("id"), ...body }),
    });
    resetMachineForm();
    event.currentTarget.reset();
    $("#machine-message").textContent = "Machine déclarée.";
    showToast("Machine ajoutée");
    await refresh();
  } catch (error) {
    $("#machine-message").textContent = error.message;
  }
});

$("#assignment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const dueAt = form.get("due_at");
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
      }),
    });
    event.currentTarget.reset();
    $("#assignment-message").textContent = "L'intervention a été attribuée.";
    showToast("Intervention attribuée");
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
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  try {
    const action = button.dataset.act === "ack" ? "acknowledge" : "close";
    await api(`/alerts/${button.dataset.id}/${action}`, { method: "POST" });
    showToast("Alerte mise à jour");
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

if (token && !resetToken) start();
