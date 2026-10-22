if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/static/service-worker.js").catch(() => {});
  });
}
document.addEventListener("DOMContentLoaded", () => {
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!token) return;
  document.querySelectorAll("form").forEach((form) => {
    const method = (form.getAttribute("method") || "get").toLowerCase();
    if (method === "get" || form.querySelector('input[name="csrf_token"]')) return;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "csrf_token";
    input.value = token;
    form.appendChild(input);
  });
});
