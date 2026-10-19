// This non-secret, device-local preference is applied before CSS loads. It does
// not touch the workspace schema, credentials, or the Electron API bridge.
(() => {
  const storageKey = "produdash.appearance";
  const choices = new Set(["system", "light", "dark", "glass-light", "glass-dark"]);
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let choice = "system";
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (choices.has(saved)) choice = saved;
  } catch {
    // Appearance still works for this session if local storage is unavailable.
  }

  function apply() {
    const root = document.documentElement;
    root.dataset.theme = choice;
    root.dataset.appearance = choice === "system" ? (system.matches ? "dark" : "light") : choice.endsWith("dark") ? "dark" : "light";
    root.dataset.material = choice.startsWith("glass-") ? "glass" : "solid";
    const control = document.querySelector("[data-appearance-select]");
    if (control) control.value = choice;
  }

  apply();
  system.addEventListener("change", () => {
    if (choice === "system") apply();
  });
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  document.addEventListener("change", (event) => {
    if (!event.target.matches("[data-appearance-select]") || !choices.has(event.target.value)) return;
    choice = event.target.value;
    try {
      window.localStorage.setItem(storageKey, choice);
    } catch {
      // Keep the selected appearance for this session.
    }
    apply();
  });
})();
