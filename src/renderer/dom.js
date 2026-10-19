// Patch the current presentation in place. Keys are existing behavioral contracts;
// no workspace data or credentials are copied into a parallel renderer store.
const scopes = new WeakMap();

function key(node) {
  if (node.nodeType !== 1) return null;
  if (node.id) return `id:${node.id}`;
  const identities = [...node.attributes].filter(
    ({ name }) => name.startsWith("data-") && !["data-pending-label", "data-status-value", "data-advisor-art-state"].includes(name)
  );
  if (identities.length) return `${node.tagName}:${identities.map(({ name, value }) => `${name}=${value}`).join("|")}`;
  if (node.name) return `${node.tagName}:${node.name}:${["checkbox", "radio"].includes(node.type) ? node.value : ""}`;
  return null;
}

function compatible(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
}

function defaultValue(control) {
  if (control.tagName === "SELECT") {
    return [...control.options].find((option) => option.defaultSelected)?.value ?? control.options[0]?.value ?? "";
  }
  return control.defaultValue;
}

function patchNode(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  const control = ["INPUT", "TEXTAREA", "SELECT"].includes(current.tagName);
  const initialValue = control ? defaultValue(current) : null;
  const nextValue = control ? defaultValue(next) : null;
  const liveValue = control ? current.value : null;
  const preserveValue = control && liveValue !== initialValue && nextValue === initialValue;
  const checked = current.checked;
  const preserveChecked =
    current.tagName === "INPUT" && current.checked !== current.defaultChecked && current.defaultChecked === next.defaultChecked;
  const disclosure = current.tagName === "DETAILS" || current.tagName === "DIALOG";
  const open = current.open;
  const scrollTop = current.scrollTop;
  const scrollLeft = current.scrollLeft;
  for (const { name } of [...current.attributes]) {
    if (!next.hasAttribute(name) && !(disclosure && name === "open")) current.removeAttribute(name);
  }
  for (const { name, value } of [...next.attributes]) {
    if (disclosure && name === "open") continue;
    // Reassigning media src even to the same URL resets playback in Chromium.
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  }
  patchChildren(current, next);
  if (control && current.type !== "file") {
    const value = preserveValue ? liveValue : next.value;
    if (current.value !== value) current.value = value;
    if (["checkbox", "radio"].includes(current.type)) current.checked = preserveChecked ? checked : next.checked;
  }
  if (disclosure) current.open = open;
  current.scrollTop = scrollTop;
  current.scrollLeft = scrollLeft;
}

function patchChildren(current, next) {
  const available = [...current.childNodes];
  let cursor = current.firstChild;
  for (const target of [...next.childNodes]) {
    const targetKey = key(target);
    let source = available.find((candidate) => compatible(candidate, target) && (targetKey || candidate === cursor));
    if (!source && !targetKey) {
      source = available.find(
        (candidate) => compatible(candidate, target) && candidate.nodeType === 1 && candidate.classList?.[0] === target.classList?.[0]
      );
    }
    if (!source) {
      source = target.cloneNode(true);
      current.insertBefore(source, cursor);
    } else {
      available.splice(available.indexOf(source), 1);
      if (source !== cursor) current.insertBefore(source, cursor);
      patchNode(source, target);
    }
    cursor = source.nextSibling;
  }
  for (const unused of available) unused.remove();
}

export function updateMarkup(root, markup, scope = "") {
  const template = document.createElement("template");
  template.innerHTML = markup;
  if (scopes.get(root) !== scope) {
    root.replaceChildren(template.content);
    scopes.set(root, scope);
    return;
  }
  const focused = document.activeElement;
  const selection =
    focused && typeof focused.selectionStart === "number"
      ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection }
      : null;
  patchChildren(root, template.content);
  if (focused?.isConnected && selection) focused.setSelectionRange(selection.start, selection.end, selection.direction);
}

// Successful submissions consume their form draft; errors keep it available.
export function consumeFormDraft(trigger) {
  const form = trigger?.closest("form");
  if (form && trigger.type === "submit") form.reset();
}
