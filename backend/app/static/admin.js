(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const measurementUi = window.PrediMaintMeasurements;
  const pageTitles = {
    overview: ["Vue d'ensemble", "Bienvenue, administrateur système !"],
    users: ["Gestion des utilisateurs", "Consultez et gérez les comptes de la plateforme."],
    "add-user": ["Ajouter un utilisateur", "Créez un compte et définissez son rôle d'accès."],
    roles: ["Rôles et permissions", "Vue des niveaux d'accès définis dans PrediMaint."],
    logins: ["Historique des connexions", "Connexions réussies et tentatives échouées."],
    activity: ["Journal d'activité", "Traçabilité des opérations administratives."],
    notifications: ["Notifications", "Messages adressés aux utilisateurs et état de livraison."],
    backups: ["Sauvegarde de la base de données", "Administration / Gestion des sauvegardes PostgreSQL."],
    "sensor-replacements": ["Remplacement d'un capteur", "Conservez l'ancien capteur, ses mesures et la traçabilité du remplacement."],
    profile: ["Mon profil", "Gérez vos informations et la sécurité de votre compte."],
    settings: ["Paramètres", "Préférences de l'espace administrateur."],
  };
  const roleNames = {
    technician: "Technicien",
    manager: "Responsable",
    director: "Directeur",
    admin: "Administrateur",
  };
  let currentPage = "overview";
  let notificationCount = 0;
  let searchTimer;
  let backupRefreshTimer;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const formatDate = (value) => measurementUi.formatDate(value);
  const formatRole = (role) => roleNames[role] || role;

  async function api(path, options = {}) {
    const token = localStorage.getItem("pm_token");
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      $("#logout").click();
      throw new Error("Session expirée. Reconnectez-vous.");
    }
    if (!response.ok) {
      let detail = "Une erreur est survenue.";
      try {
        const body = await response.json();
        detail = body.detail || detail;
      } catch (error) {
        console.error("Réponse d'erreur API invalide", error);
      }
      throw new Error(detail);
    }
    return response.status === 204 ? null : response.json();
  }

  function showToast(message) {
    $("#toast").textContent = message;
    $("#toast").classList.add("show");
    window.setTimeout(() => $("#toast").classList.remove("show"), 2800);
  }

  function pageError(error) {
    console.error(error);
    $("#admin-page").innerHTML = `<div class="inline-error" role="alert">${escapeHtml(error.message)}</div>`;
  }

  function metric(title, value, note) {
    return `<article class="admin-stat"><span>${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></article>`;
  }

  function activityRows(rows) {
    return rows.map((row) => `<div class="activity-row">
      <time>${formatDate(row.created_at)}</time>
      <span><strong>${escapeHtml(row.action)}</strong><br><span class="muted">${escapeHtml(row.actor_email)} · ${escapeHtml(row.target)}</span></span>
      <span class="role-pill">${escapeHtml(row.details || "")}</span>
    </div>`).join("") || '<div class="empty-state">Aucune activité enregistrée.</div>';
  }

  function notificationItem(row, showTarget = false) {
    const delivery = row.delivery_status || "in_app_only";
    const statusName = {
      sent: "E-mail envoyé",
      in_app_only: "Notification intégrée",
      pending: "En attente",
      failed: "Échec d'envoi",
      system_alert: row.severity ? `Alerte ${row.severity}` : "Alerte système",
    }[delivery] || delivery;
    const target = showTarget && (row.email_to || row.machine_name)
      ? `${row.type === "system_alert" ? "Machine " : ""}${escapeHtml(row.machine_name || row.email_to)} · `
      : "";
    return `<article class="notification-card">
      <div><strong>${escapeHtml(row.message)}</strong>
        <p>${target}${formatDate(row.created_at)}</p>
        ${row.delivery_error ? `<div class="delivery-error">${escapeHtml(row.delivery_error)}</div>` : ""}
      </div>
      <span class="status ${delivery === "failed" ? "offline" : ""}">${statusName}</span>
    </article>`;
  }

  async function renderOverview() {
    const data = await api("/admin/overview");
    const counts = data.role_counts;
    const roleEntries = [
      ["Techniciens", counts.technician || 0],
      ["Responsables", counts.manager || 0],
      ["Directeurs", counts.director || 0],
      ["Administrateurs", counts.admin || 0],
    ];
    const maxCount = Math.max(1, ...data.user_trend.map((item) => item.count));
    const chart = data.user_trend.map((item) => {
      const height = item.count ? Math.max(12, Math.round(item.count / maxCount * 125)) : 4;
      return `<div class="chart-day"><span class="chart-bar-label">${item.count}</span><div class="chart-bar" style="height:${height}px" title="${item.count} compte(s) créé(s)"></div><span>${measurementUi.formatDay(item.date)}</span></div>`;
    }).join("");
    const totalByRole = roleEntries.reduce((sum, item) => sum + item[1], 0);
    const acquisitionLabel = data.acquisition_mode === "waiting"
      ? "En attente de la première mesure"
      : `Mode ${measurementUi.modeLabel(data.acquisition_mode)}`;
    const latestMeasurement = data.measurement_recorded_at ? {
      recorded_at: data.measurement_recorded_at,
      age_seconds: data.measurement_age_seconds,
      acquisition_mode: data.acquisition_mode,
      current_rms: data.measurement_current_rms,
      current_source: data.measurement_source,
    } : null;
    measurementUi.markReceived(latestMeasurement);
    const currentLabel = measurementUi.currentValue(latestMeasurement);
    const currentSource = measurementUi.currentSourceLabel(latestMeasurement);
    const latestDescription = latestMeasurement
      ? `${formatDate(latestMeasurement.recorded_at)} · ${measurementUi.freshness(latestMeasurement).label}`
      : "Aucune mesure récente";
    $("#admin-page").innerHTML = `
      <div class="admin-stats">
        ${metric("Utilisateurs totaux", data.total_users, "comptes enregistrés")}
        ${metric("Comptes actifs", data.active_users, "accès autorisés")}
        ${metric("Comptes désactivés", data.disabled_users, "accès suspendus")}
        ${metric("Connexions aujourd'hui", data.logins_today, "connexions réussies")}
      </div>
      <div class="dashboard-grid">
        <section class="admin-card">
          <div class="admin-card-header"><h2>Évolution des utilisateurs</h2><span>7 derniers jours</span></div>
          <div class="admin-card-body"><div class="chart-bars">${chart}</div></div>
        </section>
        <section class="admin-card">
          <div class="admin-card-header"><h2>Répartition par rôle</h2></div>
          <div class="admin-card-body"><div class="role-summary">
            <div class="role-donut"><div class="role-donut-inner"><strong>${totalByRole}</strong><small>utilisateurs</small></div></div>
            <div class="role-legend">${roleEntries.map(([name, count]) => `<span>${name}<strong>${count}</strong></span>`).join("")}</div>
          </div></div>
        </section>
        <section class="admin-card">
          <div class="admin-card-header"><h2>Dernières activités</h2><button class="quiet" data-go="activity">Tout voir</button></div>
          <div class="admin-card-body">${activityRows(data.recent_activity)}</div>
        </section>
        <section class="admin-card">
          <div class="admin-card-header"><h2>Notifications récentes</h2><button class="quiet" data-go="notifications">Tout voir</button></div>
          <div class="admin-card-body">${data.recent_notifications.map((row) => notificationItem(row)).join("") || '<div class="empty-state">Aucune notification.</div>'}</div>
        </section>
      </div>
      <p class="callout"><strong>Dernière mesure :</strong> ${acquisitionLabel} · ${latestDescription}. Courant : ${currentLabel} · ${currentSource}. En simulation, le programme Python peut générer des valeurs normales, d'avertissement et critiques sans ESP32.</p>`;
  }

  function userRow(user) {
    const status = user.active ? '<span class="status">Actif</span>' : '<span class="status offline">Désactivé</span>';
    return `<tr>
      <td class="user-cell"><strong>${escapeHtml(user.full_name || "—")}</strong><small>${escapeHtml(user.email)}</small></td>
      <td class="role-pill">${escapeHtml(formatRole(user.role))}</td>
      <td>${status}</td><td>${formatDate(user.created_at)}</td><td>${formatDate(user.last_login)}</td>
      <td><div class="table-actions">
        <button data-user-edit="${user.id}">Modifier</button>
        <button data-user-toggle="${user.id}" data-active="${user.active}">${user.active ? "Désactiver" : "Activer"}</button>
        <button class="danger" data-user-delete="${user.id}">Supprimer</button>
      </div></td>
    </tr>`;
  }

  function userDialog() {
    return `<dialog id="user-edit-dialog" class="dialog-backdrop">
      <button type="button" class="dialog-close" data-dialog-close>Fermer</button><h2>Modifier l'utilisateur</h2>
      <form id="user-edit-form" data-user-id="">
        <div class="form-grid">
          <label>Nom complet<input name="full_name" required minlength="2" maxlength="160"></label>
          <label>Adresse e-mail<input name="email" type="email" required maxlength="255"></label>
          <label>Téléphone<input name="phone" maxlength="40"></label>
          <label>Rôle<select name="role">${roleOptions()}</select></label>
          <label class="span-two">Statut<select name="active"><option value="true">Actif</option><option value="false">Désactivé</option></select></label>
        </div><div class="form-actions"><button class="primary" type="submit">Enregistrer</button><button type="button" class="quiet" data-dialog-close>Annuler</button></div><p class="muted" data-form-message></p>
      </form>
    </dialog>`;
  }

  function roleOptions(selected = "technician") {
    return Object.entries(roleNames).map(([key, name]) =>
      `<option value="${key}" ${key === selected ? "selected" : ""}>${escapeHtml(name)}</option>`
    ).join("");
  }

  function roleFilterOptions(selected) {
    return `<option value="">Tous les rôles</option>${Object.entries(roleNames).map(([key, name]) =>
      `<option value="${key}" ${key === selected ? "selected" : ""}>${escapeHtml(name)}</option>`
    ).join("")}`;
  }

  async function renderUsers(search = "", role = "", active = "") {
    const query = new URLSearchParams();
    if (search.trim()) query.set("search", search.trim());
    if (role) query.set("role", role);
    if (active) query.set("active", active);
    const users = await api(`/admin/users?${query.toString()}`);
    $("#admin-page").innerHTML = `
      <div class="page-intro"><div><h2>Gestion des utilisateurs</h2><p>Rechercher, filtrer et gérer les comptes de tous les acteurs.</p></div><button class="primary" data-go="add-user">＋ Ajouter un utilisateur</button></div>
      <section class="admin-card"><div class="admin-card-header"><h2>Comptes utilisateurs</h2><span>${users.length} résultat(s)</span></div>
        <div class="admin-card-body">
          <div class="page-toolbar">
            <label class="search-field">Recherche<input id="users-search" type="search" placeholder="Nom ou adresse e-mail" value="${escapeHtml(search)}"></label>
            <label>Rôle<select id="users-role">${roleFilterOptions(role)}</select></label>
            <label>Statut<select id="users-active"><option value="">Tous les statuts</option><option value="true" ${active === "true" ? "selected" : ""}>Actif</option><option value="false" ${active === "false" ? "selected" : ""}>Désactivé</option></select></label>
          </div>
          <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Utilisateur</th><th>Rôle</th><th>Statut</th><th>Création</th><th>Dernière connexion</th><th>Actions</th></tr></thead>
            <tbody>${users.map(userRow).join("") || '<tr><td colspan="6" class="empty-state">Aucun utilisateur trouvé.</td></tr>'}</tbody></table></div>
          <p class="callout">Les modifications de coordonnées et de rôle créent une notification dans le compte de l'utilisateur et envoient un e-mail si SMTP est configuré.</p>
        </div></section>${userDialog()}`;
    $("#users-search").addEventListener("input", (event) => {
      window.clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = window.setTimeout(() => renderUsers(value, $("#users-role").value, $("#users-active").value).catch(pageError), 250);
    });
    $("#users-role").addEventListener("change", () => renderUsers($("#users-search").value, $("#users-role").value, $("#users-active").value).catch(pageError));
    $("#users-active").addEventListener("change", () => renderUsers($("#users-search").value, $("#users-role").value, $("#users-active").value).catch(pageError));
    $("#user-edit-dialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget || event.target.closest("[data-dialog-close]")) event.currentTarget.close();
    });
    $("#user-edit-form").addEventListener("submit", saveUserEdit);
  }

  async function saveUserEdit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    payload.active = payload.active === "true";
    const message = $("[data-form-message]", form);
    try {
      const result = await api(`/admin/users/${form.dataset.userId}`, { method: "PATCH", body: JSON.stringify(payload) });
      $("#user-edit-dialog").close();
      showToast(result.notification_status === "failed" ? "Compte modifié, mais l'e-mail n'a pas pu être envoyé." : "Compte mis à jour.");
      await renderUsers($("#users-search").value, $("#users-role").value, $("#users-active").value);
      await updateNotificationCount();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("error");
    }
  }

  async function renderAddUser() {
    $("#admin-page").innerHTML = `
      <div class="page-intro"><div><h2>Créer un nouveau compte</h2><p>Les données personnelles sont modifiables ultérieurement.</p></div></div>
      <section class="admin-card form-card"><div class="admin-card-header"><h2>＋ Informations du compte</h2></div><div class="admin-card-body">
        <form id="add-user-form">
          <div class="form-grid">
            <label>Nom complet<input name="full_name" required minlength="2" maxlength="160" placeholder="Ex. Samir Trabelsi"></label>
            <label>Adresse e-mail<input name="email" type="email" required maxlength="255" placeholder="utilisateur@exemple.com"></label>
            <label>Téléphone<input name="phone" maxlength="40" placeholder="+216 ..."></label>
            <label>Rôle<select name="role">${roleOptions()}</select></label>
            <label>Mot de passe initial<input name="password" type="password" required minlength="12" maxlength="200" autocomplete="new-password"></label>
            <label>Statut<select name="active"><option value="true">Actif</option><option value="false">Désactivé</option></select></label>
          </div>
          <p class="callout">Choisissez un mot de passe temporaire solide et communiquez-le par un canal distinct. L'utilisateur recevra un e-mail d'information si SMTP est configuré ; une notification intégrée est conservée dans tous les cas.</p>
          <div class="form-actions"><button class="primary" type="submit">Créer le compte</button><button class="quiet" type="reset">Effacer</button><span id="add-user-message" class="muted" role="status"></span></div>
        </form></div></section>`;
    $("#add-user-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const message = $("#add-user-message");
      const payload = Object.fromEntries(new FormData(form));
      payload.active = payload.active === "true";
      try {
        const result = await api("/admin/users", { method: "POST", body: JSON.stringify(payload) });
        showToast(result.notification_status === "failed" ? "Compte créé, mais l'e-mail n'a pas pu être envoyé." : "Compte créé.");
        await updateNotificationCount();
        navigate("users");
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
  }

  async function renderRoles() {
    const roles = await api("/admin/roles");
    $("#admin-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Rôles et permissions</h2></div>
      <div class="admin-card-body"><div class="admin-table-wrap"><table class="admin-table">
        <thead><tr><th>Rôle</th><th>Accès principal</th><th>Utilisateurs</th></tr></thead>
        <tbody>${roles.map((item) => `<tr><td class="role-pill">${escapeHtml(item.name)}</td><td>${escapeHtml(item.permissions)}</td><td>${item.user_count}</td></tr>`).join("")}</tbody>
      </table></div><p class="callout">Les droits sont appliqués et vérifiés côté API. Cette page présente les permissions générales de chaque acteur.</p></div>
    </section>`;
  }

  async function renderLogins() {
    const search = $("#login-search")?.value || "";
    const query = new URLSearchParams({ limit: "200" });
    if (search.trim()) query.set("search", search.trim());
    const rows = await api(`/admin/login-history?${query}`);
    $("#admin-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Historique des connexions</h2><span>${rows.length} événement(s)</span></div>
      <div class="admin-card-body"><div class="page-toolbar"><label class="search-field">Utilisateur<input id="login-search" type="search" value="${escapeHtml(search)}" placeholder="Rechercher une adresse e-mail"></label></div>
        <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Date / heure</th><th>Utilisateur</th><th>Adresse IP</th><th>Événement</th><th>Résultat</th></tr></thead>
          <tbody>${rows.map((row) => `<tr><td>${formatDate(row.created_at)}</td><td>${escapeHtml(row.email)}</td><td>${escapeHtml(row.ip_address || "—")}</td><td>Connexion</td><td><span class="status ${row.success ? "" : "offline"}">${row.success ? "Réussie" : "Échec"}</span></td></tr>`).join("") || '<tr><td colspan="5" class="empty-state">Aucune connexion enregistrée.</td></tr>'}</tbody></table></div>
      </div></section><p class="callout">L'adresse IP est celle observée par l'application. Si un proxy est utilisé, configurez le proxy de confiance avant de considérer cette adresse comme celle du client.</p>`;
    $("#login-search").addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => renderLogins().catch(pageError), 250);
    });
  }

  async function renderActivity() {
    const rows = await api("/admin/activity?limit=200");
    $("#admin-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Journal des activités administratives</h2></div>
      <div class="admin-card-body">${rows.length
        ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Date</th><th>Administrateur</th><th>Opération</th><th>Cible</th><th>Détails</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${formatDate(row.created_at)}</td><td>${escapeHtml(row.actor_email)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.details || "—")}</td></tr>`).join("")}</tbody></table></div>`
        : '<div class="empty-state">Aucune activité administrative enregistrée.</div>'}</div></section>`;
  }

  async function updateNotificationCount() {
    try {
      const rows = await api("/admin/notifications");
      notificationCount = rows.length;
      $("#admin-header-notification-count").textContent = String(notificationCount);
      $("#admin-notification-count").textContent = String(notificationCount);
      $("#admin-notification-count").classList.toggle("hidden", notificationCount === 0);
    } catch (error) {
      console.error("Impossible de charger le compteur de notifications", error);
    }
  }

  async function renderNotifications() {
    const rows = await api("/admin/notifications");
    notificationCount = rows.length;
    $("#admin-header-notification-count").textContent = String(notificationCount);
    $("#admin-page").innerHTML = `<section class="admin-card">
      <div class="admin-card-header"><h2>Centre de notifications</h2><span>${rows.length} message(s)</span></div>
      <div class="admin-card-body">${rows.map((row) => notificationItem(row, true)).join("") || '<div class="empty-state">Aucune notification.</div>'}</div>
    </section><p class="callout">Un message est toujours visible dans l'espace du compte ciblé. L'envoi par e-mail nécessite une configuration SMTP ; les échecs sont affichés ici et conservés dans le journal.</p>`;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value < 1024) return `${value} octets`;
    const units = ["Ko", "Mo", "Go", "To"];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ${units[unit]}`;
  }

  function backupStatus(status) {
    return {
      succeeded: '<span class="status">Réussie</span>',
      running: '<span class="status backup-running">En cours</span>',
      failed: '<span class="status offline">Échec</span>',
    }[status] || '<span class="status offline">Inconnue</span>';
  }

  async function renderBackups() {
    window.clearInterval(backupRefreshTimer);
    const data = await api("/admin/backups");
    if (currentPage !== "backups" || $("#admin-app").classList.contains("hidden")) return;
    const lastAttempt = data.last_attempt;
    const lastSuccess = data.last_backup;
    const statusName = lastAttempt
      ? { succeeded: "Réussie", failed: "Échec", running: "En cours" }[lastAttempt.status] || "Inconnue"
      : "Aucune sauvegarde";
    const rows = data.items.map((row) => `<tr>
      <td><strong>${escapeHtml(row.filename)}</strong><small>${formatDate(row.created_at)} · ${formatBytes(row.size_bytes)}</small></td>
      <td>${backupStatus(row.status)}${row.error_message ? `<small class="backup-error">${escapeHtml(row.error_message)}</small>` : ""}</td>
      <td>${row.trigger === "automatic" ? "Automatique" : "Manuelle"}</td>
      <td>${row.status === "succeeded" ? `<button class="quiet" type="button" data-backup-download="${row.id}">Télécharger</button>` : "—"}</td>
    </tr>`).join("");
    const nextRun = data.enabled && data.next_run_at
      ? formatDate(data.next_run_at)
      : "Désactivée";
    $("#admin-page").innerHTML = `
      <div class="admin-stats backup-stats">
        ${metric("Dernière sauvegarde réussie", lastSuccess ? formatDate(lastSuccess.created_at) : "—", lastSuccess ? lastSuccess.filename : "Aucune sauvegarde réussie")}
        ${metric("Statut de la dernière tentative", statusName, lastAttempt ? formatDate(lastAttempt.created_at) : "Aucune tentative enregistrée")}
        ${metric("Taille du dernier fichier", lastSuccess ? formatBytes(lastSuccess.size_bytes) : "—", "Archive PostgreSQL vérifiée")}
        ${metric("Sauvegarde automatique", data.enabled ? `Toutes les ${data.interval_minutes} min` : "Désactivée", `Prochaine exécution : ${nextRun}`)}
      </div>
      <section class="admin-card">
        <div class="admin-card-header"><h2>Actions</h2></div>
        <div class="admin-card-body">
          <button id="backup-create" class="primary backup-create" type="button">▣ &nbsp; Créer une sauvegarde</button>
          <p id="backup-action-message" class="muted" role="status"></p>
          <form id="backup-schedule-form" class="backup-schedule">
            <label class="backup-enabled"><input name="enabled" type="checkbox" ${data.enabled ? "checked" : ""}> Activer la sauvegarde automatique</label>
            <label>Fréquence (minutes)<input name="interval_minutes" type="number" min="1" max="525600" required value="${data.interval_minutes}"></label>
            <div class="form-actions"><button class="quiet" type="submit">Enregistrer la fréquence</button><span id="backup-schedule-message" class="muted" role="status"></span></div>
          </form>
          <p class="callout">Les fichiers sont stockés dans un volume Docker dédié, séparé du volume PostgreSQL. Une sauvegarde quotidienne correspond à 1&nbsp;440 minutes.</p>
        </div>
      </section>
      <section class="admin-card">
        <div class="admin-card-header"><h2>Historique des sauvegardes</h2><span>${data.items.length} sauvegarde(s), 100 dernières affichées</span></div>
        <div class="admin-card-body"><div class="admin-table-wrap"><table class="admin-table backup-table">
          <thead><tr><th>Nom du fichier</th><th>Statut</th><th>Déclenchement</th><th>Fichier</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="empty-state">Aucune sauvegarde enregistrée.</td></tr>'}</tbody>
        </table></div></div>
      </section>`;
    $("#backup-create").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const message = $("#backup-action-message");
      button.disabled = true;
      message.textContent = "Création et vérification de la sauvegarde en cours…";
      try {
        await api("/admin/backups", { method: "POST" });
        showToast("Sauvegarde PostgreSQL créée et vérifiée.");
        await renderBackups();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
        await renderBackups();
      } finally {
        const currentButton = $("#backup-create");
        if (currentButton) currentButton.disabled = false;
      }
    });
    $("#backup-schedule-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const message = $("#backup-schedule-message");
      try {
        await api("/admin/backups/config", {
          method: "PUT",
          body: JSON.stringify({
            enabled: values.get("enabled") === "on",
            interval_minutes: Number(values.get("interval_minutes")),
          }),
        });
        showToast("Planification des sauvegardes enregistrée.");
        await renderBackups();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
    backupRefreshTimer = window.setInterval(() => {
      if (currentPage === "backups") renderBackups().catch(pageError);
    }, 30000);
  }

  async function renderSensorReplacements() {
    const [sensors, replacements] = await Promise.all([
      api("/admin/sensors"),
      api("/admin/sensor-replacements"),
    ]);
    const metricNames = {
      temperature: "Température",
      humidity: "Humidité",
      vibration_rate: "Vibration",
      current_rms: "Courant",
    };
    const machineMap = new Map(
      sensors.map((sensor) => [sensor.machine_id, {
        id: sensor.machine_id,
        name: sensor.machine_name,
        active: sensor.machine_active,
      }]),
    );
    const machines = [...machineMap.values()].filter((machine) => machine.active);
    const machineOptions = machines.map((machine) =>
      `<option value="${escapeHtml(machine.id)}">${escapeHtml(machine.name)}</option>`
    ).join("");
    const activeSensors = sensors.filter((sensor) => sensor.enabled && sensor.machine_active);
    const historyRows = replacements.map((item) => `<tr>
      <td>${formatDate(item.replaced_at)}</td>
      <td><strong>${escapeHtml(item.machine_name)}</strong><small>${escapeHtml(metricNames[item.metric] || item.metric)}</small></td>
      <td>#${item.old_sensor_id} · ${escapeHtml(item.old_sensor_type)}</td>
      <td>#${item.new_sensor_id} · ${escapeHtml(item.new_sensor_type)}</td>
      <td>${escapeHtml(item.administrator_name || item.administrator_email)}</td>
      <td>${escapeHtml(item.reason)}</td>
    </tr>`).join("");
    $("#admin-page").innerHTML = `
      <section class="admin-card form-card">
        <div class="admin-card-header"><h2>Remplacer un capteur défectueux</h2></div>
        <div class="admin-card-body">
          <p class="callout">L'ancien capteur sera conservé et désactivé. Un nouvel identifiant sera créé; les mesures enregistrées après le remplacement garderont le lien avec leur capteur source.</p>
          <form id="sensor-replacement-form">
            <div class="form-grid">
              <label>Machine<select name="machine_id" required ${machines.length ? "" : "disabled"}>${machineOptions}</select></label>
              <label>Ancien capteur<select name="sensor_id" required ${activeSensors.length ? "" : "disabled"}></select></label>
              <label>Type du nouveau capteur<input name="sensor_type" required minlength="2" maxlength="80" placeholder="DHT22"></label>
              <label>GPIO<input name="gpio" type="number" min="0" max="39"></label>
              <label>Unité<input name="unit" required maxlength="20" placeholder="°C"></label>
              <label class="span-two">Motif du remplacement<textarea name="reason" required minlength="3" maxlength="2000" rows="3" placeholder="Ex. mesure instable, capteur endommagé..."></textarea></label>
            </div>
            <div class="form-actions"><button class="primary" type="submit" ${activeSensors.length ? "" : "disabled"}>Enregistrer le remplacement</button><span id="sensor-replacement-message" class="muted" role="status"></span></div>
          </form>
          ${activeSensors.length ? "" : '<p class="empty-state">Aucun capteur actif disponible pour un remplacement.</p>'}
        </div>
      </section>
      <section class="admin-card">
        <div class="admin-card-header"><h2>Historique des remplacements</h2><span>${replacements.length} remplacement(s), 100 derniers affichés</span></div>
        <div class="admin-card-body"><div class="admin-table-wrap"><table class="admin-table">
          <thead><tr><th>Date</th><th>Machine / grandeur</th><th>Ancien capteur</th><th>Nouveau capteur</th><th>Administrateur</th><th>Motif</th></tr></thead>
          <tbody>${historyRows || '<tr><td colspan="6" class="empty-state">Aucun remplacement enregistré.</td></tr>'}</tbody>
        </table></div></div>
      </section>`;

    const form = $("#sensor-replacement-form");
    const machineSelect = form.elements.machine_id;
    const sensorSelect = form.elements.sensor_id;
    const updateSensorOptions = () => {
      const options = activeSensors.filter((sensor) => sensor.machine_id === machineSelect.value);
      sensorSelect.innerHTML = options.map((sensor) =>
        `<option value="${sensor.id}">${escapeHtml(metricNames[sensor.metric] || sensor.metric)} · ${escapeHtml(sensor.sensor_type)} · ${escapeHtml(sensor.unit)}</option>`
      ).join("");
      sensorSelect.disabled = options.length === 0;
      form.querySelector('button[type="submit"]').disabled = options.length === 0;
    };
    machineSelect.addEventListener("change", updateSensorOptions);
    updateSensorOptions();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const machineId = String(values.get("machine_id"));
      const sensorId = Number(values.get("sensor_id"));
      const oldSensor = activeSensors.find((sensor) => sensor.id === sensorId);
      if (!oldSensor || !window.confirm(
        `Remplacer ${oldSensor.sensor_type} sur ${oldSensor.machine_name} ? L'ancien capteur et son historique seront conservés.`,
      )) return;
      const message = $("#sensor-replacement-message");
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const gpioValue = String(values.get("gpio") || "").trim();
        await api(`/admin/machines/${encodeURIComponent(machineId)}/sensors/${sensorId}/replace`, {
          method: "POST",
          body: JSON.stringify({
            sensor_type: values.get("sensor_type"),
            gpio: gpioValue ? Number(gpioValue) : null,
            unit: values.get("unit"),
            reason: values.get("reason"),
          }),
        });
        showToast("Remplacement du capteur enregistré.");
        await renderSensorReplacements();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
        submit.disabled = false;
      }
    });
  }

  async function downloadBackup(id) {
    const token = localStorage.getItem("pm_token");
    const response = await fetch(`/api/admin/backups/${encodeURIComponent(id)}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 401) {
      $("#logout").click();
      throw new Error("Session expirée. Reconnectez-vous.");
    }
    if (!response.ok) {
      let detail = "Téléchargement de la sauvegarde impossible.";
      try {
        detail = (await response.json()).detail || detail;
      } catch (error) {
        console.error("Réponse d'erreur API invalide", error);
      }
      throw new Error(detail);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `predimaint-backup-${id}.dump`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function renderProfile() {
    const user = await api("/admin/profile");
    $("#admin-page").innerHTML = `<section class="admin-card form-card">
      <div class="admin-card-header"><h2>Mon profil administrateur</h2></div><div class="admin-card-body">
        <div class="profile-head"><span class="avatar">${escapeHtml(initials(user.full_name))}</span><div><strong>${escapeHtml(user.full_name)}</strong><p>${escapeHtml(user.email)}</p></div></div>
        <form id="profile-form"><div class="form-grid">
          <label class="span-two">Nom complet<input name="full_name" required minlength="2" maxlength="160" value="${escapeHtml(user.full_name)}"></label>
          <label class="span-two">Adresse e-mail<input name="email" type="email" required maxlength="255" value="${escapeHtml(user.email)}"></label>
          <label class="span-two">Téléphone<input name="phone" maxlength="40" value="${escapeHtml(user.phone)}" placeholder="+216 ..."></label>
        </div><div class="form-actions"><button class="primary" type="submit">Enregistrer les modifications</button><span id="profile-message" class="muted" role="status"></span></div></form>
        <hr class="profile-divider">
        <h3>Changer le mot de passe</h3>
        <form id="password-form"><div class="form-grid">
          <label class="span-two">Mot de passe actuel<input name="current_password" type="password" required autocomplete="current-password"></label>
          <label>Nouveau mot de passe<input name="new_password" type="password" required minlength="12" autocomplete="new-password"></label>
          <label>Confirmer le nouveau mot de passe<input name="confirm_password" type="password" required minlength="12" autocomplete="new-password"></label>
        </div><div class="form-actions"><button class="quiet" type="submit">Modifier le mot de passe</button><span id="password-message" class="muted" role="status"></span></div></form>
      </div></section>`;
    $("#profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const message = $("#profile-message");
      try {
        const result = await api("/admin/profile", { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        showToast(result.notification_status === "failed" ? "Profil mis à jour, mais l'e-mail n'a pas pu être envoyé." : "Profil mis à jour.");
        $("#admin-header-name").textContent = result.full_name;
        $("#admin-avatar").textContent = initials(result.full_name);
        message.textContent = "Les modifications sont enregistrées.";
        await updateNotificationCount();
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
    $("#password-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form));
      const message = $("#password-message");
      if (values.new_password !== values.confirm_password) {
        message.textContent = "Les nouveaux mots de passe ne correspondent pas.";
        message.classList.add("error");
        return;
      }
      try {
        const result = await api("/admin/profile/password", {
          method: "POST",
          body: JSON.stringify({ current_password: values.current_password, new_password: values.new_password }),
        });
        form.reset();
        message.classList.remove("error");
        message.textContent = result.notification_status === "failed"
          ? "Votre mot de passe a été modifié, mais l’e-mail de confirmation n’a pas pu être envoyé."
          : "Votre mot de passe a été modifié. Reconnectez-vous pour révoquer la session actuelle.";
        window.setTimeout(() => $("#logout").click(), 1200);
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
  }

  function initials(name) {
    return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "AS";
  }

  async function renderSettings() {
    const settings = await api("/admin/settings");
    $("#admin-page").innerHTML = `<section class="admin-card form-card">
      <div class="admin-card-header"><h2>Paramètres du système</h2></div><div class="admin-card-body">
        <form id="settings-form">
          <label>Notifications par e-mail<select name="email_notifications"><option value="true" ${settings.email_notifications ? "selected" : ""}>Activées</option><option value="false" ${!settings.email_notifications ? "selected" : ""}>Désactivées</option></select></label>
          <label>Langue de l'interface<select name="language"><option value="fr" ${settings.language === "fr" ? "selected" : ""}>Français</option><option value="en" ${settings.language === "en" ? "selected" : ""}>English</option></select></label>
          <label>Durée de session<select name="session_minutes">${[15, 30, 60, 120].map((n) => `<option value="${n}" ${settings.session_minutes === n ? "selected" : ""}>${n} minutes</option>`).join("")}</select></label>
          <label>Délai avant télémétrie obsolète (secondes)<input name="telemetry_stale_after_seconds" type="number" min="5" max="3600" step="1" required value="${settings.telemetry_stale_after_seconds}"></label>
          <div class="form-actions"><button class="primary" type="submit">Enregistrer les paramètres</button><span id="settings-message" class="muted" role="status"></span></div>
        </form>
        <p class="callout">La durée sélectionnée s'applique aux nouveaux jetons après connexion. Les sessions déjà ouvertes conservent leur date d'expiration actuelle. Le délai de télémétrie sert à calculer la fraîcheur des données du Directeur.</p>
      </div></section>`;
    $("#settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const message = $("#settings-message");
      try {
        await api("/admin/settings", {
          method: "PUT",
          body: JSON.stringify({
            email_notifications: form.get("email_notifications") === "true",
            language: form.get("language"),
            session_minutes: Number(form.get("session_minutes")),
            telemetry_stale_after_seconds: Number(form.get("telemetry_stale_after_seconds")),
          }),
        });
        message.textContent = "Paramètres enregistrés.";
        showToast("Paramètres enregistrés.");
      } catch (error) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    });
  }

  async function render() {
    currentPage = pageTitles[currentPage] ? currentPage : "overview";
    const [title, subtitle] = pageTitles[currentPage];
    $("#admin-page-title").textContent = title;
    $("#admin-page-subtitle").textContent = subtitle;
    document.querySelectorAll("[data-admin-page]").forEach((button) => {
      button.classList.toggle("active", button.dataset.adminPage === currentPage);
    });
    $(".admin-sidebar").classList.remove("open");
    try {
      switch (currentPage) {
        case "overview": await renderOverview(); break;
        case "users": await renderUsers(); break;
        case "add-user": await renderAddUser(); break;
        case "roles": await renderRoles(); break;
        case "logins": await renderLogins(); break;
        case "activity": await renderActivity(); break;
        case "notifications": await renderNotifications(); break;
        case "backups": await renderBackups(); break;
        case "sensor-replacements": await renderSensorReplacements(); break;
        case "profile": await renderProfile(); break;
        case "settings": await renderSettings(); break;
        default: await renderOverview();
      }
    } catch (error) {
      pageError(error);
    }
  }

  function navigate(page) {
    if (!pageTitles[page]) return;
    if (currentPage === page && location.hash === `#${page}`) {
      render();
    } else {
      location.hash = page;
    }
  }

  document.querySelectorAll("[data-admin-page]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.adminPage));
  });
  $("#admin-page").addEventListener("click", async (event) => {
    const downloadButton = event.target.closest("[data-backup-download]");
    if (downloadButton) {
      try {
        await downloadBackup(downloadButton.dataset.backupDownload);
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    const navigateButton = event.target.closest("[data-go]");
    if (navigateButton) {
      navigate(navigateButton.dataset.go);
      return;
    }
    const editButton = event.target.closest("[data-user-edit]");
    if (editButton) {
      try {
        const user = (await api("/admin/users")).find((item) => item.id === Number(editButton.dataset.userEdit));
        if (!user) throw new Error("Utilisateur introuvable.");
        const form = $("#user-edit-form");
        form.dataset.userId = String(user.id);
        form.elements.full_name.value = user.full_name;
        form.elements.email.value = user.email;
        form.elements.phone.value = user.phone;
        form.elements.role.value = user.role;
        form.elements.active.value = String(user.active);
        $("#user-edit-dialog").showModal();
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    const toggleButton = event.target.closest("[data-user-toggle]");
    if (toggleButton) {
      const userId = Number(toggleButton.dataset.userToggle);
      const active = toggleButton.dataset.active !== "true";
      try {
        const result = await api(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify({ active }) });
        showToast(result.notification_status === "failed" ? "Statut modifié, mais l'e-mail n'a pas pu être envoyé." : `Compte ${active ? "activé" : "désactivé"}.`);
        await renderUsers($("#users-search").value, $("#users-role").value, $("#users-active").value);
        await updateNotificationCount();
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    const deleteButton = event.target.closest("[data-user-delete]");
    if (deleteButton) {
      const row = deleteButton.closest("tr");
      const name = $(".user-cell strong", row).textContent;
      if (!window.confirm(`Supprimer définitivement le compte de ${name} ? Cette action est irréversible.`)) return;
      try {
        await api(`/admin/users/${deleteButton.dataset.userDelete}`, { method: "DELETE" });
        showToast("Compte supprimé.");
        await renderUsers($("#users-search").value, $("#users-role").value, $("#users-active").value);
        await updateNotificationCount();
      } catch (error) {
        showToast(error.message);
      }
    }
  });
  $("#admin-logout").addEventListener("click", () => $("#logout").click());
  $("#admin-menu-toggle").addEventListener("click", () => $(".admin-sidebar").classList.toggle("open"));
  window.addEventListener("hashchange", () => {
    if ($("#admin-app").classList.contains("hidden")) {
      window.clearInterval(backupRefreshTimer);
      return;
    }
    const page = location.hash.slice(1);
    currentPage = pageTitles[page] ? page : "overview";
    if (currentPage !== "backups") window.clearInterval(backupRefreshTimer);
    render();
  });
  window.addEventListener("predimaint:admin-authenticated", async () => {
    try {
      const [user] = await Promise.all([api("/admin/profile"), updateNotificationCount()]);
      $("#admin-header-name").textContent = user.full_name || user.email;
      $("#admin-avatar").textContent = initials(user.full_name);
      if (!pageTitles[location.hash.slice(1)]) location.hash = "overview";
      else {
        currentPage = location.hash.slice(1);
        await render();
      }
    } catch (error) {
      pageError(error);
    }
  });
})();
