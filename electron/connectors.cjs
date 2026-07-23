class ShopifyConnector {
  constructor(store) {
    this.store = store;
  }

  listStores() {
    return this.store.getAppState().businesses;
  }

  listProducts(businessId) {
    return this.store.getBusiness(businessId).products;
  }

  listOrders(businessId) {
    return this.store.getBusiness(businessId).orders;
  }

  getMetrics(businessId) {
    return this.store.getBusiness(businessId).metrics;
  }

  listSignals(businessId) {
    return this.store.getBusiness(businessId).signals;
  }
}

class GeminiConnector {
  draftReply(conversation, prompt, business) {
    const instruction = prompt || "Draft the safest customer reply.";
    return {
      draft:
        `Draft for ${business.name}: acknowledge the customer, redirect to the website or secure checkout first, ` +
        `collect only missing order details, and require human approval before payment or fulfillment. Operator note: ${instruction}`,
      intent: this.classifyIntent(conversation),
      orderDetails: this.extractOrderDetails(conversation),
      summary: this.summarizeConversation(conversation),
      nextAction: this.recommendNextAction(conversation)
    };
  }

  classifyIntent(conversation) {
    return conversation.intent || "Support";
  }

  extractOrderDetails(conversation) {
    return conversation.orderDraft || null;
  }

  summarizeConversation(conversation) {
    return `${conversation.customer} on ${conversation.channel}: ${conversation.intent}. Risk: ${conversation.risk}.`;
  }

  recommendNextAction(conversation) {
    if (conversation.risk.toLowerCase().includes("approval")) return "Route to human approval.";
    if (conversation.orderDraft?.paymentStatus?.toLowerCase().includes("paid")) return "Verify payment and queue fulfillment.";
    return "Draft response and keep human in control.";
  }
}

class SocialConnector {
  constructor(store) {
    this.store = store;
  }

  listChannels(businessId) {
    return this.store.getBusiness(businessId).socials;
  }

  listConversations(businessId) {
    return this.store.listConversations(businessId);
  }
}

function createMockConnectors(store) {
  return {
    shopify: new ShopifyConnector(store),
    gemini: new GeminiConnector(),
    social: new SocialConnector(store)
  };
}

module.exports = { ShopifyConnector, GeminiConnector, SocialConnector, createMockConnectors };
