const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { JSDOM } = require("jsdom");

async function harness() {
  const dom = new JSDOM('<main id="root"></main>');
  global.document = dom.window.document;
  const module = await import(pathToFileURL(path.join(__dirname, "../src/renderer/dom.js")).href);
  return { ...module, dom, root: dom.window.document.querySelector("main") };
}

test("job refresh retains form drafts, focus, selection, checkbox choices and open disclosures", async () => {
  const { root, updateMarkup } = await harness();
  const markup = (status) => `<details><summary>Settings</summary><form data-settings-form>
    <input name="title" value="Original"><textarea name="notes">Notes</textarea>
    <input name="consent" type="checkbox"><select name="mode"><option value="a">A</option><option value="b">B</option></select>
    <span data-status-key="job">${status}</span></form></details>`;
  updateMarkup(root, markup("Queued"), "project-1");
  const title = root.querySelector("input");
  title.value = "Unsaved title";
  title.focus();
  title.setSelectionRange(2, 8);
  root.querySelector("textarea").value = "Unsaved notes";
  root.querySelector('[type="checkbox"]').checked = true;
  root.querySelector("select").value = "b";
  root.querySelector("details").open = true;
  updateMarkup(root, markup("Rendering"), "project-1");
  assert.equal(root.querySelector("input"), title);
  assert.equal(root.ownerDocument.activeElement, title);
  assert.equal(title.value, "Unsaved title");
  assert.deepEqual([title.selectionStart, title.selectionEnd], [2, 8]);
  assert.equal(root.querySelector("textarea").value, "Unsaved notes");
  assert.equal(root.querySelector('[type="checkbox"]').checked, true);
  assert.equal(root.querySelector("select").value, "b");
  assert.equal(root.querySelector("details").open, true);
  assert.equal(root.querySelector("[data-status-key]").textContent, "Rendering");
});

test("background list insertions retain the media element and its playhead", async () => {
  const { root, updateMarkup } = await harness();
  const job = (id) => `<article data-media-job="${id}"><video src="produdash-media://clip/${id}"></video></article>`;
  updateMarkup(root, job("a"), "create");
  const video = root.querySelector("video");
  video.currentTime = 12.5;
  updateMarkup(root, job("b") + job("a"), "create");
  assert.equal(root.querySelector('[data-media-job="a"] video'), video);
  assert.equal(video.currentTime, 12.5);
  assert.equal(root.querySelectorAll("video").length, 2);
});

test("new saved values replace stale controls; changing record scope never carries a draft across records", async () => {
  const { root, updateMarkup } = await harness();
  updateMarkup(root, '<input name="title" value="Original">', "a");
  root.querySelector("input").value = "Unsaved";
  updateMarkup(root, '<input name="title" value="Saved update">', "a");
  assert.equal(root.querySelector("input").value, "Saved update");
  root.querySelector("input").value = "Another unsaved edit";
  updateMarkup(root, '<input name="title" value="Different record">', "b");
  assert.equal(root.querySelector("input").value, "Different record");
});

test("credential inputs stay mounted without serializing secrets, and only successful submissions consume drafts", async () => {
  const { root, updateMarkup, consumeFormDraft } = await harness();
  const markup =
    '<form data-credentials-form="shopify"><input name="token" type="password"><button type="button">Test</button><button type="submit">Save</button></form>';
  updateMarkup(root, markup, "integrations");
  const token = root.querySelector("input");
  token.value = "entered-secret";
  consumeFormDraft(root.querySelector('[type="button"]'));
  updateMarkup(root, markup, "integrations");
  assert.equal(root.querySelector("input"), token);
  assert.equal(token.value, "entered-secret");
  assert.doesNotMatch(root.innerHTML, /entered-secret/);
  consumeFormDraft(root.querySelector('[type="submit"]'));
  updateMarkup(root, markup, "integrations");
  assert.equal(token.value, "");
});
