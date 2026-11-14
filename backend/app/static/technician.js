(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const pageTitles = {
    overview: ["Vue d'ensemble", "Suivez vos interventions et les équipements autorisés."],
    alerts: ["Mes alertes", "Consultez et prenez en charge les alertes de vos machines."],
    interventions: ["Mes interventions", "Consultez vos missions et renseignez leur avancement."],
    machines: ["Mes machines", "Consultez les équipements auxquels vous êtes autorisé à accéder."],
    measurements: ["Mesures des capteurs", "Analysez les valeurs et leur évolution sur une période."],
    failures: ["Historique des pannes", "Consultez les événements détectés et renseignez votre diagnostic."],
    notifications: ["Notifications", "Consultez les informations qui vous sont adressées."],
    offline: ["Mode hors ligne", "Consultez les dernières données en cache et préparez vos comptes rendus."],
    calibration: ["Calibration", "Consignez les mesures de référence et les observations des capteurs."],
    profile: ["Mon profil", "Gérez vos informations personnelles et la sécurité de votre compte."],
  };
  const metricInfo = {
    temperature: ["Température", "°C"],
    humidity: ["Humidité", "%"],
    vibration_rate: ["Vibrations", "événements/s"],
    current_rms: ["Courant", "A"],
  };
  const stateNames = {
    assigned: "Attribuée",
    accepted: "Acceptée",
    in_progress: "En cours",
    completed: "Terminée",
    cancelled: "Annulée",
    new: "Nouvelle",
    acknowledged: "Prise en charge",
    closed: "Clôturée",
  };
  let user = null;
  let currentPage = "overview";
  let refreshTimer = null;
  let selectedMeasurementMachine = "";

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const formatDate = (value) => value
    ? new Date(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
    : "—";
  const cacheKey = (path) => `pm-tech-cache:${user?.id}:${path}`;
  const offlineActionsKey = () => `pm-tech-actions:${user?.id}`;

  function cached(path) {
    if (!user) return null;
    try {
      const value = localStorage.getItem(cacheKey(path));
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error("Impossible de lire le cache local", error);
      return null;
    }
  }

  function cache(path, value) {
    if (!user) return;
    try {
      localStorage.setItem(cacheKey(path), JSON.stringify(value));
      localStorage.setItem(cacheKey("updated-at"), new Date().toISOString());
    } catch (error) {
      console.error("Impossible d'enregistrer le cache local", error);
    }
  }

  async function api(path, options = {}) {
    const isRead = !options.method || options.method === "GET";
    const storedPath = options.cacheKey || path;
    const { cacheKey: _cacheKey, ...fetchOptions } = options;
    try {
      const response = await fetch(`/api${path}`, {
        ...fetchOptions,
        headers: {
          "Content-Type": "application/json",
          ...(localStorage.getItem("pm_token")
            ? { Authorization: `Bearer ${localStorage.getItem("pm_token")}` }
            : {}),
          ...(options.headers || {}),
        },
      });
      if (response.status === 401) {
        $("#logout").click();
        throw new Error("Votre session a expiré. Reconnectez-vous.");
      }
      if (!response.ok) {
        let detail = "Une erreur est survenue.";
        try {
          const body = await response.json();
          detail = body.detail || detail;
        } catch (error) {
          console.error("Réponse API invalide", error);
        }
        throw new Error(detail);
      }
      if (response.status === 204) return null;
      const result = await response.json();
      if (isRead) cache(storedPath, result);
      updateConnectionState(true);
      return result;
    } catch (error) {
      if (isRead && error instanceof TypeError) {
        updateConnectionState(false);
        const previous = cached(storedPath);
        if (previous !== null) return previous;
      }
      throw error;
    }
  }

  function updateConnectionState(online = navigator.onLine) {
    $("#technician-connection").textContent = online ? "En ligne" : "Hors ligne";
    $("#technician-connection").classList.toggle("offline", !online);
    $("#technician-offline-banner").classList.toggle("hidden", online);
  }

  function toast(message) {
    $("#toast").textContent = message;
    $("#toast").classList.add("show");
    window.setTimeout(() => $("#toast").classList.remove("show"), 2800);
  }

  function pageError(error) {
    console.error(error);
    $("#technician-page").innerHTML =
      `<div class="inline-error" role="alert">${escapeHtml(error.message)}</div>`;
  }

  function metricCard(title, value, note) {
    return `<article class="admin-stat"><span>${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></article>`;
  }

  async function loadCommonData() {
    const results = await Promise.allSettled([
      api("/technician/overview"),
      api("/machines"),
      api("/alerts"),
      api("/interventions"),
      api("/failures"),
      api("/calibrations"),
      api("/notifications"),
    ]);
    const paths = [
      "/technician/overview",
      "/machines",
      "/alerts",
      "/interventions",
      "/failures",
      "/calibrations",
      "/notifications",
    ];
    const data = {};
    results.forEach((result, index) => {
      if (result.status === "fulfilled") data[paths[index]] = result.value;
      else {
        if (navigator.onLine) throw result.reason;
        data[paths[index]] = cached(paths[index]);
        if (data[paths[index]] === null) console.error(result.reason);
      }
    });
    const notifications = data["/notifications"] || [];
    const unread = notifications.filter((item) => !item.read).length;
    $("#tech-notification-count").textContent = String(unread);
    $("#tech-notification-count").classList.toggle("hidden", unread === 0);
    return data;
  }

  function machineName(machines, id) {
    return machines.find((item) => item.id === id)?.name || "Machine";
  }

  function alertRows(alerts, machines) {
    if (!alerts.length) return '<div class="empty-state">Aucune alerte à afficher.</div>';
    return alerts.map((alert) => `<article class="tech-list-row">
      <div class="tech-list-main">
        <div class="tech-row-title"><strong>${escapeHtml(machineName(machines, alert.machine_id))} · ${escapeHtml(metricInfo[alert.metric]?.[0] || alert.metric)}</strong>
          <span class="severity ${alert.severity === "critical" ? "critical" : ""}">${escapeHtml(alert.severity)}</span></div>
        <p>${escapeHtml(stateNames[alert.status] || alert.status)} · Valeur ${Number(alert.value).toLocaleString("fr-FR")} ${escapeHtml(metricInfo[alert.metric]?.[1] || "")}</p>
        <small>${formatDate(alert.created_at)}${alert.acknowledged_at ? ` · Prise en charge le ${formatDate(alert.acknowledged_at)}` : ""}</small>
      </div>
      ${alert.status === "new" ? `<button class="primary" data-alert-ack="${alert.id}">Prendre en charge</button>` : ""}
    </article>`).join("");
  }

  function interventionCard(item, machines) {
    const open = ["assigned", "accepted", "in_progress"].includes(item.status);
    const allowedStatuses = {
      assigned: ["assigned", "accepted", "in_progress"],
      accepted: ["accepted", "in_progress", "completed"],
      in_progress: ["in_progress", "completed"],
    }[item.status] || [item.status];
    return `<article class="tech-intervention-card">
      <div class="tech-row-title"><div><p class="eyebrow">${escapeHtml(machineName(machines, item.machine_id))}</p><h3>${escapeHtml(item.title)}</h3></div>
        <span class="status ${item.priority === "urgent" || item.priority === "high" ? "offline" : ""}">${escapeHtml(item.priority)}</span></div>
      <p class="tech-description">${escapeHtml(item.description)}</p>
      <div class="tech-meta"><span>${escapeHtml(stateNames[item.status] || item.status)}</span><span>Échéance : ${formatDate(item.due_at)}</span></div>
      ${open ? `<form class="intervention-update-form" data-intervention-id="${item.id}" data-revision="${item.revision}">
        <label>État<select name="status">
          ${allowedStatuses.map((state) =>
    `<option value="${state}" ${item.status === state ? "selected" : ""}>${escapeHtml(stateNames[state])}</option>`
  ).join("")}
        </select></label>
        <label>Diagnostic<textarea name="diagnosis" rows="2" maxlength="4000">${escapeHtml(item.diagnosis)}</textarea></label>
        <label>Travail réalisé<textarea name="work_done" rows="2" maxlength="4000">${escapeHtml(item.work_done)}</textarea></label>
        <label>Résultat<textarea name="result" rows="2" maxlength="4000">${escapeHtml(item.result)}</textarea></label>
        <button class="primary" type="submit">Enregistrer le suivi</button><span class="form-message muted" role="status"></span>
      </form>` : `<div class="tech-meta"><span>Diagnostic : ${escapeHtml(item.diagnosis || "Non renseigné")}</span><span>Résultat : ${escapeHtml(item.result || "Non renseigné")}</span></div>`}
    </article>`;
  }

  async function renderOverview(data) {
    const overview = data["/technician/overview"] || {};
    const machines = data["/machines"] || [];
    const alerts = data["/alerts"] || [];
    const interventions = data["/interventions"] || [];
    const latest = overview.latest;
    $("#technician-page").innerHTML = `
      ${machines.length ? "" : '<p class="callout">Aucune machine ne vous est actuellement attribuée. Contactez votre Responsable de maintenance pour recevoir une intervention et les autorisations nécessaires. Vos accès restent limités aux machines qui vous sont attribuées.</p>'}
      <div class="admin-stats">
        ${metricCard("Machines autorisées", overview.machine_count ?? "—", "équipements accessibles")}
        ${metricCard("Machines en ligne", overview.online_count ?? "—", "état de connexion")}
        ${metricCard("Alertes actives", overview.active_alert_count ?? "—", "sur vos machines")}
        ${metricCard("Interventions à suivre", overview.active_intervention_count ?? "—", `${overview.overdue_intervention_count ?? 0} en retard`)}
      </div>
      <div class="dashboard-grid">
        <section class="admin-card"><div class="admin-card-header"><h2>Mes alertes récentes</h2><button class="quiet" data-go="alerts">Tout consulter</button></div>
          <div class="admin-card-body">${alertRows(alerts.slice(0, 4), machines)}</div></section>
        <section class="admin-card"><div class="admin-card-header"><h2>Mes interventions</h2><button class="quiet" data-go="interventions">Tout consulter</button></div>
          <div class="admin-card-body">${interventions.slice(0, 4).map((item) => `<div class="activity-row"><time>${formatDate(item.due_at)}</time><span><strong>${escapeHtml(item.title)}</strong><br><span class="muted">${escapeHtml(machineName(machines, item.machine_id))}</span></span><span class="role-pill">${escapeHtml(stateNames[item.status] || item.status)}</span></div>`).join("") || '<div class="empty-state">Aucune intervention ne vous est attribuée.</div>'}</div></section>
        <section class="admin-card"><div class="admin-card-header"><h2>Dernière mesure reçue</h2><button class="quiet" data-go="measurements">Analyser les mesures</button></div>
          <div class="admin-card-body">${latest ? `<div class="tech-latest"><strong>${escapeHtml(machineName(machines, latest.machine_id))}</strong><span>${formatDate(latest.recorded_at)}</span>
            <div>${metricCard("Température", `${latest.temperature} °C`, "")}${metricCard("Humidité", `${latest.humidity} %`, "")}${metricCard("Vibrations", `${latest.vibration_rate} /s`, "")}${metricCard("Courant", `${latest.current_rms} A`, latest.current_source === "simulated" ? "Valeur simulée" : "Mesure matérielle")}</div></div>` : '<div class="empty-state">Aucune mesure récente pour vos machines.</div>'}</div></section>
      </div>`;
  }

  async function renderAlerts(data) {
    const machines = data["/machines"] || [];
    const alerts = data["/alerts"] || [];
    $("#technician-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Alertes de vos machines</h2><span>${alerts.length} événement(s)</span></div>
      <div class="admin-card-body"><div class="page-toolbar">
        <label>État<select id="alert-status-filter"><option value="">Tous les états</option><option value="new">Nouvelles</option><option value="acknowledged">Prises en charge</option><option value="closed">Clôturées</option></select></label>
        <label>Machine<select id="alert-machine-filter"><option value="">Toutes les machines</option>${machines.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></label>
      </div><div id="tech-alert-list">${alertRows(alerts, machines)}</div></div>
    </section>
    <section class="admin-card"><div class="admin-card-header"><h2>Historique des prises en charge</h2></div><div class="admin-card-body">
      ${alerts.filter((item) => item.acknowledged_at).map((item) => `<div class="activity-row"><time>${formatDate(item.acknowledged_at)}</time><span>${escapeHtml(machineName(machines, item.machine_id))} · ${escapeHtml(metricInfo[item.metric]?.[0] || item.metric)}</span><span class="role-pill">${escapeHtml(stateNames[item.status] || item.status)}</span></div>`).join("") || '<div class="empty-state">Aucune alerte prise en charge.</div>'}
    </div></section>`;
    const applyFilters = () => {
      const state = $("#alert-status-filter").value;
      const machine = $("#alert-machine-filter").value;
      const filtered = alerts.filter((item) => (!state || item.status === state) && (!machine || item.machine_id === machine));
      $("#tech-alert-list").innerHTML = alertRows(filtered, machines);
    };
    $("#alert-status-filter").addEventListener("change", applyFilters);
    $("#alert-machine-filter").addEventListener("change", applyFilters);
  }

  async function renderInterventions(data) {
    const interventions = data["/interventions"] || [];
    const machines = data["/machines"] || [];
    $("#technician-page").innerHTML = `<div class="page-intro"><div><h2>Interventions qui vous sont attribuées</h2><p>Enregistrez votre diagnostic, les opérations réalisées et leur résultat.</p></div></div>
      <div class="tech-intervention-grid">${interventions.map((item) => interventionCard(item, machines)).join("") || '<div class="empty-state">Aucune intervention ne vous est attribuée.</div>'}</div>`;
    document.querySelectorAll(".intervention-update-form").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        const message = $(".form-message", form);
        try {
          await api(`/interventions/${form.dataset.interventionId}`, {
            method: "PATCH",
            body: JSON.stringify({ ...values, expected_revision: Number(form.dataset.revision) }),
          });
          toast("Le suivi de votre intervention a été enregistré.");
          await render();
        } catch (error) {
          message.textContent = error.message;
          message.classList.add("error");
        }
      });
    });
  }

  async function renderMachines(data) {
    const machines = data["/machines"] || [];
    const alerts = data["/alerts"] || [];
    const interventions = data["/interventions"] || [];
    $("#technician-page").innerHTML = `<div class="tech-machine-grid">${machines.map((machine) => {
      const machineAlerts = alerts.filter((item) => item.machine_id === machine.id && item.status !== "closed").length;
      const machineInterventions = interventions.filter((item) => item.machine_id === machine.id && !["completed", "cancelled"].includes(item.status)).length;
      return `<article class="tech-intervention-card"><div class="tech-row-title"><h3>${escapeHtml(machine.name)}</h3>
        <span class="status ${machine.status === "online" ? "" : "offline"}">${machine.status === "online" ? "En ligne" : "Hors ligne"}</span></div>
        <p>${escapeHtml(machine.description || "Aucune description renseignée.")}</p>
        <div class="tech-meta"><span>${machineAlerts} alerte(s) active(s)</span><span>${machineInterventions} intervention(s) en cours</span></div>
        <small>Dernière mesure : ${formatDate(machine.last_seen)}</small>
        <button class="quiet" data-machine-measure="${escapeHtml(machine.id)}">Consulter les mesures</button>
      </article>`;
    }).join("") || '<div class="empty-state">Aucune machine ne vous est attribuée. Contactez votre Responsable de maintenance.</div>'}</div>`;
    document.querySelectorAll("[data-machine-measure]").forEach((button) => {
      button.addEventListener("click", () => navigate("measurements", button.dataset.machineMeasure));
    });
  }

  function drawChart(rows, metric) {
    const values = rows.map((row) => Number(row[metric])).filter(Number.isFinite);
    if (values.length < 2) return '<div class="empty-state">Deux mesures au minimum sont nécessaires pour tracer une évolution.</div>';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((value, index) =>
      `${(index / (values.length - 1)) * 100},${94 - ((value - min) / range) * 84}`
    ).join(" ");
    const [label, unit] = metricInfo[metric];
    return `<svg class="measurement-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Évolution de ${escapeHtml(label)}">
      <polyline points="${points}" fill="none" stroke="#287271" stroke-width="2.5" vector-effect="non-scaling-stroke" />
    </svg><div class="chart-caption"><span>${formatDate(rows[0].recorded_at)}</span><strong>${escapeHtml(label)} (${escapeHtml(unit)})</strong><span>${formatDate(rows[rows.length - 1].recorded_at)}</span></div>`;
  }

  async function renderMeasurements(data, preselectedMachine = "") {
    const machines = data["/machines"] || [];
    selectedMeasurementMachine = preselectedMachine || selectedMeasurementMachine || machines[0]?.id || "";
    $("#technician-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Historique des mesures</h2></div><div class="admin-card-body">
        <form id="measurement-filter" class="page-toolbar">
          <label>Machine<select name="machine_id" required>${machines.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedMeasurementMachine ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>
          <label>Capteur<select name="metric">${Object.entries(metricInfo).map(([key, item]) => `<option value="${key}">${escapeHtml(item[0])}</option>`).join("")}</select></label>
          <label>Période<select name="period"><option value="24">Dernières 24 heures</option><option value="168">7 derniers jours</option><option value="720">30 derniers jours</option></select></label>
          <button class="primary" type="submit">Afficher</button>
        </form>
        <div id="measurement-summary"></div>
      </div></section>`;
    const form = $("#measurement-filter");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      loadMeasurements(new FormData(form));
    });
    if (machines.length) await loadMeasurements(new FormData(form));
  }

  async function loadMeasurements(form) {
    const machineId = form.get("machine_id");
    const metric = form.get("metric");
    const hours = Number(form.get("period"));
    selectedMeasurementMachine = machineId;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), limit: "1000" });
    const container = $("#measurement-summary");
    container.innerHTML = '<div class="empty-state">Chargement des mesures…</div>';
    try {
      const [rows, thresholds] = await Promise.all([
        api(`/machines/${encodeURIComponent(machineId)}/telemetry?${query}`, {
          cacheKey: `/measurements:${machineId}:${metric}:${hours}`,
        }),
        api(`/thresholds/${encodeURIComponent(machineId)}`),
      ]);
      const values = rows.map((row) => Number(row[metric])).filter(Number.isFinite);
      const minimum = values.length ? Math.min(...values) : null;
      const maximum = values.length ? Math.max(...values) : null;
      const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const threshold = thresholds.find((item) => item.metric === metric);
      const unit = metricInfo[metric][1];
      const above = threshold ? values.filter((value) => value >= threshold.warning).length : 0;
      container.innerHTML = `${values.length ? `<div class="admin-stats">
        ${metricCard("Minimum", `${minimum.toFixed(2)} ${unit}`, "sur la période")}
        ${metricCard("Maximum", `${maximum.toFixed(2)} ${unit}`, "sur la période")}
        ${metricCard("Moyenne", `${average.toFixed(2)} ${unit}`, "sur la période")}
        ${metricCard("Au-dessus du seuil", above, "valeur(s)")}
      </div><div class="chart-panel">${drawChart(rows, metric)}</div>
      <div class="table-wrap"><table class="admin-table"><thead><tr><th>Date / heure</th><th>${escapeHtml(metricInfo[metric][0])}</th><th>Mode d'acquisition</th></tr></thead>
        <tbody>${rows.slice().reverse().map((row) => `<tr><td>${formatDate(row.recorded_at)}</td><td>${Number(row[metric]).toLocaleString("fr-FR")} ${escapeHtml(unit)}</td><td>${row.acquisition_mode === "simulated" ? "Simulé" : "Matériel"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-state">Aucune mesure disponible pour cette machine sur la période choisie.</div>'}`;
    } catch (error) {
      container.innerHTML = `<div class="inline-error" role="alert">${escapeHtml(error.message)}</div>`;
    }
  }

  async function renderFailures(data) {
    const failures = data["/failures"] || [];
    const machines = data["/machines"] || [];
    $("#technician-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Événements critiques détectés</h2><span>${failures.length} événement(s)</span></div>
      <div class="admin-card-body"><p class="callout">Un dépassement de seuil nécessite un diagnostic ; il ne confirme pas à lui seul une panne matérielle.</p>
        <div class="page-toolbar">
          <label>Machine<select id="failure-machine-filter"><option value="">Toutes les machines</option>${machines.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></label>
          <label>Type<select id="failure-type-filter"><option value="">Tous les types</option>${Object.entries(metricInfo).map(([key, value]) => `<option value="${key}">${escapeHtml(value[0])}</option>`).join("")}</select></label>
          <label>Période<select id="failure-period-filter"><option value="">Toute la période</option><option value="7">7 derniers jours</option><option value="30">30 derniers jours</option></select></label>
        </div><div id="failure-list">${failures.map((item) => `<form class="failure-form tech-intervention-card" data-failure-id="${item.id}" data-machine="${escapeHtml(item.machine_id)}" data-type="${escapeHtml(item.failure_type)}" data-detected="${escapeHtml(item.detected_at)}">
          <div class="tech-row-title"><div><p class="eyebrow">${escapeHtml(machineName(machines, item.machine_id))} · ${escapeHtml(metricInfo[item.failure_type]?.[0] || item.failure_type)}</p><h3>${formatDate(item.detected_at)}</h3></div>
            <span class="status ${item.resolved_at ? "" : "offline"}">${item.resolved_at ? "Résolu" : "À diagnostiquer"}</span></div>
          <p>${escapeHtml(item.description)}</p>
          <label>Diagnostic<textarea name="diagnosis" rows="2" maxlength="4000">${escapeHtml(item.diagnosis)}</textarea></label>
          <label>Intervention réalisée<textarea name="intervention" rows="2" maxlength="4000">${escapeHtml(item.intervention)}</textarea></label>
          <label>Résultat<textarea name="result" rows="2" maxlength="4000">${escapeHtml(item.result)}</textarea></label>
          <button class="primary" type="submit">Enregistrer le diagnostic</button><span class="form-message muted" role="status"></span>
        </form>`).join("") || '<div class="empty-state">Aucun événement critique n’est enregistré.</div>'}</div>
      </div></section>`;
    const filterFailures = () => {
      const machine = $("#failure-machine-filter").value;
      const type = $("#failure-type-filter").value;
      const days = Number($("#failure-period-filter").value || 0);
      const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      document.querySelectorAll(".failure-form").forEach((form) => {
        const matches = (!machine || form.dataset.machine === machine)
          && (!type || form.dataset.type === type)
          && (!since || new Date(form.dataset.detected).getTime() >= since);
        form.classList.toggle("hidden", !matches);
      });
    };
    ["failure-machine-filter", "failure-type-filter", "failure-period-filter"].forEach((id) =>
      $(`#${id}`).addEventListener("change", filterFailures)
    );
    document.querySelectorAll(".failure-form").forEach((form) => form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = $(".form-message", form);
      try {
        await api(`/failures/${form.dataset.failureId}`, {
          method: "PATCH",
          body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        toast("Le diagnostic a été enregistré.");
        await render();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    }));
  }

  async function renderNotifications(data) {
    const notifications = data["/notifications"] || [];
    $("#technician-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Centre de notifications</h2><span>${notifications.filter((item) => !item.read).length} non lue(s)</span></div>
      <div class="admin-card-body">${notifications.map((item) => `<article class="notification-card ${item.read ? "read" : "unread"}">
        <div><strong>${escapeHtml(item.message)}</strong><p>${formatDate(item.created_at)}</p></div>
        <div class="actions">${item.target_type === "intervention" ? `<button class="quiet" data-notification-go="interventions">Consulter</button>` : ""}
          ${!item.read ? `<button class="quiet" data-notification-read="${escapeHtml(item.id)}">Marquer comme lue</button>` : ""}</div>
      </article>`).join("") || '<div class="empty-state">Vous n’avez aucune notification.</div>'}</div>
    </section>`;
  }

  function readOfflineActions() {
    try {
      return JSON.parse(localStorage.getItem(offlineActionsKey()) || "[]");
    } catch (error) {
      console.error("Impossible de lire les comptes rendus en attente", error);
      return [];
    }
  }

  function saveOfflineActions(actions) {
    localStorage.setItem(offlineActionsKey(), JSON.stringify(actions));
  }

  async function renderOffline(data) {
    const actions = readOfflineActions();
    const interventions = data["/interventions"] || [];
    const updatedAt = cached("updated-at");
    $("#technician-page").innerHTML = `<div class="admin-stats">
      ${metricCard("Connexion", navigator.onLine ? "Disponible" : "Indisponible", "état de votre navigateur")}
      ${metricCard("Comptes rendus en attente", actions.length, "stockés sur cet appareil")}
      ${metricCard("Dernier cache", updatedAt ? formatDate(updatedAt) : "—", "données autorisées")}
    </div><section class="admin-card"><div class="admin-card-header"><h2>Préparer un compte rendu hors ligne</h2></div><div class="admin-card-body">
      <p class="callout">Un brouillon reste sur cet appareil. Il n’est pas enregistré sur le serveur avant confirmation de la synchronisation.</p>
      <form id="offline-report-form">
        <label>Intervention<select name="intervention_id" required>${interventions.filter((item) => !["completed", "cancelled"].includes(item.status)).map((item) => `<option value="${item.id}">${escapeHtml(item.title)} · ${escapeHtml(item.assigned_to_name || "Vous")}</option>`).join("")}</select></label>
        <label>Diagnostic<textarea name="diagnosis" rows="2" maxlength="4000"></textarea></label>
        <label>Travail réalisé<textarea name="work_done" rows="3" maxlength="4000" required></textarea></label>
        <label>Résultat<textarea name="result" rows="2" maxlength="4000"></textarea></label>
        <button class="primary" type="submit">Enregistrer le brouillon sur cet appareil</button><p id="offline-report-message" class="muted" role="status"></p>
      </form></div></section>
      <section class="admin-card"><div class="admin-card-header"><h2>Synchronisation des brouillons</h2><button id="offline-sync" class="primary" type="button" ${navigator.onLine ? "" : "disabled"}>Synchroniser</button></div>
        <div class="admin-card-body" id="offline-actions-list">${actions.map((item) => {
    const latest = interventions.find((entry) => entry.id === item.intervention_id);
    return `<article class="tech-intervention-card offline-action-card" data-action-id="${escapeHtml(item.client_action_id)}">
      <div class="tech-row-title"><strong>${escapeHtml(item.title)}</strong><span class="status offline">En attente du serveur</span></div>
      <p>Enregistré sur cet appareil · ${formatDate(item.created_at)}</p>
      ${item.conflict ? `<p class="inline-error">${escapeHtml(item.conflict)}<br>Version actuelle : ${latest ? `mise à jour ${formatDate(latest.updated_at)}, révision ${latest.revision}` : "indisponible hors ligne"}.</p>
        ${latest ? `<div class="callout"><strong>Diagnostic sur le serveur :</strong> ${escapeHtml(latest.diagnosis || "Non renseigné")}<br><strong>Travail sur le serveur :</strong> ${escapeHtml(latest.work_done || "Non renseigné")}<br><strong>Résultat sur le serveur :</strong> ${escapeHtml(latest.result || "Non renseigné")}</div>` : ""}` : ""}
      <form class="offline-draft-form">
        <label>Diagnostic du brouillon<textarea name="diagnosis" rows="2" maxlength="4000">${escapeHtml(item.diagnosis)}</textarea></label>
        <label>Travail réalisé<textarea name="work_done" rows="2" maxlength="4000">${escapeHtml(item.work_done)}</textarea></label>
        <label>Résultat<textarea name="result" rows="2" maxlength="4000">${escapeHtml(item.result)}</textarea></label>
        <button class="quiet" type="submit">Enregistrer le brouillon</button><span class="form-message muted" role="status"></span>
      </form>
      ${item.conflict && latest && navigator.onLine ? `<button class="primary" type="button" data-offline-rebase="${escapeHtml(item.client_action_id)}">J’ai vérifié les deux versions : préparer une nouvelle synchronisation</button>` : ""}
    </article>`;
  }).join("") || '<div class="empty-state">Aucun compte rendu en attente.</div>'}</div>
      </section>`;
    $("#offline-report-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const intervention = interventions.find((item) => item.id === Number(form.get("intervention_id")));
      if (!intervention) return;
      const draft = {
        client_action_id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        intervention_id: intervention.id,
        expected_revision: intervention.revision,
        title: intervention.title,
        diagnosis: form.get("diagnosis"),
        work_done: form.get("work_done"),
        result: form.get("result"),
        created_at: new Date().toISOString(),
      };
      saveOfflineActions([...readOfflineActions(), draft]);
      $("#offline-report-message").textContent = "Le brouillon est enregistré sur cet appareil, pas sur le serveur.";
      render();
    });
    $("#offline-sync").addEventListener("click", syncOfflineActions);
    document.querySelectorAll(".offline-draft-form").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      const card = form.closest("[data-action-id]");
      const values = Object.fromEntries(new FormData(form));
      const actionsNow = readOfflineActions();
      const draft = actionsNow.find((item) => item.client_action_id === card.dataset.actionId);
      if (!draft) return;
      Object.assign(draft, values);
      saveOfflineActions(actionsNow);
      $(".form-message", form).textContent = "Le brouillon local a été mis à jour.";
    }));
    document.querySelectorAll("[data-offline-rebase]").forEach((button) => button.addEventListener("click", () => {
      const actionsNow = readOfflineActions();
      const draft = actionsNow.find((item) => item.client_action_id === button.dataset.offlineRebase);
      if (!draft) return;
      const current = interventions.find((item) => item.id === draft.intervention_id);
      if (!current) return;
      draft.expected_revision = current.revision;
      delete draft.conflict;
      saveOfflineActions(actionsNow);
      toast("Vérifiez le brouillon puis synchronisez-le avec la version actuelle.");
      render();
    }));
  }

  async function syncOfflineActions() {
    if (!navigator.onLine) {
      toast("La connexion est indisponible. Le brouillon reste sur cet appareil.");
      return;
    }
    const actions = readOfflineActions();
    const remaining = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      try {
        await api(`/interventions/${action.intervention_id}`, {
          method: "PATCH",
          body: JSON.stringify({
            diagnosis: action.diagnosis,
            work_done: action.work_done,
            result: action.result,
            expected_revision: action.expected_revision,
            client_action_id: action.client_action_id,
          }),
        });
      } catch (error) {
        remaining.push(action, ...actions.slice(index + 1));
        if (error.message.includes("modifiée depuis")) {
          action.conflict = error.message;
        }
        break;
      }
    }
    saveOfflineActions(remaining);
    if (remaining.length) {
      toast("Certains brouillons restent en attente. Vérifiez les conflits ou la connexion.");
    } else if (actions.length) {
      toast("Vos comptes rendus ont été confirmés par le serveur.");
    }
    await render();
  }

  async function renderCalibration(data) {
    const machines = data["/machines"] || [];
    const calibrations = data["/calibrations"] || [];
    const machineOptions = machines.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
    $("#technician-page").innerHTML = `<section class="admin-card form-card">
      <div class="admin-card-header"><h2>Consigner une calibration</h2></div><div class="admin-card-body">
        <p class="callout">Cette fiche conserve les valeurs et observations. Elle ne modifie ni le firmware ni les seuils de la machine.</p>
        <form id="calibration-form">
          <label>Machine<select name="machine_id" id="calibration-machine" required>${machineOptions}</select></label>
          <label>Capteur<select name="sensor_id" id="calibration-sensor" required></select></label>
          <div class="form-grid"><label>Valeur de référence<input name="reference_value" type="number" step="any" required></label>
            <label>Valeur mesurée<input name="measured_value" type="number" step="any" required></label></div>
          <label>Observations<textarea name="observations" rows="3" maxlength="2000"></textarea></label>
          <button class="primary" type="submit">Enregistrer la calibration</button><span id="calibration-message" class="muted" role="status"></span>
        </form>
      </div></section>
      <section class="admin-card"><div class="admin-card-header"><h2>Historique des calibrations</h2></div><div class="admin-card-body">
        <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Date</th><th>Machine</th><th>Capteur</th><th>Référence</th><th>Mesure</th><th>Observations</th></tr></thead>
          <tbody>${calibrations.map((item) => `<tr><td>${formatDate(item.created_at)}</td><td>${escapeHtml(machineName(machines, item.machine_id))}</td><td>${item.sensor_id}</td><td>${item.reference_value}</td><td>${item.measured_value}</td><td>${escapeHtml(item.observations || "—")}</td></tr>`).join("") || '<tr><td colspan="6" class="empty-state">Aucune calibration enregistrée.</td></tr>'}</tbody></table></div>
      </div></section>`;
    async function loadSensors() {
      const machineId = $("#calibration-machine").value;
      const sensors = machineId ? await api(`/machines/${encodeURIComponent(machineId)}/sensors`) : [];
      $("#calibration-sensor").innerHTML = sensors.filter((item) => item.enabled).map((item) =>
        `<option value="${item.id}">${escapeHtml(metricInfo[item.metric]?.[0] || item.metric)} · ${escapeHtml(item.sensor_type)} (${escapeHtml(item.unit)})</option>`
      ).join("");
      if (!sensors.length) $("#calibration-message").textContent = "Aucun capteur actif n’est déclaré pour cette machine.";
    }
    $("#calibration-machine").addEventListener("change", () => loadSensors().catch(pageError));
    await loadSensors();
    $("#calibration-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const message = $("#calibration-message");
      try {
        await api("/calibrations", {
          method: "POST",
          body: JSON.stringify({
            ...values,
            sensor_id: Number(values.sensor_id),
            reference_value: Number(values.reference_value),
            measured_value: Number(values.measured_value),
          }),
        });
        toast("La calibration a été consignée.");
        await render();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
  }

  async function renderProfile() {
    await window.PrediMaintProfile.render({
      container: "#technician-page",
      api,
      showToast: toast,
      onProfileUpdated: (updated) => {
        user = updated;
        $("#technician-header-name").textContent = updated.full_name || updated.email;
        $("#technician-avatar").textContent = String(updated.full_name || "T").trim()
          .split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      },
      onPasswordChanged: () => window.setTimeout(() => $("#logout").click(), 1200),
    });
  }

  async function render() {
    currentPage = pageTitles[currentPage] ? currentPage : "overview";
    const [title, subtitle] = pageTitles[currentPage];
    $("#technician-page-title").textContent = title;
    $("#technician-page-subtitle").textContent = subtitle;
    document.querySelectorAll("[data-tech-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.techPage === currentPage);
    });
    $(".technician-sidebar").classList.remove("open");
    try {
      const data = await loadCommonData();
      switch (currentPage) {
        case "overview": await renderOverview(data); break;
        case "alerts": await renderAlerts(data); break;
        case "interventions": await renderInterventions(data); break;
        case "machines": await renderMachines(data); break;
        case "measurements": await renderMeasurements(data); break;
        case "failures": await renderFailures(data); break;
        case "notifications": await renderNotifications(data); break;
        case "offline": await renderOffline(data); break;
        case "calibration": await renderCalibration(data); break;
        case "profile": await renderProfile(); break;
        default: await renderOverview(data);
      }
    } catch (error) {
      pageError(error);
    }
  }

  function navigate(page, machineId = "") {
    if (!pageTitles[page]) return;
    if (machineId) selectedMeasurementMachine = machineId;
    currentPage = page;
    if (location.hash !== `#tech-${page}`) location.hash = `tech-${page}`;
    else render();
  }

  document.querySelectorAll("[data-tech-page]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.techPage));
  });
  $("#technician-page").addEventListener("click", async (event) => {
    const goButton = event.target.closest("[data-go]");
    if (goButton) {
      navigate(goButton.dataset.go);
      return;
    }
    const ackButton = event.target.closest("[data-alert-ack]");
    if (ackButton) {
      try {
        await api(`/alerts/${ackButton.dataset.alertAck}/acknowledge`, { method: "POST" });
        toast("L’alerte est prise en charge.");
        await render();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const readButton = event.target.closest("[data-notification-read]");
    if (readButton) {
      try {
        await api(`/notifications/${encodeURIComponent(readButton.dataset.notificationRead)}/read`, { method: "POST" });
        await render();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const notificationGo = event.target.closest("[data-notification-go]");
    if (notificationGo) navigate(notificationGo.dataset.notificationGo);
  });
  $("#technician-menu-toggle").addEventListener("click", () => $(".technician-sidebar").classList.toggle("open"));
  $("#technician-logout").addEventListener("click", () => $("#logout").click());
  window.addEventListener("hashchange", () => {
    if ($("#technician-app").classList.contains("hidden") || !location.hash.startsWith("#tech-")) return;
    const page = location.hash.replace(/^#tech-/, "");
    if (pageTitles[page]) {
      currentPage = page;
      render();
    }
  });
  window.addEventListener("online", () => {
    updateConnectionState(true);
    syncOfflineActions().catch((error) => console.error("Synchronisation impossible", error));
    render();
  });
  window.addEventListener("offline", () => {
    updateConnectionState(false);
    render();
  });
  window.addEventListener("predimaint:logout", () => {
    if (!user) return;
    const prefix = `pm-tech-cache:${user.id}:`;
    Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key));
    user = null;
    window.clearInterval(refreshTimer);
  });
  window.addEventListener("predimaint:technician-authenticated", (event) => {
    user = event.detail;
    $("#technician-header-name").textContent = user.full_name || user.email;
    $("#technician-avatar").textContent = String(user.full_name || "T").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    updateConnectionState();
    const hashPage = location.hash.replace(/^#tech-/, "");
    currentPage = pageTitles[hashPage] ? hashPage : "overview";
    if (currentPage === "overview" && location.hash !== "#tech-overview") location.hash = "tech-overview";
    else render();
    window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(render, 30000);
  });
})();
