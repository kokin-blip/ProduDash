import { escapeHtml, formatUsd, statusLabel } from "./format.js";
import { getApprovals, getBusiness, getConversations, getPendingApprovals, getSelectedConversation, ui } from "./state.js";

export function renderFatalError(error) {
  document.querySelector("#viewRoot").innerHTML = `
    <article class="panel empty-state">
      <p class="eyebrow">Startup blocked</p>
      <h2>${escapeHtml(error.message)}</h2>
      <p>Run the desktop app with <strong>npm run app</strong>. The browser preview cannot access the secure local store.</p>
    </article>
  `;
}

export function renderApp() {
  renderNav();
  renderBusinesses();
  renderTopActions();
  renderActiveView();
}

function renderNav() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.hidden = false;
    item.classList.toggle("active", item.dataset.section === ui.activeSection);
  });
  document.querySelector(".sidebar-footer strong").textContent = "Connections required";
  document.querySelector(".sidebar-footer span:last-child").textContent = "Official APIs only";
}

function renderTopActions() {
  const syncButton = document.querySelector("#syncButton");
  syncButton.textContent = "Refresh connections";
  syncButton.disabled = !hasAnyCredentials();
  syncButton.title = syncButton.disabled ? "Add API credentials before refreshing connections." : "";
  document.querySelector("#trainButton").textContent = ui.activeSection === "integrations" ? "Clear local state" : "Connect apps";
}

function renderBusinesses() {
  document.querySelector("#businessStrip").innerHTML = ui.appState.businesses.length
    ? ui.appState.businesses
    .map((business) => {
      const active = business.id === ui.selectedBusinessId ? "active" : "";
      return `
        <button class="business-card ${active}" type="button" data-business="${business.id}">
          <span>${escapeHtml(business.type)}</span>
          <strong>${escapeHtml(business.name)}</strong>
          <small>${escapeHtml(business.aiMode)}</small>
        </button>
      `;
    })
    .join("")
    : `
      <button class="business-card active" type="button" data-section="integrations">
        <span>No businesses connected</span>
        <strong>Connect Shopify first</strong>
        <small>Official APIs only. No scraping or browser automation.</small>
      </button>
    `;
}

function renderActiveView() {
  const root = document.querySelector("#viewRoot");
  const standaloneSections = ["integrations", "studio", "analytics"];
  if (!getBusiness() && !standaloneSections.includes(ui.activeSection)) {
    root.innerHTML = wrapView(renderConnectionFirst());
    return;
  }
  const views = {
    overview: renderDashboard,
    inbox: renderInbox,
    orders: renderOrders,
    signals: renderSignals,
    studio: renderStudio,
    analytics: renderAnalytics,
    integrations: renderIntegrations
  };
  root.innerHTML = wrapView((views[ui.activeSection] || renderDashboard)());
}

function wrapView(markup) {
  return `<div class="view-transition">${markup}</div>`;
}

function credentialConfigured(id) {
  return ui.appState.credentialSettings?.some((setting) => setting.id === id && setting.status === "configured");
}

function hasAnyCredentials() {
  return ui.appState.credentialSettings?.some((setting) => setting.status === "configured");
}

function apiReadyForPlatforms(platforms = []) {
  return platforms.length > 0 && platforms.every((platform) => credentialConfigured(platform));
}

function renderConnectionFirst() {
  return `
    <section class="detail-grid">
      <article class="panel detail-panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Connection required</p>
            <h2>ProduDash is waiting for real accounts.</h2>
          </div>
          <span class="mini-badge">No demo data</span>
        </div>
        <div class="empty-state roomy">
          <strong>Start with Shopify + Gemini.</strong>
          <p>Connect a Shopify store through OAuth, then add Gemini on the server side for draft-only AI assistance. Social channels should be added only through approved platform APIs and app review.</p>
        </div>
        <div class="policy-list">
          <div class="policy-item"><span>1</span><p>No scraping private inboxes, no credential sharing, and no browser bots.</p></div>
          <div class="policy-item"><span>2</span><p>Use OAuth, official APIs, webhooks, least-privilege scopes, and platform review.</p></div>
          <div class="policy-item"><span>3</span><p>Keep AI in draft + approval mode until each platform explicitly permits the automation path.</p></div>
        </div>
      </article>
      ${renderCompliancePanel()}
    </section>
  `;
}

function renderDashboard() {
  const business = getBusiness();
  return `
    ${renderCockpitBar()}
    <section class="hero-grid">
      ${renderMetricsPanel(business)}
      ${renderAssistantPanel(business)}
    </section>
    <section class="operations-grid">
      ${renderSignalPanel(business)}
      ${renderNotificationPanel(business)}
      ${renderOrderPanel(business)}
      ${renderPolicyPanel(business)}
      ${renderChannelPanel(business)}
      ${renderAutomationPanel(business)}
      ${renderWorkflowPanel(business)}
      ${renderCommandPanel(business)}
      ${renderIntegrationPanel()}
    </section>
  `;
}

function renderCockpitBar() {
  const business = getBusiness();
  const unread = business.socials.reduce((sum, social) => sum + social.unread, 0);
  const activeAutomations = business.automations.filter((automation) => automation.enabled).length;
  const openCommands = business.commands.filter((command) => command.status !== "completed").length;
  const modes = [
    ["today", "Today"],
    ["socials", "Socials"],
    ["money", "Money"],
    ["ai", "AI Clerk"]
  ];
  return `
    <section class="cockpit-bar" aria-label="Business cockpit">
      <div class="segmented-control" aria-label="Dashboard mode">
        ${modes
          .map(
            ([mode, label]) =>
              `<button class="segment ${ui.selectedMode === mode ? "active" : ""}" type="button" data-mode="${mode}">${label}</button>`
          )
          .join("")}
      </div>
      <div class="quick-stats">
        <div class="quick-stat"><span>Unread</span><strong>${unread}</strong></div>
        <div class="quick-stat"><span>Automations</span><strong>${activeAutomations}</strong></div>
        <div class="quick-stat"><span>Actions</span><strong>${openCommands}</strong></div>
      </div>
    </section>
  `;
}

function renderMetricsPanel(business) {
  const metrics = [
    ["Revenue", formatUsd(business.metrics.revenue), "+12.4% this month"],
    ["Profit", formatUsd(business.metrics.profit), `${business.metrics.margin}% margin`],
    ["Orders", business.metrics.orderCount.toLocaleString(), "Across all channels"],
    ["Shipping", business.metrics.shipping, `${business.metrics.conversion}% conversion`]
  ];
  const maxRevenue = Math.max(...business.financeTrend.map((item) => item.revenue));
  const totalRevenue = business.financeTrend.reduce((sum, item) => sum + item.revenue, 0);
  const totalProfit = business.financeTrend.reduce((sum, item) => sum + item.profit, 0);
  return `
    <article class="panel metrics-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">${escapeHtml(business.category)}</p>
          <h2>${escapeHtml(business.name)}</h2>
        </div>
        <span class="health-pill">${escapeHtml(business.health)}</span>
      </div>
      <div class="metric-grid">
        ${metrics
          .map(
            ([label, value, trend]) => `
              <div class="metric-card">
                <span>${label}</span>
                <strong>${value}</strong>
                <small>${trend}</small>
              </div>
            `
          )
          .join("")}
      </div>
      <div class="trend-block">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Finance trend</p>
            <h2>Revenue and profit by week</h2>
          </div>
          <span class="mini-badge">${Math.round((totalProfit / totalRevenue) * 100)}% profit mix</span>
        </div>
        <div class="trend-chart" aria-label="Weekly finance trend">
          ${business.financeTrend
            .map((item) => {
              const revenueHeight = Math.max(18, Math.round((item.revenue / maxRevenue) * 100));
              const profitHeight = Math.max(14, Math.round((item.profit / maxRevenue) * 100));
              return `
                <div class="trend-column">
                  <div class="bars">
                    <span class="bar revenue" style="height: ${revenueHeight}%"></span>
                    <span class="bar profit" style="height: ${profitHeight}%"></span>
                  </div>
                  <small>${item.week}</small>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    </article>
  `;
}

function renderAssistantPanel(business) {
  const conversation = getSelectedConversation() || getConversations()[0];
  const messages = conversation?.messages || [];
  const geminiReady = credentialConfigured("gemini");
  return `
    <article class="panel assistant-panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">AI clerk</p>
          <h2>Live conversation assist</h2>
        </div>
        <span class="mini-badge">Approval mode</span>
      </div>
      <div class="chat-window">
        ${messages
          .map(
            (message) => `
              <div class="message ${message.role === "ai" ? "ai" : "customer"}">
                <span>${message.role === "ai" ? `${escapeHtml(business.name)} AI clerk` : "Customer"}</span>
                <p>${escapeHtml(message.text)}</p>
              </div>
            `
          )
          .join("")}
        <div class="message system">
          <span>Workflow</span>
          <p>Drafts require approval before replies, payment links, orders, refunds, or discounts.</p>
        </div>
      </div>
      <form class="chat-composer" data-draft-form>
        <input name="prompt" type="text" autocomplete="off" placeholder="${geminiReady ? "Draft reply or capture order" : "Add Gemini credentials to draft replies"}" ${geminiReady ? "" : "disabled"} />
        <button type="submit" ${geminiReady ? "" : "disabled title=\"Add Gemini credentials before drafting.\""}>Draft</button>
      </form>
    </article>
  `;
}

function renderSignalPanel(business) {
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Signal engine</p>
          <h2>What needs attention</h2>
        </div>
      </div>
      <div class="signal-list">${renderSignalsList(business.signals)}</div>
    </article>
  `;
}

function renderSignalsList(signals) {
  return signals
    .filter((signal) => signal.status !== "resolved")
    .map(
      (signal) => `
        <div class="signal-item ${signal.level.toLowerCase()}">
          <span>${escapeHtml(signal.level)}</span>
          <div>
            <strong>${escapeHtml(signal.title)}</strong>
            <p>${escapeHtml(signal.detail)}</p>
          </div>
        </div>
      `
    )
    .join("");
}

function renderNotificationPanel(business) {
  const approvals = getPendingApprovals(business.id);
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Notification center</p>
          <h2>AI replies and handoffs</h2>
        </div>
        <span class="mini-badge">${approvals.length} approvals</span>
      </div>
      <div class="notification-list">${renderApprovalList(approvals)}</div>
    </article>
  `;
}

function renderApprovalList(approvals) {
  if (!approvals.length) return `<div class="empty-state">No pending approvals.</div>`;
  return approvals
    .map(
      (approval) => `
        <div class="approval-item">
          <span>${statusLabel(approval.type)}</span>
          <strong>${escapeHtml(approval.nextAction || "Review draft")}</strong>
          <p>${escapeHtml(approval.draft)}</p>
          <div class="approval-actions">
            <button class="text-button" type="button" data-reject-approval="${approval.id}">Reject</button>
            <button class="primary-button small" type="button" data-approve-approval="${approval.id}">Approve</button>
          </div>
        </div>
      `
    )
    .join("");
}

function renderOrderPanel(business) {
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Commerce flow</p>
          <h2>Orders, shipping, payment checks</h2>
        </div>
      </div>
      <div class="order-list">${renderOrdersList(business.orders)}</div>
    </article>
  `;
}

function renderOrdersList(orders) {
  return orders
    .map(
      (order) => `
        <div class="order-item">
          <div>
            <strong>${escapeHtml(order.id)} ${escapeHtml(order.customer)}</strong>
            <span>${escapeHtml(order.stage)} · ${escapeHtml(order.paymentStatus)} · ${escapeHtml(order.fulfillmentStatus)}</span>
          </div>
          <div>
            <strong>${formatUsd(order.value)}</strong>
            <small>${escapeHtml(order.risk)}</small>
          </div>
        </div>
      `
    )
    .join("");
}

function renderPolicyPanel(business) {
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Business AI</p>
          <h2>Rules for this clerk</h2>
        </div>
        <span class="mini-badge">${escapeHtml(business.aiMode)}</span>
      </div>
      <div class="policy-list">
        ${business.aiPolicy
          .map(
            (policy, index) => `
              <div class="policy-item">
                <span>${index + 1}</span>
                <p>${escapeHtml(policy)}</p>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderChannelPanel(business) {
  const liveChannels = business.socials.filter((social) => social.status === "Connected").length;
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Social channels</p>
          <h2>Business inbox coverage</h2>
        </div>
        <span class="mini-badge">${liveChannels} live</span>
      </div>
      <div class="channel-grid">
        ${business.socials
          .map(
            (social) => `
              <div class="channel-card">
                <div>
                  <strong>${escapeHtml(social.name)}</strong>
                  <span>${escapeHtml(social.tone)}</span>
                </div>
                <small>${escapeHtml(social.status)}</small>
                <div class="channel-meta">
                  <span>${social.unread} unread</span>
                  <span>${escapeHtml(social.automation)}</span>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderAutomationPanel(business) {
  const enabledCount = business.automations.filter((automation) => automation.enabled).length;
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">AI permissions</p>
          <h2>Automation guardrails</h2>
        </div>
        <span class="mini-badge">${enabledCount} active</span>
      </div>
      <div class="automation-list">
        ${business.automations
          .map(
            (automation) => `
              <div class="automation-item">
                <span class="toggle ${automation.enabled ? "enabled" : ""}" aria-hidden="true"></span>
                <div>
                  <strong>${escapeHtml(automation.name)}</strong>
                  <p>${escapeHtml(automation.limit)}</p>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderWorkflowPanel(business) {
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Chat checkout</p>
          <h2>When a customer orders by message</h2>
        </div>
      </div>
      <div class="workflow-list">
        ${business.checkoutWorkflow
          .map(
            (step, index) => `
              <div class="workflow-item">
                <span>${index + 1}</span>
                <p>${escapeHtml(step)}</p>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderCommandPanel(business) {
  const commands = business.commands.filter((command) => command.status !== "completed");
  return `
    <article class="panel command-panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Command queue</p>
          <h2>Next best actions</h2>
        </div>
        ${commands[0] ? `<button class="text-button" type="button" data-complete-command="${commands[0].id}">Complete first</button>` : ""}
      </div>
      <div class="command-list">
        ${
          commands.length
            ? commands
                .map(
                  (command) => `
                    <div class="command-item">
                      <span>${escapeHtml(command.owner)}</span>
                      <strong>${escapeHtml(command.title)}</strong>
                      <p>${escapeHtml(command.detail)}</p>
                    </div>
                  `
                )
                .join("")
            : `<div class="empty-state">No pending actions for ${escapeHtml(business.name)}.</div>`
        }
      </div>
    </article>
  `;
}

function renderIntegrationPanel() {
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Integrations</p>
          <h2>Connected channels</h2>
        </div>
      </div>
      <div class="integration-grid">${renderIntegrationCards()}</div>
    </article>
  `;
}

function renderCompliancePanel() {
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Rules-first automation</p>
          <h2>How ProduDash avoids bans</h2>
        </div>
        <span class="mini-badge">Draft + approval</span>
      </div>
      ${renderComplianceBody()}
    </article>
  `;
}

function renderComplianceBody() {
  return `
    <div class="policy-list">
      <div class="policy-item">
        <span>API</span>
        <p>Connect through each platform's official developer program, OAuth flow, approved scopes, and webhook system.</p>
      </div>
      <div class="policy-item">
        <span>AI</span>
        <p>Gemini drafts replies and extracts order details, but ProduDash does not send messages, create payment links, or submit orders without approval.</p>
      </div>
      <div class="policy-item">
        <span>DM</span>
        <p>Social messaging must honor user-initiated conversation windows, opt-ins, rate limits, and app-review limits.</p>
      </div>
      <div class="policy-item">
        <span>NO</span>
        <p>No scraping, stealth browser automation, password sharing, private-account automation, spam, or attempts to bypass platform restrictions.</p>
      </div>
    </div>
  `;
}

function renderIntegrationCards() {
  return ui.appState.integrations
    .map((integration) => {
      const credentials = ui.appState.credentialSettings?.find((setting) => setting.id === integration.id);
      const credentialStatus = credentials?.status === "configured" ? "credentials saved" : "credentials needed";
      return `
        <div class="integration-card">
          <strong>${escapeHtml(integration.name)}</strong>
          <span>${escapeHtml(integration.detail)}</span>
          <small>${statusLabel(integration.status)} · ${escapeHtml(integration.lastSync)} · ${credentialStatus}</small>
          <p>${escapeHtml(integration.compliance)}</p>
        </div>
      `;
    })
    .join("");
}

function renderInbox() {
  const conversations = getConversations();
  const selected = getSelectedConversation() || conversations[0];
  const approvals = selected ? getApprovals().filter((approval) => approval.conversationId === selected.id) : [];
  const geminiReady = credentialConfigured("gemini");
  return `
    <section class="detail-grid">
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">AI Inbox</p>
            <h2>Customer threads</h2>
          </div>
          <span class="mini-badge">${conversations.length} threads</span>
        </div>
        <div class="conversation-list">
          ${conversations
            .map(
              (conversation) => `
                <button class="conversation-item ${conversation.id === selected?.id ? "active" : ""}" type="button" data-conversation="${conversation.id}">
                  <span>${escapeHtml(conversation.channel)} · ${statusLabel(conversation.status)}</span>
                  <strong>${escapeHtml(conversation.customer)}</strong>
                  <p>${escapeHtml(conversation.intent)} · ${escapeHtml(conversation.risk)}</p>
                </button>
              `
            )
            .join("")}
        </div>
      </article>
      <article class="panel detail-panel">
        ${
          selected
            ? `
              <div class="panel-heading compact">
                <div>
                  <p class="eyebrow">${escapeHtml(selected.channel)}</p>
                  <h2>${escapeHtml(selected.customer)} · ${escapeHtml(selected.intent)}</h2>
                </div>
                <span class="mini-badge">${statusLabel(selected.status)}</span>
              </div>
              <div class="chat-window detail-chat">
                ${selected.messages
                  .map(
                    (message) => `
                      <div class="message ${message.role === "ai" ? "ai" : "customer"}">
                        <span>${escapeHtml(message.role)}</span>
                        <p>${escapeHtml(message.text)}</p>
                      </div>
                    `
                  )
                  .join("")}
              </div>
              <div class="order-draft">
                <strong>Order draft</strong>
                <span>${escapeHtml(selected.orderDraft.item)} · ${escapeHtml(selected.orderDraft.variant)} · ${formatUsd(selected.orderDraft.value)} · ${escapeHtml(selected.orderDraft.paymentStatus)}</span>
              </div>
              <form class="chat-composer" data-draft-form>
                <input name="prompt" type="text" autocomplete="off" placeholder="${geminiReady ? "Tell Gemini what to draft" : "Add Gemini credentials to draft replies"}" ${geminiReady ? "" : "disabled"} />
                <button type="submit" ${geminiReady ? "" : "disabled title=\"Add Gemini credentials before drafting.\""}>Draft for approval</button>
              </form>
              <div class="approval-stack">${renderApprovalList(approvals)}</div>
            `
            : `<div class="empty-state">No conversations for this business.</div>`
        }
      </article>
    </section>
  `;
}

function renderOrders() {
  const business = getBusiness();
  return `
    <section class="single-view">
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Orders</p>
            <h2>${escapeHtml(business.name)} commerce queue</h2>
          </div>
          <span class="mini-badge">${business.orders.length} orders</span>
        </div>
        <div class="order-list">${renderOrdersList(business.orders)}</div>
      </article>
    </section>
  `;
}

function renderSignals() {
  const business = getBusiness();
  return `
    <section class="detail-grid">
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Signals</p>
            <h2>Store and website issues</h2>
          </div>
        </div>
        <div class="signal-list">${renderSignalsList(business.signals)}</div>
      </article>
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Audit log</p>
            <h2>AI and operator actions</h2>
          </div>
        </div>
        <div class="audit-list">
          ${ui.appState.auditLog
            .slice(0, 8)
            .map(
              (entry) => `
                <div class="audit-item">
                  <span>${escapeHtml(entry.type)} · ${new Date(entry.at).toLocaleString()}</span>
                  <p>${escapeHtml(entry.detail)}</p>
                </div>
              `
            )
            .join("")}
        </div>
      </article>
    </section>
  `;
}

function renderIntegrations() {
  return `
    <section class="detail-grid">
      ${renderIntegrationPanel(true)}
      ${renderCredentialsPanel()}
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Compliance mode</p>
            <h2>Build with official APIs only</h2>
          </div>
          <button class="text-button" type="button" data-reset-local>Clear local state</button>
        </div>
        ${renderComplianceBody()}
      </article>
    </section>
  `;
}

function renderStudio() {
  const jobs = ui.appState.clipperJobs || [];
  const posts = ui.appState.postQueue || [];
  return `
    <section class="hero-grid">
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Auto clipper</p>
            <h2>Queue vertical clips from long videos</h2>
          </div>
          <span class="mini-badge">Local plan</span>
        </div>
        <form class="studio-form" data-clip-form>
          <label>
            <span>Clip title</span>
            <input name="title" type="text" autocomplete="off" placeholder="Summer drop product demo" />
          </label>
          <label>
            <span>Source video</span>
            <div class="file-input-row">
              <input name="source" type="text" autocomplete="off" placeholder="Local file path or source URL" />
              <button class="text-button" type="button" data-browse-video>Browse</button>
            </div>
          </label>
          <label>
            <span>Clip goal</span>
            <input name="goal" type="text" autocomplete="off" placeholder="Find hooks, product benefits, and quick proof moments" />
          </label>
          <label>
            <span>Target length</span>
            <input name="targetLength" type="text" autocomplete="off" placeholder="30-45 seconds" />
          </label>
          ${renderPlatformChecks()}
          <button class="primary-button" type="submit">Create clip job</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Auto poster</p>
            <h2>Plan approved short-form posts</h2>
          </div>
          <span class="mini-badge">Approval required</span>
        </div>
        <form class="studio-form" data-post-form>
          <label>
            <span>Clip job</span>
            <select name="clipJobId">
              <option value="">No clip selected</option>
              ${jobs.map((job) => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>Post title</span>
            <input name="title" type="text" autocomplete="off" placeholder="Best moment from the product demo" />
          </label>
          <label>
            <span>Caption</span>
            <textarea name="caption" placeholder="Caption, hashtags, CTA, disclosure notes"></textarea>
          </label>
          <label>
            <span>Schedule target</span>
            <input name="scheduledFor" type="text" autocomplete="off" placeholder="Tomorrow 6 PM or 2026-07-04 18:00" />
          </label>
          ${renderPlatformChecks()}
          <button class="primary-button" type="submit">Create post plan</button>
        </form>
      </article>
    </section>
    <section class="operations-grid">
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Clip queue</p>
            <h2>${jobs.length} local jobs</h2>
          </div>
        </div>
        <div class="studio-list">
          ${
            jobs.length
              ? jobs.map(renderClipJob).join("")
              : `<div class="empty-state">No clip jobs yet. Add a source video to start building the local clipping queue.</div>`
          }
        </div>
      </article>
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Publishing queue</p>
            <h2>${posts.length} post plans</h2>
          </div>
        </div>
        <div class="studio-list">
          ${
            posts.length
              ? posts.map(renderPostPlan).join("")
              : `<div class="empty-state">No post plans yet. ProduDash will require approval before any official API upload or manual export.</div>`
          }
        </div>
      </article>
      ${renderPublishingRulesPanel()}
    </section>
  `;
}

function renderPlatformChecks() {
  return `
    <fieldset class="platform-checks">
      <legend>Destinations</legend>
      ${ui.appState.creatorPlatforms
        .map(
          (platform) => `
            <label>
              <input name="platforms" type="checkbox" value="${escapeHtml(platform.id)}" />
              <span>${escapeHtml(platform.name)}</span>
            </label>
          `
        )
        .join("")}
    </fieldset>
  `;
}

function renderClipJob(job) {
  return `
    <div class="studio-item">
      <span>${statusLabel(job.status)} · ${new Date(job.createdAt).toLocaleString()}</span>
      <strong>${escapeHtml(job.title)}</strong>
      <p>${escapeHtml(job.goal || "No clip goal provided.")}</p>
      <small>${escapeHtml(job.targetLength)} · ${job.platforms.map(statusLabel).join(", ") || "No destination selected"}</small>
    </div>
  `;
}

function renderPostPlan(plan) {
  const apiReady = apiReadyForPlatforms(plan.platforms);
  return `
    <div class="studio-item">
      <span>${statusLabel(plan.status)} · ${new Date(plan.createdAt).toLocaleString()}</span>
      <strong>${escapeHtml(plan.title)}</strong>
      <p>${escapeHtml(plan.caption || "No caption yet.")}</p>
      <small>${escapeHtml(plan.scheduledFor || "No schedule target")} · ${plan.platforms.map(statusLabel).join(", ") || "No destination selected"}</small>
      <div class="approval-actions">
        ${
          plan.status === "needs_approval"
            ? `<button class="primary-button small" type="button" data-approve-post="${escapeHtml(plan.id)}" ${apiReady ? "" : "disabled title=\"Connect the selected destination APIs before approving this path.\""}>${apiReady ? "Approve API path" : "Connect APIs first"}</button>`
            : ""
        }
        <button class="text-button" type="button" data-export-post="${escapeHtml(plan.id)}">Mark export-ready</button>
      </div>
    </div>
  `;
}

function renderPublishingRulesPanel() {
  return `
    <article class="panel command-panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Allowed publishing paths</p>
          <h2>Auto posting without account-risk automation</h2>
        </div>
      </div>
      <div class="platform-grid">
        ${ui.appState.creatorPlatforms
          .map(
            (platform) => `
              <div class="platform-card">
                <strong>${escapeHtml(platform.name)}</strong>
                <span>${escapeHtml(platform.format)}</span>
                <p>${escapeHtml(platform.postingMode)}</p>
                <small>${platform.requirements.map(escapeHtml).join(" · ")}</small>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderAnalytics() {
  const sources = ui.appState.analyticsSources || [];
  return `
    <section class="detail-grid">
      <article class="panel detail-panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">In-app analytics</p>
            <h2>Short-form performance framework</h2>
          </div>
          <span class="mini-badge">Waiting for APIs</span>
        </div>
        <div class="analytics-grid">
          ${sources.map(renderAnalyticsSource).join("")}
        </div>
      </article>
      <article class="panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Signals</p>
            <h2>What ProduDash will calculate</h2>
          </div>
        </div>
        <div class="policy-list">
          <div class="policy-item"><span>1</span><p>Compare hooks by 3-second hold, average watch duration, completion, saves, shares, and comments.</p></div>
          <div class="policy-item"><span>2</span><p>Connect post performance to Shopify revenue once store attribution is available.</p></div>
          <div class="policy-item"><span>3</span><p>Recommend reposts, edits, posting windows, and product angles without scraping platform dashboards.</p></div>
          <div class="policy-item"><span>4</span><p>Keep imported analytics tied to official platform accounts, OAuth scopes, quotas, and consent.</p></div>
        </div>
      </article>
    </section>
  `;
}

function renderAnalyticsSource(source) {
  return `
    <div class="analytics-card">
      <div>
        <strong>${escapeHtml(source.name)}</strong>
        <span>${statusLabel(source.status)} · ${escapeHtml(source.lastSync)}</span>
      </div>
      <div class="metric-chip-list">
        ${source.metrics.map((metric) => `<small>${escapeHtml(metric)}</small>`).join("")}
      </div>
    </div>
  `;
}

function renderCredentialsPanel() {
  const settings = ui.appState.credentialSettings || [];
  return `
    <article class="panel detail-panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Settings</p>
          <h2>User-supplied API keys</h2>
        </div>
        <span class="mini-badge">Local only</span>
      </div>
      <div class="credential-stack">
        ${settings
          .map(
            (setting) => `
              <form class="credential-card" data-credentials-form="${escapeHtml(setting.id)}">
                <div class="credential-heading">
                  <div>
                    <strong>${escapeHtml(setting.name)}</strong>
                    <span>${escapeHtml(setting.note)}</span>
                  </div>
                  <small>${setting.status === "configured" ? "Saved" : "Missing"}</small>
                </div>
                <div class="credential-fields">
                  ${setting.fields
                    .map((field) => {
                      const configured = setting.configuredFields.includes(field.key);
                      const placeholder = configured ? "Saved locally. Enter a new value to replace." : field.placeholder;
                      return `
                        <label class="credential-field">
                          <span>${escapeHtml(field.label)}</span>
                          <input
                            name="${escapeHtml(field.key)}"
                            type="${escapeHtml(field.type)}"
                            autocomplete="off"
                            spellcheck="false"
                            placeholder="${escapeHtml(placeholder)}"
                          />
                        </label>
                      `;
                    })
                    .join("")}
                </div>
                <div class="credential-actions">
                  <span>${setting.updatedAt ? `Updated ${new Date(setting.updatedAt).toLocaleString()}` : "No key saved yet"}</span>
                  <div>
                    ${
                      setting.status === "configured"
                        ? `<button class="text-button" type="button" data-remove-credentials="${escapeHtml(setting.id)}">Remove</button>`
                        : ""
                    }
                    <button class="primary-button small" type="submit">Save</button>
                  </div>
                </div>
              </form>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}
