(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const pageTitles = {
    overview: ["Vue d'ensemble", "Bienvenue, administrateur système !"],
    users: ["Gestion des utilisateurs", "Consultez et gérez les comptes de la plateforme."],
    "add-user": ["Ajouter un utilisateur", "Créez un compte et définissez son rôle d'accès."],
    roles: ["Rôles et permissions", "Vue des niveaux d'accès définis dans PrediMaint."],
    logins: ["Historique des connexions", "Connexions réussies et tentatives échouées."],
    activity: ["Journal d'activité", "Traçabilité des opérations administratives."],
    notifications: ["Notifications", "Messages adressés aux utilisateurs et état de livraison."],
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

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
  const formatDate = (value) => value
    ? new Date(value).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
    : "—";
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
      return `<div class="chart-day"><span class="chart-bar-label">${item.count}</span><div class="chart-bar" style="height:${height}px" title="${item.count} compte(s) créé(s)"></div><span>${new Date(`${item.date}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "short" })}</span></div>`;
    }).join("");
    const totalByRole = roleEntries.reduce((sum, item) => sum + item[1], 0);
    const acquisitionLabel = data.acquisition_mode === "simulated"
      ? "Mesures générées par le simulateur logiciel"
      : data.acquisition_mode === "hardware"
        ? "Mesures reçues du firmware ESP32"
        : "En attente de la première mesure";
    const currentLabel = data.measurement_source === "simulated"
      ? "courant simulé"
      : data.measurement_source === "hardware"
        ? "courant lu par ACS712"
        : "courant non disponible";
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
      <p class="callout"><strong>Mode d'acquisition :</strong> ${acquisitionLabel} ; ${currentLabel}. En simulation, le programme Python peut générer des valeurs normales, d'avertissement et critiques sans ESP32.</p>`;
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
          <div class="form-actions"><button class="primary" type="submit">Enregistrer les paramètres</button><span id="settings-message" class="muted" role="status"></span></div>
        </form>
        <p class="callout">La durée sélectionnée s'applique aux nouveaux jetons après connexion. Les sessions déjà ouvertes conservent leur date d'expiration actuelle.</p>
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
    if ($("#admin-app").classList.contains("hidden")) return;
    const page = location.hash.slice(1);
    currentPage = pageTitles[page] ? page : "overview";
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
