(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const measurementUi = window.PrediMaintMeasurements;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const pages = {
    overview: ["Vue d’ensemble", "Suivez la performance du parc de production."],
    availability: ["Indicateurs de disponibilité", "Suivez la télémétrie, la couverture et les durées observées."],
    failures: ["Durée et fréquence des pannes", "Distinguez les alertes critiques des pannes confirmées."],
    reports: ["Rapports de maintenance", "Consultez et exportez les données réelles de la période."],
    costs: ["Coût des arrêts", "Calculez les coûts à partir des arrêts confirmés et des tarifs par machine."],
    machines: ["Vue globale des machines", "Consultez l’état enregistré des équipements actifs."],
    notifications: ["Notifications", "Consultez les messages adressés à votre compte."],
    profile: ["Mon profil", "Gérez vos informations personnelles et la sécurité de votre compte."],
  };
  const periodPages = new Set(["overview", "availability", "failures", "reports", "costs"]);
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
  const REFRESH_INTERVAL_MS = 10000;
  const directorApp = $("#director-app");
  const sidebar = $("#director-sidebar");
  const pageRoot = $("#director-page");
  let context = null;
  let activePage = "overview";
  let days = 30;
  let machineId = "";
  let costEditorMachineId = "";
  let acquisitionMode = "hardware";
  let machines = [];
  let refreshTimer = null;
  let pageRequestInFlight = false;
  let pageRequestVersion = 0;
  let queuedPage = "";
  let queuedPreserveView = false;
  let listenersBound = false;

  function query() {
    const params = new URLSearchParams({ days: String(days) });
    if (machineId) params.set("machine_id", machineId);
    if (acquisitionMode !== "all") params.set("acquisition_mode", acquisitionMode);
    return params.toString();
  }

  function formatDate(value) {
    const formatted = measurementUi.formatDate(value);
    return formatted === "—" ? "Non renseignée" : formatted;
  }

  function metric(label, value, note, state = "") {
    return `<article class="director-stat ${state}">
      <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
    </article>`;
  }

  function formatHours(value) {
    return `${Number(value || 0).toFixed(2)} h`;
  }

  function formatDetailedHours(value) {
    return `${Number(value || 0).toFixed(4)} h`;
  }

  function money(value, currency) {
    return `${Number(value || 0).toFixed(3)} ${currency}`;
  }

  function toolbar(showPeriod = true, showMode = true) {
    return `<div class="director-toolbar">
      <label>Machine
        <select data-director-machine>
          <option value="">Toutes les machines</option>
          ${machines.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === machineId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
        </select>
      </label>
      ${showMode && (showPeriod || activePage === "machines") ? `<label>Origine
        <select data-director-mode>
          <option value="hardware" ${acquisitionMode === "hardware" ? "selected" : ""}>Réel</option>
          <option value="simulated" ${acquisitionMode === "simulated" ? "selected" : ""}>Simulé</option>
          <option value="all" ${acquisitionMode === "all" ? "selected" : ""}>Toutes</option>
          <option value="unknown" ${acquisitionMode === "unknown" ? "selected" : ""}>Origine inconnue</option>
        </select>
      </label>` : ""}
      ${showPeriod ? `<span class="director-period-note">Période : ${days} jours</span>` : ""}
    </div>`;
  }

  function machineStatus(machine) {
    if (machine.status === "offline") return ["Hors ligne (MQTT)", "warning"];
    if (machine.telemetry_state === "stale") return ["Télémétrie obsolète", "warning"];
    if (machine.telemetry_state === "missing") return ["Aucune télémétrie récente", "unknown"];
    if (machine.status === "online") return ["En ligne · télémétrie à jour", "good"];
    return ["État MQTT inconnu", "unknown"];
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
      const freshness = machine.measurement_recorded_at
        ? measurementUi.freshness({
          age_seconds: machine.measurement_age_seconds,
          _client_received_at: machine._client_received_at,
        }).label
        : "Aucune mesure récente";
      return `<tr>
        <td><strong>${escapeHtml(machine.name)}</strong></td>
        <td><span class="director-state ${state}">${escapeHtml(label)}</span></td>
        <td>${machine.measurement_recorded_at
    ? `${measurementUi.modeBadge(machine.last_measurement_mode)} · ${escapeHtml(formatDate(machine.measurement_recorded_at))} · ${escapeHtml(freshness)}`
    : "Aucune mesure récente"}
        </td>
      </tr>`;
    }).join("");
  }

  function eventRows(events) {
    if (!events.length) return '<tr><td colspan="5" class="empty-state">Aucun dépassement critique enregistré sur cette période.</td></tr>';
    return events.map((item) => `<tr>
      <td>${escapeHtml(formatDate(item.detected_at))}</td>
      <td>${escapeHtml(item.machine_name)}</td>
      <td>${escapeHtml(item.metric)}</td>
      <td>${item.value === null ? "—" : escapeHtml(measurementUi.metricValue(item.metric, item.value))}</td>
      <td>${escapeHtml(eventStatus(item))} · ${escapeHtml(measurementUi.modeLabel(item.acquisition_mode))}</td>
    </tr>`).join("");
  }

  function interventionRows(interventions) {
    if (!interventions.length) return '<tr><td colspan="7" class="empty-state">Aucune intervention enregistrée sur cette période.</td></tr>';
    return interventions.map((item) => `<tr>
      <td>${escapeHtml(item.title || "Intervention")}</td>
      <td>${escapeHtml(item.machine_name)}</td>
      <td>${escapeHtml(item.technician_name || "Non attribuée")}</td>
      <td>${escapeHtml(interventionStatuses[item.status] || "Statut inconnu")}</td>
      <td>${item.accepted_at ? escapeHtml(formatDate(item.accepted_at)) : "—"}</td>
      <td>${item.completed_at ? escapeHtml(formatDate(item.completed_at)) : "—"}</td>
      <td>${item.completed_at ? `${escapeHtml(item.duration_minutes ?? 0)} min calculées` : item.duration_minutes ? `${escapeHtml(item.duration_minutes)} min déclarées` : "Non renseignée"}</td>
    </tr>`).join("");
  }

  function showError(error) {
    pageRoot.innerHTML = `<section class="panel"><p class="inline-error" role="alert">${escapeHtml(error.message || "Vous ne pouvez pas consulter ces données pour le moment.")}</p>
      <button type="button" class="quiet" data-director-retry>Réessayer</button></section>`;
    $("[data-director-retry]", pageRoot).addEventListener("click", () => showPage(activePage));
  }

  function renderOverview({ overview, events }) {
    const costCurrencies = Object.entries(overview.downtime_cost.costs_by_currency || {})
      .map(([currency, value]) => money(value, currency));
    const missingRate = overview.downtime_cost.unpriced_downtime_hours > 0;
    const costValue = missingRate
      ? "Tarif à renseigner"
      : costCurrencies.join(" · ") || "Aucun arrêt confirmé";
    return `${toolbar()}
      <section class="director-kpis" aria-label="Indicateurs de production">
        ${metric("Disponibilité de supervision", `${overview.availability.value.toFixed(2)} %`, `Couverture : ${overview.availability.coverage.toFixed(2)} % · délai ${overview.availability.stale_after_seconds} s`)}
        ${metric("Machines suivies", overview.machine_count, `${overview.online_count} état(s) MQTT en ligne · ${overview.stale_telemetry_count} télémétrie(s) obsolète(s)`)}
        ${metric("Alertes actives", overview.active_alert_count, "Seuils de surveillance")}
        ${metric("Coût confirmé", costValue, `${overview.failure_metrics.confirmed_downtime_hours.toFixed(2)} h d’arrêt · ${formatDetailedHours(overview.downtime_cost.unpriced_downtime_hours)} sans tarif`, missingRate ? "unavailable" : "")}
      </section>
      <section class="director-note" role="status">
        <strong>Lecture des indicateurs</strong>
        <p>${escapeHtml(overview.availability.basis)} Une mesure n’est considérée à jour que pendant le délai configuré.
          Les pannes et coûts reposent uniquement sur les pannes confirmées et les tarifs enregistrés.</p>
      </section>
      <div class="director-grid">
        <section class="director-card">
          <div class="director-card-heading"><div><p class="eyebrow">PARC</p><h2>État des machines</h2></div>
            <button type="button" class="director-link" data-director-goto="machines">Voir le parc</button></div>
          <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Machine</th><th>État MQTT</th><th>Dernière mesure</th></tr></thead>
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
        ${metric("Disponibilité de supervision", `${overview.availability.value.toFixed(2)} %`, `Couverture d’état : ${overview.availability.coverage.toFixed(2)} %`)}
        ${metric("MTBF", overview.mtbf.value_hours === null ? overview.mtbf.reason : formatHours(overview.mtbf.value_hours), overview.mtbf.value_hours === null ? "Aucune moyenne n’est inventée." : `${overview.failure_metrics.confirmed_failure_count} panne(s) confirmée(s)`)}
        ${metric("MTTR", overview.mttr.value_hours === null ? overview.mttr.reason : formatHours(overview.mttr.value_hours), overview.mttr.value_hours === null ? "Aucune moyenne n’est inventée." : `${overview.failure_metrics.resolved_failure_count} rétablissement(s) enregistré(s)`)}
        ${metric("Fonctionnement avec télémétrie", formatHours(overview.availability.online_hours), `Délai de fraîcheur : ${overview.availability.stale_after_seconds} s`)}
        ${metric("Indisponible ou sans télémétrie", formatHours(overview.availability.unavailable_hours), `${overview.availability.unobserved_hours.toFixed(2)} h sans état exploitable`)}
        ${metric("Pannes confirmées", overview.failure_metrics.confirmed_failure_count, `${overview.failure_metrics.frequency_per_30_days.toFixed(2)} panne(s) / 30 jours`)}
      </section>
      <p class="director-note-text">La disponibilité est une borne de supervision calculée sur la durée de télémétrie fraîche. Une coupure, un capteur silencieux et une panne physique ne sont pas confondus : seuls les incidents explicitement confirmés comptent comme pannes.</p>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">ÉTAT DU PARC</p><h2>Équipements suivis</h2></div></div>
        <p class="director-note-text">Une mesure devient obsolète après ${overview.availability.stale_after_seconds} s sans nouvelle télémétrie. Le délai se règle dans les paramètres Administrateur.</p>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Machine</th><th>État MQTT</th><th>Dernière mesure</th></tr></thead>
          <tbody>${machineRows(overview.machines)}</tbody></table></div>
      </section>`;
  }

  function renderFailures({ overview, events }) {
    const counts = overview.downtime_cost.machines.reduce((result, item) => {
      if (item.downtime_hours > 0) result[item.machine_name] = item.downtime_hours;
      return result;
    }, {});
    const bars = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = Math.max(1, ...bars.map((item) => item[1]));
    const failureRows = overview.failure_metrics.failures.length
      ? overview.failure_metrics.failures.map((item) => `<tr>
          <td>${escapeHtml(formatDate(item.detected_at))}</td>
          <td>${escapeHtml(item.machine_name)}</td>
          <td>${escapeHtml(item.failure_type)}</td>
          <td>${escapeHtml(item.status === "resolved" ? "Rétablie" : "En cours")}</td>
          <td>${item.resolved_at ? escapeHtml(formatDate(item.resolved_at)) : "Arrêt en cours"}</td>
        </tr>`).join("")
      : '<tr><td colspan="5" class="empty-state">Aucune panne confirmée sur cette période.</td></tr>';
    return `${toolbar()}
      <section class="director-kpis">
        ${metric("Dépassements critiques", overview.critical_event_count, "Événements de seuil à examiner")}
        ${metric("Pannes confirmées", overview.failure_metrics.confirmed_failure_count, "Incidents explicitement déclarés")}
        ${metric("Durée des arrêts confirmés", formatHours(overview.failure_metrics.confirmed_downtime_hours), "Les pertes de télémétrie sont exclues")}
        ${metric("Fréquence des pannes", `${overview.failure_metrics.frequency_per_30_days.toFixed(2)} / 30 j`, "Pannes confirmées, normalisées à 30 jours")}
      </section>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">RÉPARTITION</p><h2>Durée d’arrêt confirmé par machine</h2></div></div>
        ${bars.length ? `<div class="director-bars" role="img" aria-label="Durée d’arrêt confirmé par machine">
          ${bars.map(([name, hours]) => `<div class="director-bar-row"><span>${escapeHtml(name)}</span><div><i style="width:${Math.round(hours / max * 100)}%"></i></div><strong>${Number(hours).toFixed(2)} h</strong></div>`).join("")}
        </div>` : '<p class="empty-state">Aucun arrêt de panne confirmé sur la période.</p>'}
        <p class="director-footnote">Le temps d’arrêt est calculé entre la déclaration et le rétablissement, ou jusqu’à maintenant pour une panne encore ouverte.</p>
      </section>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">INCIDENTS CONFIRMÉS</p><h2>Historique des pannes</h2></div></div>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Date</th><th>Machine</th><th>Type</th><th>État</th><th>Rétablissement</th></tr></thead>
          <tbody>${failureRows}</tbody></table></div>
      </section>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">SURVEILLANCE</p><h2>Dépassements critiques à examiner</h2></div></div>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Date</th><th>Machine</th><th>Grandeur</th><th>Valeur</th><th>État / origine</th></tr></thead>
          <tbody>${eventRows(events)}</tbody></table></div>
        <p class="director-note-text">Un dépassement de seuil n’est pas assimilé à une panne confirmée. Le retour d’une mesure sous le seuil n’est pas une preuve de réparation.</p>
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
          ${metric("Pannes confirmées", report.failure_metrics.confirmed_failure_count, "Incidents déclarés par le Responsable")}
          ${metric("Interventions", Object.values(report.intervention_counts).reduce((sum, count) => sum + count, 0), "Créées pendant la période")}
          ${metric("Arrêts confirmés", formatHours(report.failure_metrics.confirmed_downtime_hours), "Durée observée")}
        </section>
        <p class="director-note-text">Disponibilité de supervision : ${report.availability.value.toFixed(2)} % · couverture : ${report.availability.coverage.toFixed(2)} % · indisponibilité ou absence de télémétrie : ${formatHours(report.availability.unavailable_hours)}.</p>
        <p class="director-note-text">MTBF : ${report.mtbf.value_hours === null ? escapeHtml(report.mtbf.reason) : formatHours(report.mtbf.value_hours)} · MTTR : ${report.mttr.value_hours === null ? escapeHtml(report.mttr.reason) : formatHours(report.mttr.value_hours)}.</p>
        <p class="director-note-text">Coûts estimés : ${Object.entries(report.downtime_cost.costs_by_currency).map(([currency, value]) => money(value, currency)).join(" · ") || (report.downtime_cost.unpriced_downtime_hours > 0 ? "Tarif à renseigner" : "Aucun arrêt confirmé sur la période")} · ${formatDetailedHours(report.downtime_cost.unpriced_downtime_hours)} sans tarif.</p>
        <h3>Interventions enregistrées</h3>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Intervention</th><th>Machine</th><th>Technicien</th><th>Statut</th><th>Acceptée le</th><th>Terminée le</th><th>Durée (min)</th></tr></thead>
          <tbody>${interventionRows(report.interventions)}</tbody></table></div>
        <h3>Événements critiques enregistrés</h3>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Date</th><th>Machine</th><th>Grandeur</th><th>Valeur</th><th>État / origine</th></tr></thead>
          <tbody>${eventRows(report.events)}</tbody></table></div>
        <h3>Pannes confirmées enregistrées</h3>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Date</th><th>Machine</th><th>Type</th><th>État</th><th>Rétablissement</th></tr></thead>
          <tbody>${report.failure_metrics.failures.length ? report.failure_metrics.failures.map((item) => `<tr><td>${escapeHtml(formatDate(item.detected_at))}</td><td>${escapeHtml(item.machine_name)}</td><td>${escapeHtml(item.failure_type)}</td><td>${escapeHtml(item.status === "resolved" ? "Rétablie" : "En cours")}</td><td>${item.resolved_at ? escapeHtml(formatDate(item.resolved_at)) : "Arrêt en cours"}</td></tr>`).join("") : '<tr><td colspan="5" class="empty-state">Aucune panne confirmée sur cette période.</td></tr>'}</tbody></table></div>
        <p class="director-footnote">Vous consultez au maximum ${report.row_limit} lignes par historique. Les lignes sont des événements de seuil et des interventions enregistrés.</p>
      </section>`;
  }

  function renderCosts(overview, rates, history) {
    const rateByMachine = new Map(rates.map((item) => [item.machine_id, item]));
    const formMachineId = machineId || costEditorMachineId || rates[0]?.machine_id || "";
    const selectedRate = rateByMachine.get(formMachineId);
    const costRows = overview.downtime_cost.machines.length
      ? overview.downtime_cost.machines.map((item) => {
        const rate = rateByMachine.get(item.machine_id);
        const amounts = Object.entries(item.costs_by_currency)
          .map(([currency, value]) => money(value, currency)).join(" · ");
        return `<tr><td>${escapeHtml(item.machine_name)}</td>
          <td>${formatHours(item.downtime_hours)}</td>
          <td>${rate?.hourly_rate !== null && rate?.hourly_rate !== undefined ? `${Number(rate.hourly_rate).toFixed(3)} ${escapeHtml(rate.currency)}/h` : "Non configuré"}</td>
          <td>${amounts || (item.unpriced_downtime_hours > 0 ? "Tarif à renseigner" : "—")}</td>
          <td>${formatDetailedHours(item.unpriced_downtime_hours)}</td></tr>`;
      }).join("")
      : '<tr><td colspan="5" class="empty-state">Aucune machine active pour ce filtre.</td></tr>';
    const historyRows = history.length
      ? history.map((item) => `<tr><td>${escapeHtml(formatDate(item.updated_at))}</td>
          <td>${escapeHtml(item.machine_name)}</td>
          <td>${money(item.hourly_rate, item.currency)} / h</td>
          <td>${escapeHtml(item.updated_by)}</td></tr>`).join("")
      : '<tr><td colspan="4" class="empty-state">Aucune modification de tarif enregistrée.</td></tr>';
    const totals = Object.entries(overview.downtime_cost.costs_by_currency)
      .map(([currency, value]) => money(value, currency)).join(" · ")
      || (overview.downtime_cost.unpriced_downtime_hours > 0
        ? "Tarif à renseigner"
        : "Aucun arrêt confirmé sur la période");
    return `${toolbar(true, false)}
      <section class="director-kpis">
        ${metric("Durée d’arrêt confirmé", formatHours(overview.failure_metrics.confirmed_downtime_hours), "Pannes confirmées uniquement")}
        ${metric("Coûts calculés", totals, `${formatDetailedHours(overview.downtime_cost.configured_downtime_hours)} tarifées`)}
        ${metric("Durée sans tarif", formatDetailedHours(overview.downtime_cost.unpriced_downtime_hours), "À compléter pour chiffrer")}
      </section>
      <section class="director-card director-cost-card">
        <p class="eyebrow">PARAMÈTRES ÉCONOMIQUES</p><h2>Tarif horaire par machine</h2>
        <p class="director-note-text">Le montant est une estimation : durée d’arrêt confirmé × tarif horaire. Les devises sont totalisées séparément. TND est proposé par défaut, sans imposer de tarif.</p>
        ${machines.length ? `<form class="director-cost-form" id="director-cost-form">
          <label>Machine<select name="machine_id" required>
            ${machines.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === formMachineId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
          </select></label>
          <label>Tarif horaire<input name="hourly_rate" type="number" min="0" max="99999999999.999" step="0.001" required value="${selectedRate?.hourly_rate !== null && selectedRate?.hourly_rate !== undefined ? escapeHtml(selectedRate.hourly_rate) : ""}"></label>
          <label>Devise (code ISO)<input name="currency" type="text" minlength="3" maxlength="3" pattern="[A-Z]{3}" required value="${escapeHtml(selectedRate?.currency || "TND")}" autocomplete="off"></label>
          <button type="submit" class="primary">Enregistrer le tarif</button>
          <span id="director-cost-message" class="muted" role="status"></span>
        </form>` : '<p class="empty-state">Aucune machine active : aucun tarif ne peut être configuré.</p>'}
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Machine</th><th>Arrêt confirmé</th><th>Tarif actuel</th><th>Coût estimé</th><th>Durée sans tarif</th></tr></thead>
          <tbody>${costRows}</tbody></table></div>
        <p class="director-note-text">${formatDetailedHours(overview.downtime_cost.unpriced_downtime_hours)} restent sans tarif et ne sont pas incluses dans les montants calculés.</p>
      </section>
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">TRAÇABILITÉ</p><h2>Historique des tarifs</h2></div></div>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Date de modification</th><th>Machine</th><th>Tarif horaire</th><th>Directeur</th></tr></thead><tbody>${historyRows}</tbody></table></div>
      </section>`;
  }

  function renderMachines(overview) {
    return `${toolbar(false)}
      <section class="director-card">
        <div class="director-card-heading"><div><p class="eyebrow">PARC</p><h2>Vue globale des machines</h2></div>
          <span class="director-count">${overview.machine_count} équipement(s) actif(s)</span></div>
        <div class="director-table-wrap"><table class="director-table"><thead><tr><th>Machine</th><th>État MQTT</th><th>Dernière mesure</th></tr></thead>
          <tbody>${machineRows(overview.machines)}</tbody></table></div>
        <p class="director-footnote">Vous consultez ces équipements en lecture seule. La disponibilité de supervision et la fraîcheur des données sont calculées sur la période sélectionnée.</p>
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
      ["Synthèse", "", "", "Disponibilité de supervision (%)", report.availability.value, "", `Couverture ${report.availability.coverage}%`],
      ["Synthèse", "", "", "Pannes confirmées", report.failure_metrics.confirmed_failure_count, "", ""],
      ["Synthèse", "", "", "Durée d'arrêt confirmé (h)", report.failure_metrics.confirmed_downtime_hours, "", ""],
      ["Synthèse", "", "", "MTBF (h)", report.mtbf.value_hours ?? "", "", report.mtbf.reason || ""],
      ["Synthèse", "", "", "MTTR (h)", report.mttr.value_hours ?? "", "", report.mttr.reason || ""],
      ...Object.entries(report.downtime_cost.costs_by_currency).map(([currency, value]) =>
        ["Coût estimé", "", "", currency, value, "", "Estimation basée sur tarif horaire par machine"]),
      ...report.interventions.map((item) => ["Intervention", "", item.machine_name, item.title, interventionStatuses[item.status] || "Statut inconnu", item.accepted_at || item.created_at, `Technicien : ${item.technician_name}; acceptée : ${item.accepted_at || "non suivie"}; terminée : ${item.completed_at || "non suivie"}; durée : ${item.completed_at ? `${item.duration_minutes ?? 0} min calculées` : item.duration_minutes ? `${item.duration_minutes} min déclarées` : "non renseignée"}`]),
      ...report.events.map((item) => ["Événement critique", "", item.machine_name, item.metric, eventStatus(item), item.detected_at, item.description]),
      ...report.failure_metrics.failures.map((item) => ["Panne confirmée", "", item.machine_name, item.failure_type, item.status, item.detected_at, item.resolved_at || "En cours"]),
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

  async function showPage(page, preserveView = false) {
    if (!Object.prototype.hasOwnProperty.call(pages, page) || !context) return;
    const requestVersion = ++pageRequestVersion;
    activePage = page;
    if (pageRequestInFlight) {
      queuedPage = page;
      queuedPreserveView = preserveView;
      return;
    }
    const scrollY = preserveView ? window.scrollY : 0;
    pageRequestInFlight = true;
    $("#director-page-title").textContent = pages[page][0];
    $("#director-page-subtitle").textContent = pages[page][1];
    $("#director-period-control").classList.toggle("hidden", !periodPages.has(page));
    document.querySelectorAll("[data-director-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.directorPage === page);
    });
    if (!preserveView) sidebar.classList.remove("open");
    pageRoot.setAttribute("aria-busy", "true");
    if (!preserveView) {
      pageRoot.innerHTML = '<p class="director-loading" role="status">Chargement des données…</p>';
    }
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
      if (page === "notifications") {
        const notifications = await context.api("/notifications");
        if (requestVersion !== pageRequestVersion) return;
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

      if (machineFilterPages.has(page)) {
        machines = await context.api("/machines");
        if (requestVersion !== pageRequestVersion) return;
      }
      if (page === "costs") {
        const historyQuery = machineId ? `?machine_id=${encodeURIComponent(machineId)}` : "";
        const [overview, rates, history] = await Promise.all([
          context.api(`/director/costs?${query()}`),
          context.api("/director/cost-rates"),
          context.api(`/director/cost-rates/history${historyQuery}`),
        ]);
        if (requestVersion !== pageRequestVersion) return;
        pageRoot.innerHTML = renderCosts(overview, rates, history);
        const form = $("#director-cost-form", pageRoot);
        if (form) {
          const machineSelect = form.elements.machine_id;
          const rateInput = form.elements.hourly_rate;
          const currencyInput = form.elements.currency;
          const updateRateFields = () => {
            costEditorMachineId = machineSelect.value;
            form.dataset.dirty = "true";
            const rate = rates.find((item) => item.machine_id === machineSelect.value);
            rateInput.value = rate?.hourly_rate ?? "";
            currencyInput.value = rate?.currency || "TND";
          };
          machineSelect.addEventListener("change", updateRateFields);
          form.addEventListener("input", () => { form.dataset.dirty = "true"; });
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const submit = form.querySelector('button[type="submit"]');
            const message = $("#director-cost-message", form);
            submit.disabled = true;
            message.textContent = "";
            try {
              const values = new FormData(form);
              await context.api(`/director/machines/${encodeURIComponent(values.get("machine_id"))}/cost-rate`, {
                method: "PUT",
                body: JSON.stringify({
                  hourly_rate: Number(values.get("hourly_rate")),
                  currency: String(values.get("currency")).trim().toUpperCase(),
                }),
              });
              form.dataset.dirty = "false";
              costEditorMachineId = String(values.get("machine_id"));
              context.showToast("Tarif horaire enregistré.");
              await showPage("costs");
            } catch (error) {
              message.textContent = error.message;
              message.classList.add("error");
              submit.disabled = false;
            }
          });
        }
      } else if (page === "failures") {
        const [overview, events] = await Promise.all([
          context.api(`/director/overview?${query()}`),
          context.api(`/director/events?${query()}&limit=300`),
        ]);
        if (requestVersion !== pageRequestVersion) return;
        pageRoot.innerHTML = renderFailures({ overview, events });
      } else if (page === "reports") {
        const report = await context.api(`/director/report?${query()}`);
        if (requestVersion !== pageRequestVersion) return;
        pageRoot.innerHTML = renderReport(report);
      } else {
        const overview = await context.api(`/director/overview?${query()}`);
        if (requestVersion !== pageRequestVersion) return;
        let events = [];
        if (page === "overview") {
          events = await context.api(`/director/events?${query()}&limit=8`);
          if (requestVersion !== pageRequestVersion) return;
        }
        pageRoot.innerHTML = page === "availability"
          ? renderAvailability(overview)
          : page === "machines"
            ? renderMachines(overview)
            : renderOverview({ overview, events });
      }

      const machineFilter = $("[data-director-machine]", pageRoot);
      if (machineFilter) {
        machineFilter.addEventListener("change", async (event) => {
          machineId = event.currentTarget.value;
          await showPage(activePage);
        });
      }
      const modeFilter = $("[data-director-mode]", pageRoot);
      if (modeFilter) {
        modeFilter.addEventListener("change", async (event) => {
          acquisitionMode = event.currentTarget.value;
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
      pageRequestInFlight = false;
      if (preserveView) window.scrollTo(0, scrollY);
      if (queuedPage && context) {
        const nextPage = queuedPage;
        const nextPreserveView = queuedPreserveView;
        queuedPage = "";
        queuedPreserveView = false;
        void showPage(nextPage, nextPreserveView);
      }
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
      const dataPage = periodPages.has(activePage) || activePage === "machines";
      const editingCost = Boolean($('#director-cost-form[data-dirty="true"]'));
      const focusedControl = pageRoot.contains(document.activeElement)
        && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
      if (dataPage && !editingCost && !focusedControl && !document.hidden && context) {
        showPage(activePage, true);
      }
    }, REFRESH_INTERVAL_MS);
  });
})();
