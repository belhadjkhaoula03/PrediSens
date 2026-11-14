(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const pages = {
    overview: ["Vue d’ensemble", "Suivez la performance du parc de production."],
    availability: ["Indicateurs de disponibilité", "Consultez les états et la qualité des données disponibles."],
    failures: ["Durée et fréquence des pannes", "Distinguez les alertes critiques des pannes confirmées."],
    reports: ["Rapports de maintenance", "Consultez et exportez les données réelles de la période."],
    costs: ["Coût des arrêts", "Consultez l’état des paramètres économiques disponibles."],
    machines: ["Vue globale des machines", "Consultez l’état enregistré des équipements actifs."],
    notifications: ["Notifications", "Consultez les messages adressés à votre compte."],
    profile: ["Mon profil", "Gérez vos informations personnelles et la sécurité de votre compte."],
  };
  const periodPages = new Set(["overview", "availability", "failures", "reports"]);
  const machineFilterPages = new Set([...periodPages, "machines"]);
  const interventionStatuses = {
    assigned: "À prendre en charge",
    accepted: "Acceptée",
    in_progress: "En cours",
    completed: "Terminée",
    cancelled: "Annulée",
  };
  const notificationTypes = {
    account_update: "Mise à jour du compte",
    due_reminder: "Échéance d’intervention",
    intervention_assigned: "Intervention attribuée",
    intervention_updated: "Intervention mise à jour",
  };
  const directorApp = $("#director-app");
  const sidebar = $("#director-sidebar");
  const pageRoot = $("#director-page");
  let context = null;
  let activePage = "overview";
  let days = 30;
  let machineId = "";
  let machines = [];
  let refreshTimer = null;
  let listenersBound = false;

  function query() {
    const params = new URLSearchParams({ days: String(days) });
    if (machineId) params.set("machine_id", machineId);
    return params.toString();
  }

  function formatDate(value) {
    if (!value) return "Non renseignée";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Non renseignée" : date.toLocaleString("fr-FR");
  }

  function metric(label, value, note, state = "") {
    return `<article class="director-stat ${state}">
      <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
    </article>`;
  }

  function toolbar(showPeriod = true) {
    return `<div class="director-toolbar">
      <label>Machine
        <select data-director-machine>
          <option value="">Toutes les machines</option>
          ${machines.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === machineId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
        </select>
      </label>
      ${showPeriod ? `<span class="director-period-note">Période : ${days} jours</span>` : ""}
    </div>`;
  }

  function machineStatus(machine) {
    if (!machine.has_measurement) return ["Inconnu", "unknown"];
    if (machine.status === "online") return ["En ligne (état enregistré)", "good"];
    if (machine.status === "offline") return ["Hors ligne", "warning"];
    return ["État non reconnu", "unknown"];
  }

  function eventStatus(item) {
    if (item.resolved_at) return "Mesures revenues sous seuil";
    return ({
      new: "À examiner",
      acknowledged: "Pris en charge",
      closed: "Seuil clôturé",
    })[item.alert_status] || "À examiner";
  }

  function machineRows(items) {
    if (!items.length) return '<tr><td colspan="3" class="empty-state">Aucune machine active pour ce filtre.</td></tr>';
    return items.map((machine) => {
      const [label, state] = machineStatus(machine);
      return `<tr>
        <td><strong>${escapeHtml(machine.name)}</strong></td>
        <td><span class="director-state ${state}">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(formatDate(machine.last_seen))}</td>
      </tr>`;
    }).join("");
  }

  function eventRows(events) {
    if (!events.length) return '<tr><td colspan="5" class="empty-state">Aucun dépassement critique enregistré sur cette période.</td></tr>';
    return events.map((item) => `<tr>
      <td>${escapeHtml(formatDate(item.detected_at))}</td>
      <td>${escapeHtml(item.machine_name)}</td>
      <td>${escapeHtml(item.metric)}</td>
      <td>${item.value === null ? "—" : escapeHtml(item.value)}</td>
      <td>${escapeHtml(eventStatus(item))}</td>
    </tr>`).join("");
  }

  function interventionRows(interventions) {
    if (!interventions.length) return '<tr><td colspan="5" class="empty-state">Aucune intervention enregistrée sur cette période.</td></tr>';
    return interventions.map((item) => `<tr>
      <td>${escapeHtml(item.title || "Intervention")}</td>
      <td>${escapeHtml(item.machine_name)}</td>
      <td>${escapeHtml(item.technician_name || "Non attribuée")}</td>
      <td>${escapeHtml(interventionStatuses[item.status] || "Statut inconnu")}</td>
      <td>${item.duration_minutes ? `${escapeHtml(item.duration_minutes)} min déclarées` : "Non renseignée"}</td>
    </tr>`).join("");
  }

  function showError(error) {
    pageRoot.innerHTML = `<section class="panel"><p class="inline-error" role="alert">${escapeHtml(error.message || "Vous ne pouvez pas consulter ces données pour le moment.")}</p>
      <button type="button" class="quiet" data-director-retry>Réessayer</button></section>`;
    $("[data-director-retry]", pageRoot).addEventListener("click", () => showPage(activePage));
  }

  function renderOverview({ overview, events }) {
    return `${toolbar()}
      <section class="director-kpis" aria-label="Indicateurs de production">
        ${metric("Disponibilité globale", "—", "Non calculable avec l’historique actuel", "unavailable")}
        ${metric("Machines suivies", overview.machine_count, `${overview.online_count} avec dernier état en ligne`)}
        ${metric("Alertes actives", overview.active_alert_count, "Seuils de surveillance")}
        ${metric("Coût des arrêts", "Non configuré", "Paramètres économiques nécessaires", "unavailable")}
      </section>
      <section class="director-note" role="status">
        <strong>Fiabilité des indicateurs</strong>
        <p>La couverture, la disponibilité, le MTBF et le MTTR ne sont pas calculables de façon fiable :
          le planning de production et les périodes de panne confirmées ne sont pas historisés.
          Vous ne verrez donc aucune valeur d’exemple présentée comme une mesure réelle.</p>
      </section>
      <div class="director-grid">
        <section class="director-card">
          <div class="director-card-heading"><div><p class="eyebrow">PARC</p><h2>État des machines</h2></div>
            <button type="button" class="director-link" data-director-goto="machines">Voir le parc</button></div>
          <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Machine</th><th>État enregistré</th><th>Dernière mesure</th></tr></thead>
            <tbody>${machineRows(overview.machines.slice(0, 6))}</tbody></table></div>
        </section>
        <section class="director-card">
          <div class="director-card-heading"><div><p class="eyebrow">SURVEILLANCE</p><h2>Événements récents</h2></div>
            <button type="button" class="director-link" data-director-goto="failures">Consulter</button></div>
          ${events.length ? `<ul class="director-event-list">${events.slice(0, 5).map((item) =>
            `<li><strong>${escapeHtml(item.machine_name)}</strong><span>${escapeHtml(item.metric)} · ${escapeHtml(formatDate(item.detected_at))}</span></li>`
          ).join("")}</ul>` : '<p class="empty-state">Aucun événement critique sur la période.</p>'}
          <p class="director-footnote">Ces événements proviennent de seuils critiques et ne constituent pas, à eux seuls, une panne confirmée.</p>
        </section>
      </div>`;
  }

  function renderAvailability(overview) {
    return `${toolbar()}
      <section class="director-kpis">
        ${metric("Disponibilité", "Non disponible", overview.availability.reason, "unavailable")}
        ${metric("Couverture des données", "Non calculable", "Cadence attendue et planning non configurés", "unavailable")}
        ${metric("MTBF", "Non disponible", overview.mtbf.reason, "unavailable")}
        ${metric("MTTR", "Non disponible", overview.mttr.reason, "unavailable")}
      </section>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">ÉTAT DU PARC</p><h2>Équipements suivis</h2></div></div>
        <p class="director-note-text">Vous consultez l’état enregistré par le système. Une perte de communication ou l’absence de mesure reste inconnue et ne constitue pas une panne.</p>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Machine</th><th>État enregistré</th><th>Dernière mesure</th></tr></thead>
          <tbody>${machineRows(overview.machines)}</tbody></table></div>
      </section>`;
  }

  function renderFailures({ overview, events }) {
    const counts = events.reduce((result, item) => {
      result[item.machine_name] = (result[item.machine_name] || 0) + 1;
      return result;
    }, {});
    const bars = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = Math.max(1, ...bars.map((item) => item[1]));
    return `${toolbar()}
      <section class="director-kpis">
        ${metric("Dépassements critiques enregistrés", overview.critical_event_count, "Événements à examiner")}
        ${metric("Pannes confirmées", "Non disponible", "Les événements actuels ne portent pas de confirmation", "unavailable")}
        ${metric("Durée des arrêts", "Non calculable", "Aucun historique de panne confirmé", "unavailable")}
        ${metric("Fréquence", "Événements ci-dessous", "Comptage des seuils critiques, pas des pannes", "unavailable")}
      </section>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">RÉPARTITION</p><h2>Événements critiques par machine</h2></div></div>
        ${bars.length ? `<div class="director-bars" role="img" aria-label="Nombre d’événements critiques par machine">
          ${bars.map(([name, count]) => `<div class="director-bar-row"><span>${escapeHtml(name)}</span><div><i style="width:${Math.round(count / max * 100)}%"></i></div><strong>${count}</strong></div>`).join("")}
        </div>` : '<p class="empty-state">Aucun événement critique sur la période.</p>'}
        <p class="director-footnote">Vous voyez jusqu’aux 300 événements critiques les plus récents pour cette période ; ce décompte ne classe pas les machines par pannes confirmées.</p>
      </section>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">HISTORIQUE</p><h2>Événements à examiner</h2></div></div>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Date</th><th>Machine</th><th>Grandeur</th><th>Valeur</th><th>État du seuil</th></tr></thead>
          <tbody>${eventRows(events)}</tbody></table></div>
        <p class="director-note-text">Vous ne devez pas interpréter un événement de seuil critique comme une panne confirmée. Le retour des mesures sous le seuil ne prouve pas une réparation et ne permet pas de déduire une durée d’arrêt.</p>
      </section>`;
  }

  function renderReport(report) {
    return `${toolbar()}
      <section class="director-card director-report">
        <div class="director-card-heading"><div><p class="eyebrow">RAPPORT PÉRIODIQUE</p><h2>Synthèse de maintenance</h2>
          <p class="director-subtitle">${escapeHtml(formatDate(report.period.start))} — ${escapeHtml(formatDate(report.period.end))}</p></div>
          <div class="director-actions"><button type="button" class="primary" data-director-export>Exporter CSV</button>
            <button type="button" class="quiet" data-director-print>Imprimer / enregistrer en PDF</button></div></div>
        <section class="director-kpis director-report-kpis">
          ${metric("Machines actives", report.machine_count, "Parc de la période sélectionnée")}
          ${metric("Alertes actives", report.active_alert_count, "Au moment de la consultation")}
          ${metric("Événements critiques", report.critical_event_count, "Non assimilés à des pannes confirmées")}
          ${metric("Interventions", Object.values(report.intervention_counts).reduce((sum, count) => sum + count, 0), "Créées pendant la période")}
        </section>
        <p class="director-note-text">Vous ne trouverez pas de disponibilité ou de coût calculé : les données requises ne sont pas configurées ou confirmées.</p>
        <h3>Interventions enregistrées</h3>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Intervention</th><th>Machine</th><th>Technicien</th><th>Statut</th><th>Durée déclarée</th></tr></thead>
          <tbody>${interventionRows(report.interventions)}</tbody></table></div>
        <h3>Événements critiques enregistrés</h3>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Date</th><th>Machine</th><th>Grandeur</th><th>Valeur</th><th>État du seuil</th></tr></thead>
          <tbody>${eventRows(report.events)}</tbody></table></div>
        <p class="director-footnote">Vous consultez au maximum ${report.row_limit} lignes par historique. Les lignes sont des événements de seuil et des interventions enregistrés.</p>
      </section>`;
  }

  function renderCosts() {
    return `<section class="director-card director-cost-card">
      <p class="eyebrow">IMPACT FINANCIER</p><h2>Coût des arrêts de production</h2>
      <div class="director-cost-state"><strong>Données économiques non configurées</strong>
        <p>Vous ne verrez aucun montant tant que les paramètres économiques n’auront pas été définis et validés.</p></div>
      <h3>Informations nécessaires</h3>
      <ul><li>Coût horaire d’arrêt par machine ou ligne de production.</li>
        <li>Cadence et valeur de production, si elles doivent être incluses.</li>
        <li>Convention de calcul des pertes et période de validité des paramètres.</li></ul>
      <p class="director-note-text">Vous pourrez consulter une estimation après configuration : durée d’arrêt confirmée × coût horaire configuré. Elle devra rester identifiée comme estimation, séparément d’un coût financier réel.</p>
    </section>`;
  }

  function renderMachines(overview) {
    return `${toolbar(false)}
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">PARC</p><h2>Vue globale des machines</h2></div>
          <span class="director-count">${overview.machine_count} équipement(s) actif(s)</span></div>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Machine</th><th>État</th><th>Dernière mesure</th></tr></thead>
          <tbody>${machineRows(overview.machines)}</tbody></table></div>
        <p class="director-footnote">Vous consultez ces équipements en lecture seule. Les états enregistrés ne suffisent pas seuls à calculer la disponibilité.</p>
      </section>`;
  }

  function renderNotifications(notifications) {
    const unread = notifications.filter((item) => !item.read);
    $("#director-notification-count").textContent = String(unread.length);
    $("#director-notification-count").classList.toggle("hidden", unread.length === 0);
    return `<section class="director-card">
      <div class="director-card-heading"><div><p class="eyebrow">COMPTE</p><h2>Notifications</h2></div>
        <span class="director-count">${unread.length} non lue(s)</span></div>
      ${notifications.length ? `<div class="director-notifications">${notifications.map((item) => `<article class="director-notification ${item.read ? "read" : "unread"}">
        <div><strong>${escapeHtml(notificationTypes[item.type] || "Information")}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(formatDate(item.created_at))}</small></div>
        ${item.read ? '<span class="director-state">Lue</span>' : `<button type="button" class="quiet" data-director-read="${escapeHtml(item.id)}">Marquer comme lue</button>`}
      </article>`).join("")}</div>` : '<p class="empty-state">Aucune notification.</p>'}
    </section>`;
  }

  function exportReport(report) {
    const csvValue = (cell) => {
      let value = String(cell ?? "");
      if (typeof cell !== "number" && /^[\s]*[=+\-@]/.test(value)) value = `'${value}`;
      return `"${value.replace(/"/g, '""')}"`;
    };
    const rows = [
      ["Section", "Période", "Machine", "Élément", "Statut", "Date", "Détail"],
      ["Synthèse", `${report.period.start} - ${report.period.end}`, "", "Machines actives", report.machine_count, "", ""],
      ["Synthèse", "", "", "Alertes actives", report.active_alert_count, "", ""],
      ["Synthèse", "", "", "Événements critiques", report.critical_event_count, "", "Non confirmés comme pannes"],
      ...report.interventions.map((item) => ["Intervention", "", item.machine_name, item.title, interventionStatuses[item.status] || "Statut inconnu", item.created_at, item.technician_name]),
      ...report.events.map((item) => ["Événement critique", "", item.machine_name, item.metric, eventStatus(item), item.detected_at, item.description]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvValue).join(";")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `rapport-maintenance-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function showPage(page) {
    if (!Object.prototype.hasOwnProperty.call(pages, page) || !context) return;
    activePage = page;
    $("#director-page-title").textContent = pages[page][0];
    $("#director-page-subtitle").textContent = pages[page][1];
    $("#director-period-control").classList.toggle("hidden", !periodPages.has(page));
    document.querySelectorAll("[data-director-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.directorPage === page);
    });
    sidebar.classList.remove("open");
    pageRoot.setAttribute("aria-busy", "true");
    pageRoot.innerHTML = '<p class="director-loading" role="status">Chargement des données…</p>';
    try {
      if (page === "profile") {
        pageRoot.innerHTML = '<section class="director-card"><div id="director-profile-content"></div></section>';
        await window.PrediMaintProfile.render({
          container: "#director-profile-content",
          api: context.api,
          showToast: context.showToast,
          onProfileUpdated: (updated) => {
            $("#director-header-name").textContent = updated.full_name || updated.email;
            $("#director-sidebar-name").textContent = updated.full_name || updated.email;
            const initials = String(updated.full_name || updated.email || "D").trim()
              .split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
            $("#director-header-avatar").textContent = initials;
            $("#director-sidebar-avatar").textContent = initials;
          },
          onPasswordChanged: () => window.setTimeout(context.logout, 1200),
        });
        return;
      }
      if (page === "costs") {
        pageRoot.innerHTML = renderCosts();
        return;
      }
      if (page === "notifications") {
        const notifications = await context.api("/notifications");
        pageRoot.innerHTML = renderNotifications(notifications);
        pageRoot.querySelectorAll("[data-director-read]").forEach((button) => {
          button.addEventListener("click", async () => {
            try {
              await context.api(`/notifications/${encodeURIComponent(button.dataset.directorRead)}/read`, { method: "POST" });
              await showPage("notifications");
            } catch (error) {
              showError(error);
            }
          });
        });
        return;
      }

      if (machineFilterPages.has(page) && !machines.length) {
        machines = await context.api("/machines");
      }
      if (page === "failures") {
        const [overview, events] = await Promise.all([
          context.api(`/director/overview?${query()}`),
          context.api(`/director/events?${query()}&limit=300`),
        ]);
        pageRoot.innerHTML = renderFailures({ overview, events });
      } else if (page === "reports") {
        pageRoot.innerHTML = renderReport(await context.api(`/director/report?${query()}`));
      } else {
        const overview = await context.api(`/director/overview?${query()}`);
        pageRoot.innerHTML = page === "availability"
          ? renderAvailability(overview)
          : page === "machines"
            ? renderMachines(overview)
            : renderOverview({
              overview,
              events: await context.api(`/director/events?${query()}&limit=8`),
            });
      }

      const machineFilter = $("[data-director-machine]", pageRoot);
      if (machineFilter) {
        machineFilter.addEventListener("change", async (event) => {
          machineId = event.currentTarget.value;
          await showPage(activePage);
        });
      }
      const exportButton = $("[data-director-export]", pageRoot);
      if (exportButton) {
        exportButton.addEventListener("click", async () => {
          try {
            const report = await context.api(`/director/report?${query()}`);
            exportReport(report);
          } catch (error) {
            showError(error);
          }
        });
        $("[data-director-print]", pageRoot).addEventListener("click", () => window.print());
      }
      pageRoot.querySelectorAll("[data-director-goto]").forEach((button) => {
        button.addEventListener("click", () => showPage(button.dataset.directorGoto));
      });
    } catch (error) {
      showError(error);
    } finally {
      pageRoot.removeAttribute("aria-busy");
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    $("#director-menu-toggle").addEventListener("click", () => sidebar.classList.toggle("open"));
    $("#director-period").addEventListener("change", async (event) => {
      days = Number(event.currentTarget.value);
      await showPage(activePage);
    });
    document.querySelectorAll("[data-director-page]").forEach((button) => {
      button.addEventListener("click", () => showPage(button.dataset.directorPage));
    });
    document.addEventListener("click", (event) => {
      if (!directorApp.classList.contains("hidden")
        && sidebar.classList.contains("open")
        && !sidebar.contains(event.target)
        && !$("#director-menu-toggle").contains(event.target)) {
        sidebar.classList.remove("open");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") sidebar.classList.remove("open");
    });
    window.addEventListener("predimaint:logout", () => {
      clearInterval(refreshTimer);
      context = null;
      machines = [];
      sidebar.classList.remove("open");
    });
  }

  window.addEventListener("predimaint:director-authenticated", async (event) => {
    context = event.detail;
    bindListeners();
    const user = context.user;
    const name = user.full_name || user.email || "Directeur de production";
    const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "D";
    $("#director-header-name").textContent = name;
    $("#director-sidebar-name").textContent = name;
    $("#director-header-avatar").textContent = initials;
    $("#director-sidebar-avatar").textContent = initials;
    await showPage("overview");
    clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
      if (activePage === "overview" && !document.hidden && context) showPage("overview");
    }, 30000);
  });
})();
