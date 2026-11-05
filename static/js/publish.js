// Upload a cartridge bundle without leaving the page.  Without JavaScript the
// form still posts to /publish and the server answers with a flash message.
const form = document.getElementById("bundle-publish-form");
const result = document.getElementById("bundle-result");

if (form && result) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    result.className = "result-area";
    result.textContent = "Uploading…";
    button.disabled = true;
    try {
      const response = await fetch("/api/publish/bundle", {
        method: "POST",
        body: new FormData(form),
        headers: {
          Accept: "application/json",
          "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content || "",
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        result.className = "result-area error-text";
        result.textContent = data.error || `Upload failed (${response.status}).`;
        return;
      }
      result.className = "result-area success-text";
      result.textContent = `Submission #${data.submission_id} is waiting for editor review.`;
      const list = document.createElement("ul");
      for (const item of data.submitted || []) {
        const row = document.createElement("li");
        row.textContent = `${item.architecture}: ${item.file}`;
        list.appendChild(row);
      }
      if (data.preview) {
        const row = document.createElement("li");
        row.textContent = "preview.mp4: gameplay video";
        list.appendChild(row);
      }
      result.appendChild(list);
      form.reset();
    } catch (error) {
      result.className = "result-area error-text";
      result.textContent = "The upload did not reach the server. Check the connection and try again.";
    } finally {
      button.disabled = false;
    }
  });
}
