(() => {
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

  async function render({ container, api, onProfileUpdated, onPasswordChanged, showToast }) {
    const root = typeof container === "string" ? document.querySelector(container) : container;
    if (!root) throw new Error("La zone du profil est introuvable.");

    root.innerHTML = '<p class="muted" role="status">Chargement de votre profil…</p>';
    try {
      const profile = await api("/profile");
      const roleNames = {
        technician: "Technicien de maintenance",
        manager: "Responsable de maintenance",
        director: "Directeur de production",
        admin: "Administrateur système",
      };
      const initials = profile.full_name.trim().split(/\s+/).slice(0, 2)
        .map((part) => part[0]).join("").toUpperCase() || "U";
      root.innerHTML = `<div class="account-profile">
        <div class="profile-head"><span class="avatar">${escapeHtml(initials)}</span>
          <div><strong>${escapeHtml(profile.full_name)}</strong><p>${escapeHtml(profile.email)}</p></div></div>
        <p class="callout">Votre rôle : <strong>${escapeHtml(roleNames[profile.role] || profile.role)}</strong></p>
        <form data-account-profile-form><div class="form-grid">
          <label>Nom complet<input name="full_name" value="${escapeHtml(profile.full_name)}" required minlength="2" maxlength="160"></label>
          <label>Adresse e-mail<input name="email" type="email" value="${escapeHtml(profile.email)}" required maxlength="255"></label>
          <label>Téléphone<input name="phone" value="${escapeHtml(profile.phone)}" maxlength="40"></label>
        </div><div class="form-actions"><button class="primary" type="submit">Enregistrer mes informations</button><span class="form-message muted" role="status"></span></div></form>
        <hr class="profile-divider"><h3>Sécurité du compte</h3>
        <form data-account-password-form><div class="form-grid">
          <label class="span-two">Mot de passe actuel<input name="current_password" type="password" required autocomplete="current-password"></label>
          <label>Nouveau mot de passe<input name="new_password" type="password" required minlength="12" maxlength="200" autocomplete="new-password"></label>
          <label>Confirmer le nouveau mot de passe<input name="confirm_password" type="password" required minlength="12" maxlength="200" autocomplete="new-password"></label>
        </div><div class="form-actions"><button class="quiet" type="submit">Modifier le mot de passe</button><span class="form-message muted" role="status"></span></div></form>
        </div>`;

      const profileForm = root.querySelector("[data-account-profile-form]");
      profileForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = profileForm.querySelector(".form-message");
        message.classList.remove("error");
        try {
          const updated = await api("/profile", {
            method: "PATCH",
            body: JSON.stringify(Object.fromEntries(new FormData(profileForm))),
          });
          root.querySelector(".profile-head strong").textContent = updated.full_name;
          root.querySelector(".profile-head p").textContent = updated.email;
          message.textContent = "Vos informations ont été enregistrées.";
          if (typeof onProfileUpdated === "function") onProfileUpdated(updated);
          if (typeof showToast === "function") showToast("Votre profil a été mis à jour.");
        } catch (error) {
          message.textContent = error.message;
          message.classList.add("error");
        }
      });

      const passwordForm = root.querySelector("[data-account-password-form]");
      passwordForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(passwordForm));
        const message = passwordForm.querySelector(".form-message");
        message.classList.remove("error");
        if (values.new_password !== values.confirm_password) {
          message.textContent = "Les nouveaux mots de passe ne correspondent pas.";
          message.classList.add("error");
          return;
        }
        try {
          await api("/profile/password", {
            method: "POST",
            body: JSON.stringify({
              current_password: values.current_password,
              new_password: values.new_password,
            }),
          });
          passwordForm.reset();
          message.textContent = "Votre mot de passe a été modifié. Reconnectez-vous avec le nouveau.";
          if (typeof onPasswordChanged === "function") onPasswordChanged();
        } catch (error) {
          message.textContent = error.message;
          message.classList.add("error");
        }
      });
    } catch (error) {
      root.innerHTML = `<p class="inline-error" role="alert">${escapeHtml(error.message)}</p>`;
    }
  }

  window.PrediMaintProfile = { render };
})();
