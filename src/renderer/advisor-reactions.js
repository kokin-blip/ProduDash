const CELEBRATION_VARIANTS = Object.freeze(["hop", "notebook"]);
const CELEBRATION_COOLDOWN_MS = 1800;
const MEDIA_WARNING_STATUSES = new Set(["failed", "interrupted"]);

let lastCelebrationAt = 0;
let nextCelebrationIndex = 0;

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

function launcher() {
  return document.querySelector("[data-advisor-toggle]");
}

function attachCleanup(element) {
  element.addEventListener(
    "animationend",
    (event) => {
      if (event.target === element && element.isConnected) element.remove();
    },
    { once: true }
  );
}

function replaceTransientReaction(element) {
  const target = launcher();
  if (!target || reducedMotion()) return false;
  target.querySelector("[data-advisor-reaction]")?.remove();
  target.prepend(element);
  attachCleanup(element);
  return true;
}

export function celebrateAdvisor() {
  const now = Date.now();
  if (reducedMotion() || now - lastCelebrationAt < CELEBRATION_COOLDOWN_MS) return false;
  const variant = CELEBRATION_VARIANTS[nextCelebrationIndex % CELEBRATION_VARIANTS.length];
  const popover = document.createElement("span");
  popover.className = `advisor-celebration-popover celebration-${variant}`;
  popover.dataset.advisorCelebration = variant;
  popover.dataset.advisorReaction = "completed";
  popover.setAttribute("aria-hidden", "true");
  const sprite = document.createElement("span");
  sprite.className = "advisor-celebration-sprite";
  popover.append(sprite);
  if (!replaceTransientReaction(popover)) return false;
  nextCelebrationIndex += 1;
  lastCelebrationAt = now;
  return true;
}

export function acknowledgeAdvisor() {
  const reaction = document.createElement("span");
  reaction.className = "advisor-job-reaction is-acknowledging";
  reaction.dataset.advisorReaction = "acknowledgement";
  reaction.setAttribute("aria-hidden", "true");
  reaction.innerHTML = '<img src="./assets/advisor/states/advisor-success.png" alt="" />';
  return replaceTransientReaction(reaction);
}

function showJobReaction(kind, animate) {
  if (reducedMotion()) return false;
  const target = launcher();
  if (!target) return false;
  const existing = target.querySelector(`[data-advisor-job-reaction="${kind}"]`);
  if (existing) return false;
  target.querySelector("[data-advisor-reaction]")?.remove();
  const reaction = document.createElement("span");
  reaction.className = `advisor-job-reaction is-${kind}${animate ? " is-entering" : ""}`;
  reaction.dataset.advisorReaction = kind;
  reaction.dataset.advisorJobReaction = kind;
  reaction.setAttribute("aria-hidden", "true");
  const art = kind === "warning" ? "warning" : "thinking";
  reaction.innerHTML = `<img src="./assets/advisor/states/advisor-${art}.png" alt="" />`;
  target.prepend(reaction);
  return true;
}

function statusMap(jobs) {
  return new Map((Array.isArray(jobs) ? jobs : []).map((job) => [job?.id, job?.status]));
}

export function reactToMediaJobUpdates(previousJobs, currentJobs) {
  if (reducedMotion()) {
    launcher()
      ?.querySelectorAll("[data-advisor-reaction]")
      .forEach((element) => element.remove());
    return { kind: null, jobId: null };
  }
  const previous = statusMap(previousJobs);
  const current = Array.isArray(currentJobs) ? currentJobs : [];
  const transitions = current.filter((job) => job?.id && previous.has(job.id) && previous.get(job.id) !== job.status);
  const completed = transitions.find((job) => job.status === "completed");
  if (completed) {
    celebrateAdvisor();
    return { kind: "completed", jobId: completed.id };
  }
  const warning = transitions.find((job) => MEDIA_WARNING_STATUSES.has(job.status));
  if (warning) {
    showJobReaction("warning", true);
    return { kind: "warning", jobId: warning.id };
  }
  const processingTransition = transitions.find((job) => job.status === "processing");
  if (processingTransition) {
    showJobReaction("working", true);
    return { kind: "working", jobId: processingTransition.id };
  }
  const processing = current.find((job) => job?.status === "processing");
  if (processing) {
    showJobReaction("working", false);
    return { kind: "working", jobId: processing.id };
  }
  launcher()?.querySelector("[data-advisor-job-reaction]")?.remove();
  return { kind: null, jobId: null };
}

export function resetAdvisorReactionStateForTests() {
  lastCelebrationAt = 0;
  nextCelebrationIndex = 0;
}
