(() => {
  const STALE_AFTER_SECONDS = 30;
  const tunisDateFormatter = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Africa/Tunis",
  });

  function markReceived(measurement) {
    if (measurement && !Number.isFinite(measurement._client_received_at)) {
      measurement._client_received_at = Date.now();
    }
    return measurement;
  }

  function ageSeconds(measurement) {
    if (!measurement || !Number.isFinite(Number(measurement.age_seconds))) return null;
    markReceived(measurement);
    return Math.max(
      0,
      Number(measurement.age_seconds) + (Date.now() - measurement._client_received_at) / 1000,
    );
  }

  function freshness(measurement) {
    const age = ageSeconds(measurement);
    if (age === null) return { label: "Âge indisponible", stale: false };
    const seconds = Math.floor(age);
    return {
      label: age > STALE_AFTER_SECONDS
        ? `Données obsolètes · il y a ${seconds} s`
        : `À jour · il y a ${seconds} s`,
      stale: age > STALE_AFTER_SECONDS,
    };
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : tunisDateFormatter.format(date);
  }

  function formatDay(value) {
    if (!value) return "—";
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat("fr-FR", {
        weekday: "short",
        timeZone: "Africa/Tunis",
      }).format(date);
  }

  function modeLabel(mode) {
    if (mode === "hardware") return "Réel";
    if (mode === "simulated") return "Simulé";
    return "Origine inconnue";
  }

  function modeBadge(mode) {
    return `<span class="role-pill">${modeLabel(mode)}</span>`;
  }

  function currentSourceLabel(measurement) {
    if (!measurement || measurement.current_source === "unavailable" || measurement.current_rms === null) {
      return "Source du courant indisponible";
    }
    if (measurement.current_source === "simulated") return "Source simulée";
    if (measurement.current_source === "hardware") return "Source déclarée : ACS712 (non validée)";
    return "Source du courant inconnue";
  }

  function currentValue(measurement) {
    if (!measurement || measurement.current_rms === null || measurement.current_source === "unavailable") {
      return "Non disponible";
    }
    const value = Number(measurement.current_rms);
    return Number.isFinite(value) ? `${value.toFixed(1)} A` : "Non disponible";
  }

  function numberValue(value, decimals = 1) {
    if (value === null || value === undefined || value === "") return "Non disponible";
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(decimals) : "Non disponible";
  }

  function metricValue(metric, value) {
    if (value === null || value === undefined) return "Non disponible";
    const units = {
      temperature: "°C",
      humidity: "%",
      vibration_rate: "événements/s",
      vibration_edges: "événements",
      current_rms: "A",
    };
    const decimals = metric === "vibration_edges" ? 0 : metric === "vibration_rate" ? 2 : 1;
    const formatted = numberValue(value, decimals);
    return units[metric] ? `${formatted} ${units[metric]}` : formatted;
  }

  function sortAndDedupe(rows) {
    const seen = new Set();
    return rows.slice().sort((left, right) => {
      const timeDifference = Date.parse(left.recorded_at) - Date.parse(right.recorded_at);
      return timeDifference || Number(left.id) - Number(right.id);
    }).filter((row) => {
      const key = row.id ?? `${row.recorded_at}:${row.machine_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(markReceived);
  }

  window.PrediMaintMeasurements = {
    ageSeconds,
    currentSourceLabel,
    currentValue,
    formatDate,
    formatDay,
    freshness,
    markReceived,
    modeBadge,
    modeLabel,
    metricValue,
    numberValue,
    sortAndDedupe,
  };
})();
