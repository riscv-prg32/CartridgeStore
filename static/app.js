if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/static/service-worker.js").catch(() => {});
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Browser forms carry the session's CSRF token.
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  if (token) {
    document.querySelectorAll("form").forEach((form) => {
      const method = (form.getAttribute("method") || "get").toLowerCase();
      if (method === "get" || form.querySelector('input[name="csrf_token"]')) return;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "csrf_token";
      input.value = token;
      form.appendChild(input);
    });
  }

  // Destructive forms ask first (data-confirm="question").
  document.querySelectorAll("form[data-confirm]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  // Header menus are native <details>: keep one open, close on Escape or outside click.
  const menus = [...document.querySelectorAll("details.nav-menu")];
  menus.forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (menu.open) menus.filter((other) => other !== menu).forEach((other) => { other.open = false; });
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    menus.forEach((menu) => {
      if (menu.open) {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    });
  });
  document.addEventListener("click", (event) => {
    menus.forEach((menu) => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
  });

  // Signing out also removes pages this browser cached for offline use.
  document.querySelectorAll('form[action="/auth/logout"]').forEach((form) => {
    form.addEventListener("submit", () => {
      if ("caches" in window) caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
    });
  });
});
