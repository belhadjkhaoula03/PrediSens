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
    vibration_edges: ["Événements de vibration", "événements"],
    current_rms: ["Courant", "A"],
  };
  const measurementUi = window.PrediMaintMeasurements;
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
  let renderInFlight = false;
  let renderQueued = false;
  let renderVersion = 0;
  let measurementRequestId = 0;
  let measurementController = null;
  const measurementThresholdCache = new Map();
  let overviewMeasurementRefreshInFlight = false;
  let overviewMeasurementRequestId = 0;
  let technicianMachines = [];
  let lastGeneralRefreshAt = 0;
  let selectedMeasurementMode = "hardware";
  let selectedMeasurementMetric = "temperature";
  let selectedAlertMode = "hardware";
  let selectedMeasurementMachine = "";
  let selectedInterventionStatus = "all";
  let pushVapidPublicKey = "";
  let pushSubscription = null;
  const photoObjectUrls = new Set();

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const formatDate = (value) => measurementUi.formatDate(value);
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

  function cachedUpdatedAt() {
    if (!user) return null;
    try {
      return localStorage.getItem(cacheKey("updated-at"));
    } catch (error) {
      console.error("Impossible de lire la date du cache local", error);
      return null;
    }
  }

  function hasUnsavedOfflineChanges() {
    const forms = document.querySelectorAll("#offline-report-form, .offline-draft-form");
    return Array.from(forms).some((form) =>
      Array.from(form.elements).some((field) => {
        if (field.tagName === "SELECT") {
          return Array.from(field.options).some((option) => option.selected !== option.defaultSelected);
        }
        return field.value !== field.defaultValue;
      })
    );
  }

  function cache(path, value) {
    if (!user) return;
    try {
      const receivedAt = Date.now();
      const addReceiptTime = (item) => {
        if (Array.isArray(item)) return item.map(addReceiptTime);
        if (!item || typeof item !== "object") return item;
        const copy = { ...item };
        if (copy.recorded_at || copy.measurement_recorded_at) {
          if (!Number.isFinite(copy._client_received_at)) copy._client_received_at = receivedAt;
        }
        Object.keys(copy).forEach((key) => {
          if (copy[key] && typeof copy[key] === "object") copy[key] = addReceiptTime(copy[key]);
        });
        return copy;
      };
      localStorage.setItem(cacheKey(path), JSON.stringify(addReceiptTime(value)));
      localStorage.setItem(cacheKey("updated-at"), new Date().toISOString());
    } catch (error) {
      console.error("Impossible d'enregistrer le cache local", error);
    }
  }

  async function api(path, options = {}) {
    const isRead = !options.method || options.method === "GET";
    const storedPath = options.cacheKey || path;
    const {
      cacheKey: _cacheKey,
      updateConnection: updateConnectionStatus = true,
      ...fetchOptions
    } = options;
    const requestHeaders = {
      ...(localStorage.getItem("pm_token")
        ? { Authorization: `Bearer ${localStorage.getItem("pm_token")}` }
        : {}),
      ...(options.headers || {}),
    };
    if (fetchOptions.body instanceof FormData) {
      delete requestHeaders["Content-Type"];
    } else if (!requestHeaders["Content-Type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }
    try {
      const response = await fetch(`/api${path}`, {
        ...fetchOptions,
        headers: requestHeaders,
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
      if (updateConnectionStatus) updateConnectionState(true);
      return result;
    } catch (error) {
      if (isRead && error instanceof TypeError) {
        if (updateConnectionStatus) updateConnectionState(false);
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

  function cancelMeasurementRequest() {
    measurementRequestId += 1;
    if (measurementController) measurementController.abort();
    measurementController = null;
  }

  function setMeasurementRefreshStatus(message, isError = false) {
    const status = $("#measurement-refresh-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  async function getMeasurementThresholds(machineId, signal) {
    const cachedThresholds = measurementThresholdCache.get(machineId);
    if (cachedThresholds && Date.now() - cachedThresholds.loadedAt < 60000) {
      return cachedThresholds.values;
    }
    const values = await api(`/thresholds/${encodeURIComponent(machineId)}`, {
      signal,
      updateConnection: false,
    });
    measurementThresholdCache.set(machineId, { values, loadedAt: Date.now() });
    return values;
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
    const alertMode = currentPage === "alerts" ? selectedAlertMode : "hardware";
    const alertQuery = alertMode === "all" ? "" : `?acquisition_mode=${alertMode}`;
    const overviewQuery = `?acquisition_mode=${selectedMeasurementMode}`;
    const overviewCacheKey = selectedMeasurementMode === "hardware"
      ? "/technician/overview" : `/technician/overview${overviewQuery}`;
    const alertCacheKey = alertMode === "hardware" ? "/alerts" : `/alerts:${alertMode}`;
    const results = await Promise.allSettled([
      api(`/technician/overview${overviewQuery}`, { cacheKey: overviewCacheKey }),
      api("/machines"),
      api(`/alerts${alertQuery}`, { cacheKey: alertCacheKey }),
      api("/interventions"),
      api("/failures"),
      api("/calibrations"),
      api("/notifications"),
    ]);
    const dataKeys = [
      "/technician/overview",
      "/machines",
      "/alerts",
      "/interventions",
      "/failures",
      "/calibrations",
      "/notifications",
    ];
    const cacheKeys = [
      overviewCacheKey,
      "/machines",
      alertCacheKey,
      "/interventions",
      "/failures",
      "/calibrations",
      "/notifications",
    ];
    const data = {};
    results.forEach((result, index) => {
      if (result.status === "fulfilled") data[dataKeys[index]] = result.value;
      else {
        if (navigator.onLine) throw result.reason;
        data[dataKeys[index]] = cached(cacheKeys[index]);
        if (data[dataKeys[index]] === null) console.error(result.reason);
      }
    });
    const notifications = data["/notifications"] || [];
    const notificationReceiptIds = notifications
      .filter((item) => item.id?.startsWith("technician-") && !item.received_at)
      .map((item) => Number(item.id.slice("technician-".length)))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (navigator.onLine && notificationReceiptIds.length) {
      api("/notifications/received", {
        method: "POST",
        body: JSON.stringify({ notification_ids: notificationReceiptIds }),
        updateConnection: false,
      }).catch((error) => console.error("Réception des notifications non confirmée", error));
    }
    technicianMachines = data["/machines"] || [];
    const unread = notifications.filter((item) => !item.read).length;
    $("#tech-notification-count").textContent = String(unread);
    $("#tech-notification-count").classList.toggle("hidden", unread === 0);
    return data;
  }

  function machineName(machines, id) {
    return machines.find((item) => item.id === id)?.name || "Machine";
  }

  function latestMeasurementMarkup(overview, machines) {
    const latest = measurementUi.markReceived(overview.latest);
    if (!latest) return '<div class="empty-state">Aucune mesure récente en mode sélectionné.</div>';
    const latestInfo = `${measurementUi.formatDate(latest.recorded_at)} · ${measurementUi.freshness(latest).label}`;
    const value = (input, decimals = 1) => measurementUi.numberValue(input, decimals);
    return `<div class="tech-latest"><strong>${escapeHtml(machineName(machines, latest.machine_id))}</strong><span>${measurementUi.modeBadge(latest.acquisition_mode)} · ${escapeHtml(latestInfo)}</span>
      <div>${metricCard("Température", `${value(latest.temperature)} °C`, "")}${metricCard("Humidité", `${value(latest.humidity)} %`, "")}${metricCard("Vibrations", `${value(latest.vibration_rate, 2)} événements/s · ${value(latest.vibration_edges, 0)} événements`, "")}${metricCard("Courant", measurementUi.currentValue(latest), measurementUi.currentSourceLabel(latest))}</div></div>`;
  }

  async function refreshOverviewMeasurement() {
    if (overviewMeasurementRefreshInFlight || currentPage !== "overview" || renderInFlight) return;
    overviewMeasurementRefreshInFlight = true;
    const requestId = ++overviewMeasurementRequestId;
    const acquisitionMode = selectedMeasurementMode;
    const status = $("#technician-overview-measurement-status");
    try {
      const query = `?acquisition_mode=${acquisitionMode}`;
      const overview = await api(`/technician/overview${query}`, {
        cacheKey: acquisitionMode === "hardware"
          ? "/technician/overview" : `/technician/overview${query}`,
      });
      if (requestId !== overviewMeasurementRequestId
        || currentPage !== "overview"
        || acquisitionMode !== selectedMeasurementMode) return;
      const container = $("#technician-latest-measurement");
      if (container) container.innerHTML = latestMeasurementMarkup(overview, technicianMachines);
      if (status) {
        status.textContent = $("#technician-connection").classList.contains("offline")
          ? "Hors ligne : la dernière mesure disponible provient du cache."
          : "Dernière mesure actualisée automatiquement.";
        status.classList.toggle("error", false);
      }
    } catch (error) {
      if (requestId !== overviewMeasurementRequestId || currentPage !== "overview") return;
      if (status) {
        status.textContent = `Actualisation de la dernière mesure impossible : ${error.message}`;
        status.classList.toggle("error", true);
      }
    } finally {
      overviewMeasurementRefreshInFlight = false;
    }
  }

  function alertRows(alerts, machines) {
    if (!alerts.length) return '<div class="empty-state">Aucune alerte à afficher.</div>';
    return alerts.map((alert) => `<article class="tech-list-row">
      <div class="tech-list-main">
        <div class="tech-row-title"><strong>${escapeHtml(machineName(machines, alert.machine_id))} · ${escapeHtml(metricInfo[alert.metric]?.[0] || alert.metric)}</strong>
          <span class="severity ${alert.severity === "critical" ? "critical" : ""}">${escapeHtml(alert.severity)}</span></div>
        <p>${escapeHtml(stateNames[alert.status] || alert.status)} · Valeur ${measurementUi.metricValue(alert.metric, alert.value)} · ${measurementUi.modeLabel(alert.acquisition_mode)}</p>
        <small>${formatDate(alert.created_at)}${alert.acknowledged_at ? ` · Prise en charge le ${formatDate(alert.acknowledged_at)}` : ""}${alert.processing_delay_ms !== null && alert.processing_delay_ms !== undefined ? ` · Traitement backend : ${escapeHtml(alert.processing_delay_ms)} ms` : ""}</small>
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
      </form>` : `<div class="tech-history-detail">
        <p><strong>Diagnostic :</strong> ${escapeHtml(item.diagnosis || "Non renseigné")}</p>
        <p><strong>Travail réalisé :</strong> ${escapeHtml(item.work_done || "Non renseigné")}</p>
        <p><strong>Résultat :</strong> ${escapeHtml(item.result || "Non renseigné")}</p>
        <small>${item.resolved_at ? `Clôturée le ${formatDate(item.resolved_at)}` : `Mise à jour le ${formatDate(item.updated_at)}`}</small>
      </div>`}
      <details class="intervention-photo-panel" data-photo-panel="${item.id}">
        <summary>Photos de l’intervention</summary>
        <div class="intervention-photo-gallery" data-photo-gallery="${item.id}"></div>
        <form class="intervention-photo-upload" data-photo-upload="${item.id}">
          <label>Ajouter des photos<input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple required></label>
          <button class="quiet" type="submit">Joindre les photos</button>
          <span class="form-message muted" role="status"></span>
        </form>
      </details>
    </article>`;
  }

  function clearPhotoObjectUrls() {
    photoObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    photoObjectUrls.clear();
  }

  async function loadInterventionPhotos(panel, reload = false) {
    const interventionId = panel.dataset.photoPanel;
    const gallery = $("[data-photo-gallery]", panel);
    if (!reload && gallery.dataset.loaded === "true") return;
    gallery.textContent = "Chargement des photos…";
    try {
      const photos = await api(`/interventions/${interventionId}/photos`);
      const items = [];
      for (const photo of photos) {
        const response = await fetch(
          `/api/interventions/${interventionId}/photos/${photo.id}`,
          { headers: { Authorization: `Bearer ${localStorage.getItem("pm_token")}` } },
        );
        if (response.status === 401) {
          $("#logout").click();
          throw new Error("Votre session a expiré. Reconnectez-vous.");
        }
        if (!response.ok) throw new Error("Une photo n’a pas pu être chargée.");
        const url = URL.createObjectURL(await response.blob());
        photoObjectUrls.add(url);
        items.push(`<figure><img src="${url}" alt="Photo de l’intervention ${interventionId}">
          <figcaption>${escapeHtml(photo.original_name)} · ${formatDate(photo.created_at)}</figcaption></figure>`);
      }
      gallery.innerHTML = items.join("") || '<p class="muted">Aucune photo jointe.</p>';
      gallery.dataset.loaded = "true";
    } catch (error) {
      gallery.innerHTML = `<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
      gallery.dataset.loaded = "false";
    }
  }

  function bindInterventionCards() {
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
    document.querySelectorAll("[data-photo-panel]").forEach((panel) => {
      panel.addEventListener("toggle", () => {
        if (panel.open) void loadInterventionPhotos(panel);
      });
    });
    document.querySelectorAll(".intervention-photo-upload").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = $('input[type="file"]', form);
        const message = $(".form-message", form);
        try {
          for (const file of input.files) {
            const body = new FormData();
            body.append("photo", file);
            await api(`/interventions/${form.dataset.photoUpload}/photos`, {
              method: "POST",
              body,
            });
          }
          form.reset();
          const panel = form.closest("[data-photo-panel]");
          if (panel.open) await loadInterventionPhotos(panel, true);
          toast("Les photos ont été ajoutées à l’intervention.");
        } catch (error) {
          message.textContent = error.message;
          message.classList.add("error");
        }
      });
    });
  }

  async function renderOverview(data) {
    const overview = data["/technician/overview"] || {};
    const machines = data["/machines"] || [];
    const alerts = data["/alerts"] || [];
    const interventions = data["/interventions"] || [];
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
          <div class="admin-card-body"><div id="technician-latest-measurement">${latestMeasurementMarkup(overview, machines)}</div>
            <p id="technician-overview-measurement-status" class="muted" role="status">Actualisation automatique.</p></div></section>
      </div>`;
  }

  async function renderAlerts(data) {
    const machines = data["/machines"] || [];
    const alerts = data["/alerts"] || [];
    $("#technician-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Alertes de vos machines</h2><label>Origine<select id="alert-mode-filter">
        <option value="hardware" ${selectedAlertMode === "hardware" ? "selected" : ""}>Réel</option>
        <option value="simulated" ${selectedAlertMode === "simulated" ? "selected" : ""}>Simulé</option>
        <option value="all" ${selectedAlertMode === "all" ? "selected" : ""}>Toutes</option>
        <option value="unknown" ${selectedAlertMode === "unknown" ? "selected" : ""}>Origine inconnue</option>
      </select></label><span>${alerts.length} événement(s)</span></div>
      <div class="admin-card-body"><div class="page-toolbar">
        <label>État<select id="alert-status-filter"><option value="">Tous les états</option><option value="new">Nouvelles</option><option value="acknowledged">Prises en charge</option><option value="closed">Clôturées</option></select></label>
        <label>Machine<select id="alert-machine-filter"><option value="">Toutes les machines</option>${machines.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></label>
      </div><p class="callout">« Prendre en charge » enregistre que vous traitez l’alerte et sa date. L’alerte reste ouverte ; cette action ne crée pas une mission dans « Mes interventions ». Demandez au Responsable d’attribuer une intervention si un travail doit être planifié.</p>
      <div id="tech-alert-list">${alertRows(alerts, machines)}</div></div>
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
    $("#alert-mode-filter").addEventListener("change", (event) => {
      selectedAlertMode = event.target.value;
      $("#technician-page").innerHTML =
        '<div class="empty-state" role="status">Chargement des alertes du mode sélectionné…</div>';
      render();
    });
  }

  async function renderInterventions(data) {
    const interventions = data["/interventions"] || [];
    const machines = data["/machines"] || [];
    clearPhotoObjectUrls();
    $("#technician-page").innerHTML = `<div class="page-intro"><div><h2>Historique de mes interventions</h2><p>Retrouvez les interventions attribuées, en cours, terminées et annulées, avec leurs comptes rendus et photos.</p></div>
      <label>Statut<select id="intervention-status-filter">
        <option value="all" ${selectedInterventionStatus === "all" ? "selected" : ""}>Tous les statuts</option>
        ${Object.entries(stateNames).filter(([state]) => ["assigned", "accepted", "in_progress", "completed", "cancelled"].includes(state)).map(([state, label]) => `<option value="${state}" ${selectedInterventionStatus === state ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
      </select></label></div>
      <div id="tech-intervention-list" class="tech-intervention-grid"></div>`;
    const drawInterventions = () => {
      const visible = selectedInterventionStatus === "all"
        ? interventions
        : interventions.filter((item) => item.status === selectedInterventionStatus);
      $("#tech-intervention-list").innerHTML = visible.map((item) => interventionCard(item, machines)).join("")
        || (interventions.length
          ? '<div class="empty-state">Aucune intervention pour ce statut.</div>'
          : '<div class="empty-state">Aucune intervention ne vous a été attribuée. Demandez au Responsable de vous affecter une mission. Un diagnostic dans « Historique des pannes » ne crée pas une intervention planifiée.</div>');
      bindInterventionCards();
    };
    $("#intervention-status-filter").addEventListener("change", (event) => {
      selectedInterventionStatus = event.target.value;
      drawInterventions();
    });
    drawInterventions();
  }

  async function renderMachines(data) {
    const machines = data["/machines"] || [];
    const alerts = data["/alerts"] || [];
    const interventions = data["/interventions"] || [];
    $("#technician-page").innerHTML = `<div class="tech-machine-grid">${machines.map((machine) => {
      const machineAlerts = alerts.filter((item) => item.machine_id === machine.id && item.status !== "closed").length;
      const machineInterventions = interventions.filter((item) => item.machine_id === machine.id && !["completed", "cancelled"].includes(item.status)).length;
      return `<article class="tech-intervention-card"><div class="tech-row-title"><h3>${escapeHtml(machine.name)}</h3>
        <span class="status ${machine.status === "online" ? "" : "offline"}">${machine.status === "online" ? "En ligne (MQTT)" : "Hors ligne (MQTT)"}</span></div>
        <p>${escapeHtml(machine.description || "Aucune description renseignée.")}</p>
        <div class="tech-meta"><span>${machineAlerts} alerte(s) active(s)</span><span>${machineInterventions} intervention(s) en cours</span></div>
        <small>${machine.measurement_recorded_at
    ? `Dernière mesure ${measurementUi.modeBadge(machine.last_measurement_mode)} : ${measurementUi.formatDate(machine.measurement_recorded_at)} · ${measurementUi.freshness({ age_seconds: machine.measurement_age_seconds, _client_received_at: machine._client_received_at }).label}`
    : "Aucune mesure récente"}</small>
        <button class="quiet" data-machine-detail="${escapeHtml(machine.id)}">Ouvrir la fiche détaillée</button>
        <button class="quiet" data-machine-measure="${escapeHtml(machine.id)}">Consulter les mesures</button>
        <div class="machine-detail-panel hidden" data-machine-detail-panel="${escapeHtml(machine.id)}"></div>
      </article>`;
    }).join("") || '<div class="empty-state">Aucune machine ne vous est attribuée. Contactez votre Responsable de maintenance.</div>'}</div>`;
    document.querySelectorAll("[data-machine-detail]").forEach((button) => {
      button.addEventListener("click", async () => {
        const machineId = button.dataset.machineDetail;
        const panel = $("[data-machine-detail-panel]", button.closest(".tech-intervention-card"));
        if (!panel.classList.contains("hidden") && panel.dataset.loaded === "true") {
          panel.classList.add("hidden");
          button.textContent = "Ouvrir la fiche détaillée";
          return;
        }
        button.disabled = true;
        panel.classList.remove("hidden");
        panel.innerHTML = '<p class="muted" role="status">Chargement de la fiche…</p>';
        try {
          const details = await api(`/machines/${encodeURIComponent(machineId)}/details`);
          panel.innerHTML = machineDetailsMarkup(details);
          panel.dataset.loaded = "true";
          button.textContent = "Masquer la fiche détaillée";
        } catch (error) {
          panel.innerHTML = `<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
          panel.dataset.loaded = "false";
        } finally {
          button.disabled = false;
        }
      });
    });
    document.querySelectorAll("[data-machine-measure]").forEach((button) => {
      button.addEventListener("click", () => navigate("measurements", button.dataset.machineMeasure));
    });
  }

  function machineDetailsMarkup(details) {
    const latest = details.latest_measurement;
    const latestValues = latest
      ? Object.entries(metricInfo).map(([metric, [label, unit]]) => {
        const value = latest[metric];
        if (value === null || value === undefined) return "";
        const sensorId = latest.sensor_ids?.[metric];
        return `<div class="machine-reading"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)} ${escapeHtml(unit)}</span>
          ${sensorId ? `<small>Capteur #${escapeHtml(sensorId)}</small>` : ""}</div>`;
      }).filter(Boolean).join("")
      : '<p class="muted">Aucune mesure enregistrée.</p>';
    const sensors = details.sensors.map((sensor) => `<li>
      <strong>${escapeHtml(metricInfo[sensor.metric]?.[0] || sensor.metric)}</strong>
      <span>${escapeHtml(sensor.sensor_type)} · ${escapeHtml(sensor.unit)}${sensor.gpio !== null ? ` · GPIO ${escapeHtml(sensor.gpio)}` : ""}</span>
      <span class="role-pill">${sensor.enabled ? "Actif" : "Inactif"}</span>
    </li>`).join("");
    const alerts = details.active_alerts.map((alert) => `<li>
      <strong>${escapeHtml(metricInfo[alert.metric]?.[0] || alert.metric)} · ${escapeHtml(alert.severity)}</strong>
      <span>${escapeHtml(alert.value)} · ${measurementUi.modeLabel(alert.acquisition_mode)} · ${formatDate(alert.created_at)}</span>
      ${alert.processing_delay_ms !== null && alert.processing_delay_ms !== undefined ? `<small>Délai de traitement backend mesuré : ${escapeHtml(alert.processing_delay_ms)} ms</small>` : ""}
    </li>`).join("");
    return `<section class="machine-detail-content" aria-label="Fiche détaillée de ${escapeHtml(details.machine.name)}">
      <div class="machine-detail-section"><h4>Équipement</h4>
        <p><strong>${escapeHtml(details.machine.name)}</strong> · Identifiant : ${escapeHtml(details.machine.id)}</p>
        <p>${escapeHtml(details.machine.description || "Aucune description renseignée.")}</p>
        <p>État : ${escapeHtml(details.machine.status)} · Dernière activité : ${formatDate(details.machine.last_seen)}</p>
      </div>
      <div class="machine-detail-section"><h4>Mesures les plus récentes</h4>
        ${latest ? `<p>Lecture #${escapeHtml(latest.seq)} · ${measurementUi.modeBadge(latest.acquisition_mode)} · Reçue le ${formatDate(latest.received_at || latest.recorded_at)}</p><div class="machine-readings">${latestValues}</div>` : latestValues}</div>
      <div class="machine-detail-section"><h4>Capteurs déclarés (${details.sensors.length})</h4>
        <ul class="machine-detail-list">${sensors || "<li>Aucun capteur déclaré.</li>"}</ul></div>
      <div class="machine-detail-section"><h4>Alertes et anomalies actives (${details.active_alerts.length})</h4>
        <ul class="machine-detail-list">${alerts || "<li>Aucune alerte active.</li>"}</ul></div>
      <div class="machine-detail-section"><h4>Besoin d’intervention</h4>
        <p>${details.active_intervention_count ? `${details.active_intervention_count} intervention(s) active(s) qui vous sont attribuées.` : "Aucune intervention active qui vous est attribuée."}</p></div>
    </section>`;
  }

  function measurementValue(row, metric) {
    if (metric === "current_rms"
      && (row.current_rms === null || row.current_source === "unavailable")) return null;
    const rawValue = row[metric];
    if (rawValue === null || rawValue === undefined || rawValue === "") return null;
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : null;
  }

  function drawChart(rows, metric) {
    const chartRows = rows.map((row) => ({ row, value: measurementValue(row, metric) }))
      .filter((item) => item.value !== null);
    const values = chartRows.map((item) => item.value);
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
    </svg><div class="chart-caption"><span>${measurementUi.formatDate(chartRows[0].row.recorded_at)}</span><strong>${escapeHtml(label)} (${escapeHtml(unit)})</strong><span>${measurementUi.formatDate(chartRows[chartRows.length - 1].row.recorded_at)}</span></div>`;
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
          <label>Mode<select name="acquisition_mode"><option value="hardware" ${selectedMeasurementMode === "hardware" ? "selected" : ""}>Réel</option><option value="simulated" ${selectedMeasurementMode === "simulated" ? "selected" : ""}>Simulé</option></select></label>
          <button class="primary" type="submit">Afficher</button>
        </form>
        <p id="measurement-refresh-status" class="muted" role="status">Actualisation automatique toutes les 5 secondes.</p>
        <div id="measurement-summary"></div>
      </div></section>`;
    const form = $("#measurement-filter");
    const metricSelect = $('select[name="metric"]', form);
    metricSelect.value = selectedMeasurementMetric;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void loadMeasurements(new FormData(form));
    });
    metricSelect.addEventListener("change", () => {
      selectedMeasurementMetric = metricSelect.value;
      void loadMeasurements(new FormData(form));
    });
    if (machines.length) await loadMeasurements(new FormData(form));
    else $("#measurement-summary").innerHTML =
      '<div class="empty-state">Aucune machine autorisée ne permet de consulter des mesures.</div>';
  }

  async function loadMeasurements(form, { automatic = false } = {}) {
    if (automatic && measurementController) return;
    const machineId = form.get("machine_id");
    const metric = form.get("metric");
    const hours = Number(form.get("period"));
    selectedMeasurementMetric = metric;
    selectedMeasurementMode = form.get("acquisition_mode") || "hardware";
    selectedMeasurementMachine = machineId;
    const requestId = ++measurementRequestId;
    if (measurementController) measurementController.abort();
    measurementController = new AbortController();
    const { signal } = measurementController;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), limit: "1000" });
    const container = $("#measurement-summary");
    if (!automatic) container.innerHTML = '<div class="empty-state">Chargement des mesures…</div>';
    try {
      const [rows, thresholds] = await Promise.all([
        api(`/machines/${encodeURIComponent(machineId)}/telemetry?${query}&acquisition_mode=${selectedMeasurementMode}`, {
          cacheKey: `/measurements:${machineId}:${metric}:${hours}:${selectedMeasurementMode}`,
          signal,
        }),
        getMeasurementThresholds(machineId, signal),
      ]);
      if (requestId !== measurementRequestId || signal.aborted) return;
      const orderedRows = measurementUi.sortAndDedupe(rows);
      const usableRows = orderedRows.filter((row) => measurementValue(row, metric) !== null);
      const values = usableRows.map((row) => measurementValue(row, metric));
      const minimum = values.length ? Math.min(...values) : null;
      const maximum = values.length ? Math.max(...values) : null;
      const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const threshold = thresholds.find((item) => item.metric === metric);
      const unit = metricInfo[metric][1];
      const above = threshold ? values.filter((value) => value >= threshold.warning).length : 0;
      const latest = orderedRows[orderedRows.length - 1];
      container.innerHTML = `${latest ? `<p class="callout"><strong>Dernière mesure ${measurementUi.modeBadge(latest.acquisition_mode)}</strong> · ${measurementUi.formatDate(latest.recorded_at)} · ${measurementUi.freshness(latest).label}</p>` : ""}
        ${orderedRows.length ? `${values.length ? `<div class="admin-stats">
        ${metricCard("Minimum", `${measurementUi.numberValue(minimum, metric === "vibration_edges" ? 0 : 1)} ${unit}`, "sur la période")}
        ${metricCard("Maximum", `${measurementUi.numberValue(maximum, metric === "vibration_edges" ? 0 : 1)} ${unit}`, "sur la période")}
        ${metricCard("Moyenne", `${measurementUi.numberValue(average, metric === "vibration_edges" ? 0 : 1)} ${unit}`, "sur la période")}
        ${metricCard("Au-dessus du seuil", above, "valeur(s)")}
      </div><div class="chart-panel">${drawChart(usableRows, metric)}</div>` : `<p class="callout">${metric === "current_rms" ? "Aucune valeur de courant disponible; ces lectures ne sont pas incluses dans les statistiques ni le graphique." : `Aucune valeur de ${escapeHtml(metricInfo[metric][0])} n’est disponible dans cette période.`}</p>`}
      <div class="table-wrap"><table class="admin-table"><thead><tr><th>Date / heure</th><th>${escapeHtml(metricInfo[metric][0])}</th><th>Source du courant</th><th>Mode d'acquisition</th></tr></thead>
        <tbody>${orderedRows.slice().reverse().map((row) => {
          const currentUnavailable = metric === "current_rms"
            && (row.current_rms === null || row.current_source === "unavailable");
          const decimals = metric === "vibration_edges" ? 0 : metric === "vibration_rate" ? 2 : 1;
          const value = measurementValue(row, metric);
          const displayedValue = currentUnavailable
            ? measurementUi.currentValue(row)
            : value === null
              ? "Non disponible"
              : `${measurementUi.numberValue(value, decimals)} ${unit}`;
          return `<tr><td>${measurementUi.formatDate(row.recorded_at)}</td><td>${displayedValue}</td><td>${metric === "current_rms" ? measurementUi.currentSourceLabel(row) : "—"}</td><td>${measurementUi.modeBadge(row.acquisition_mode)}</td></tr>`;
        }).join("")}</tbody></table></div>` : '<div class="empty-state">Aucune mesure dans le mode choisi pour cette machine et cette période.</div>'}`;
      setMeasurementRefreshStatus(!$("#technician-connection").classList.contains("offline")
        ? "Actualisation automatique toutes les 5 secondes."
        : "Hors ligne : les données disponibles proviennent du dernier cache local.");
    } catch (error) {
      if (requestId !== measurementRequestId || signal.aborted) return;
      if (automatic && container.innerHTML) {
        setMeasurementRefreshStatus(`Actualisation impossible : ${error.message}`, true);
      } else {
        container.innerHTML = `<div class="inline-error" role="alert">${escapeHtml(error.message)}</div>`;
      }
    } finally {
      if (requestId === measurementRequestId) measurementController = null;
    }
  }

  async function renderFailures(data) {
    const failures = data["/failures"] || [];
    const machines = data["/machines"] || [];
    $("#technician-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Événements critiques détectés</h2><span>${failures.length} événement(s)</span></div>
      <div class="admin-card-body"><p class="callout">Un dépassement de seuil nécessite un diagnostic ; il ne confirme pas à lui seul une panne matérielle.</p>
        <p class="muted">Le formulaire ci-dessous enregistre le diagnostic de l’événement ; il ne crée pas une mission dans « Mes interventions ».</p>
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
        <div><strong>${escapeHtml(item.message)}</strong><p>${formatDate(item.created_at)}
          ${item.push_sent_at ? ` · Envoyée au service Push ${formatDate(item.push_sent_at)}` : ""}
          ${item.received_at ? ` · Reçue par l’application ${formatDate(item.received_at)}${item.delivery_delay_ms !== null ? ` · ${escapeHtml(item.delivery_delay_ms)} ms depuis la création` : ""}` : ""}
        </p></div>
        <div class="actions">${item.target_type === "intervention" ? `<button class="quiet" data-notification-go="interventions">Consulter</button>` : ""}
          ${!item.read ? `<button class="quiet" data-notification-read="${escapeHtml(item.id)}">Marquer comme lue</button>` : ""}</div>
      </article>`).join("") || '<div class="empty-state">Vous n’avez aucune notification.</div>'}</div>
    </section>
    <section class="admin-card push-settings-card">
      <div class="admin-card-header"><h2>Notifications navigateur</h2></div>
      <div class="admin-card-body"><p id="tech-push-status" class="muted" role="status">Vérification de la configuration Push…</p>
        <button id="tech-push-toggle" class="quiet" type="button" disabled>Notifications navigateur indisponibles</button>
      </div>
    </section>`;
    await refreshPushStatus();
  }

  async function refreshPushStatus() {
    const status = $("#tech-push-status");
    const button = $("#tech-push-toggle");
    if (!status || !button) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      pushVapidPublicKey = "";
      pushSubscription = null;
      status.textContent = "Ce navigateur ne prend pas en charge les notifications Push.";
      button.textContent = "Notifications navigateur indisponibles";
      button.disabled = true;
      return;
    }
    try {
      const config = await api("/notifications/push/vapid-key");
      if (!config.enabled) {
        pushVapidPublicKey = "";
        pushSubscription = null;
        status.textContent = "Le serveur n’a pas de clés VAPID configurées. Les notifications internes restent disponibles.";
        button.textContent = "Push non configuré";
        button.disabled = true;
        return;
      }
      pushVapidPublicKey = config.public_key || "";
      const registration = await navigator.serviceWorker.ready;
      pushSubscription = await registration.pushManager.getSubscription();
      status.textContent = Notification.permission === "denied"
        ? "Les notifications sont bloquées dans les permissions de ce navigateur."
        : "Autorisez les notifications navigateur pour recevoir les nouvelles alertes et interventions.";
      button.textContent = subscription ? "Désactiver les notifications navigateur" : "Activer les notifications navigateur";
      button.disabled = false;
    } catch (error) {
      status.textContent = error.message;
      button.textContent = "Configuration Push indisponible";
      button.disabled = true;
    }
  }

  function decodeVapidKey(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  }

  async function toggleBrowserPush() {
    const status = $("#tech-push-status");
    if (!pushVapidPublicKey) throw new Error("Les notifications Push ne sont pas configurées.");
    if (pushSubscription) {
      const existing = pushSubscription;
      await api("/notifications/push/subscriptions", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: existing.endpoint }),
      });
      await existing.unsubscribe();
      pushSubscription = null;
      status.textContent = "Les notifications navigateur ont été désactivées.";
      await refreshPushStatus();
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      status.textContent = permission === "denied"
        ? "Autorisation refusée. Modifiez les permissions du site dans votre navigateur."
        : "Autorisation des notifications non accordée.";
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(pushVapidPublicKey),
    });
    try {
      const serialized = subscription.toJSON();
      await api("/notifications/push/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          endpoint: serialized.endpoint,
          p256dh: serialized.keys.p256dh,
          auth: serialized.keys.auth,
        }),
      });
    } catch (error) {
      await subscription.unsubscribe();
      throw error;
    }
    pushSubscription = subscription;
    status.textContent = "Les notifications navigateur sont activées pour ce compte.";
    await refreshPushStatus();
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
    const availableInterventions = interventions.filter((item) => !["completed", "cancelled"].includes(item.status));
    const updatedAt = cachedUpdatedAt();
    $("#technician-page").innerHTML = `<div class="admin-stats">
      ${metricCard("Connexion", navigator.onLine ? "Disponible" : "Indisponible", "état de votre navigateur")}
      ${metricCard("Comptes rendus en attente", actions.length, "stockés sur cet appareil")}
      ${metricCard("Dernier cache", updatedAt ? formatDate(updatedAt) : "—", "données autorisées")}
    </div><section class="admin-card"><div class="admin-card-header"><h2>Préparer un compte rendu hors ligne</h2></div><div class="admin-card-body">
      <p class="callout">Un brouillon reste sur cet appareil. Il n’est pas enregistré sur le serveur avant confirmation de la synchronisation.</p>
      ${availableInterventions.length ? `<form id="offline-report-form">
        <label>Intervention<select name="intervention_id" required><option value="" selected disabled>Choisissez une intervention attribuée</option>${availableInterventions.map((item) => `<option value="${item.id}">${escapeHtml(item.title)} · ${escapeHtml(item.assigned_to_name || "Vous")}</option>`).join("")}</select></label>
        <label>Diagnostic<textarea name="diagnosis" rows="2" maxlength="4000"></textarea></label>
        <label>Travail réalisé<textarea name="work_done" rows="3" maxlength="4000" required></textarea></label>
        <label>Résultat<textarea name="result" rows="2" maxlength="4000"></textarea></label>
        <button class="primary" type="submit">Enregistrer le brouillon sur cet appareil</button>
      </form>` : '<div class="empty-state" role="status">Aucune intervention ouverte ne vous est attribuée. Un Responsable doit vous affecter une mission avant de pouvoir préparer son compte rendu hors ligne.</div>'}</div></section>
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
    const offlineReportForm = $("#offline-report-form");
    if (offlineReportForm) offlineReportForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const reportForm = event.currentTarget;
      const form = new FormData(reportForm);
      const intervention = availableInterventions.find((item) => item.id === Number(form.get("intervention_id")));
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
      reportForm.reset();
      toast("Le brouillon est enregistré sur cet appareil, pas sur le serveur.");
      await renderOffline(data);
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
    if (renderInFlight) {
      renderQueued = true;
      renderVersion += 1;
      return;
    }
    renderInFlight = true;
    const requestVersion = ++renderVersion;
    currentPage = pageTitles[currentPage] ? currentPage : "overview";
    if (currentPage !== "interventions") clearPhotoObjectUrls();
    const [title, subtitle] = pageTitles[currentPage];
    $("#technician-page-title").textContent = title;
    $("#technician-page-subtitle").textContent = subtitle;
    document.querySelectorAll("[data-tech-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.techPage === currentPage);
    });
    $(".technician-sidebar").classList.remove("open");
    try {
      const data = await loadCommonData();
      if (requestVersion !== renderVersion) return;
      if (currentPage === "offline" && hasUnsavedOfflineChanges()) return;
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
    } finally {
      renderInFlight = false;
      if (renderQueued) {
        renderQueued = false;
        void render();
      }
    }
  }

  async function refreshTechnicianView() {
    if (!user || document.visibilityState === "hidden" || renderInFlight) return;
    if (currentPage === "offline" && hasUnsavedOfflineChanges()) return;
    if (currentPage === "measurements") {
      const form = $("#measurement-filter");
      if (form) await loadMeasurements(new FormData(form), { automatic: true });
      return;
    }
    if (currentPage === "overview") {
      if (overviewMeasurementRefreshInFlight) return;
      if (Date.now() - lastGeneralRefreshAt >= 30000) {
        lastGeneralRefreshAt = Date.now();
        await render();
      } else {
        await refreshOverviewMeasurement();
      }
      return;
    }
    if (Date.now() - lastGeneralRefreshAt < 30000) return;
    lastGeneralRefreshAt = Date.now();
    await render();
  }

  function navigate(page, machineId = "") {
    if (!pageTitles[page]) return;
    if (page !== "overview") overviewMeasurementRequestId += 1;
    if (page !== "measurements") cancelMeasurementRequest();
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
    if (event.target.closest("#tech-push-toggle")) {
      try {
        await toggleBrowserPush();
      } catch (error) {
        const status = $("#tech-push-status");
        if (status) status.textContent = error.message;
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
      if (page !== "overview") overviewMeasurementRequestId += 1;
      if (page !== "measurements") cancelMeasurementRequest();
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
    clearPhotoObjectUrls();
    $("#technician-page").innerHTML = "";
    cancelMeasurementRequest();
    overviewMeasurementRequestId += 1;
    user = null;
    pushVapidPublicKey = "";
    pushSubscription = null;
    window.clearInterval(refreshTimer);
  });
  window.addEventListener("predimaint:technician-authenticated", (event) => {
    window.clearInterval(refreshTimer);
    cancelMeasurementRequest();
    overviewMeasurementRequestId += 1;
    user = event.detail;
    $("#technician-header-name").textContent = user.full_name || user.email;
    $("#technician-avatar").textContent = String(user.full_name || "T").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    updateConnectionState();
    const hashPage = location.hash.replace(/^#tech-/, "");
    currentPage = pageTitles[hashPage] ? hashPage : "overview";
    lastGeneralRefreshAt = Date.now();
    if (currentPage === "overview" && location.hash !== "#tech-overview") location.hash = "tech-overview";
    else render();
    refreshTimer = window.setInterval(() => { void refreshTechnicianView(); }, 5000);
  });
})();
