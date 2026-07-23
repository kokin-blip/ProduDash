const { AppError } = require("../errors.cjs");
const { boundedString, normalizeShopifyDomain } = require("../validation.cjs");

const SHOP_QUERY = `
  query ProduDashShop {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
    }
  }
`;

const PRODUCTS_QUERY = `
  query ProduDashProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        status
        totalInventory
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ORDERS_QUERY = `
  query ProduDashOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          displayName
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeShopifyError(status) {
  if (status === 401 || status === 403) return new AppError("SHOPIFY_AUTH_FAILED", "Shopify rejected the Admin API credentials.");
  if (status === 429) return new AppError("SHOPIFY_RATE_LIMITED", "Shopify is temporarily rate limiting this store.");
  return new AppError("SHOPIFY_API_ERROR", "Shopify could not complete the requested synchronization.");
}

class ShopifyClient {
  constructor(options = {}) {
    this.transport = options.transport || fetch;
    this.apiVersion = options.apiVersion || "2026-07";
    this.timeoutMs = options.timeoutMs || 10_000;
    this.maxItems = options.maxItems || 100;
    this.pageSize = Math.min(options.pageSize || 50, 50);
    this.sleep = options.sleep || delay;
  }

  async request(domain, token, query, variables = {}) {
    const endpoint = `https://${domain}/admin/api/${this.apiVersion}/graphql.json`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.transport(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            const retryAfter = Number(response.headers?.get?.("retry-after"));
            await this.sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** attempt);
            continue;
          }
          throw safeShopifyError(response.status);
        }
        const body = await response.json();
        if (Array.isArray(body.errors) && body.errors.length) {
          const throttled = body.errors.some((error) => error?.extensions?.code === "THROTTLED");
          if (throttled && attempt < 2) {
            await this.sleep(250 * 2 ** attempt);
            continue;
          }
          throw new AppError("SHOPIFY_GRAPHQL_ERROR", "Shopify rejected one of the requested data fields.");
        }
        if (!body.data || typeof body.data !== "object") {
          throw new AppError("SHOPIFY_INVALID_RESPONSE", "Shopify returned an invalid response.");
        }
        return body.data;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error?.name === "AbortError") throw new AppError("SHOPIFY_TIMEOUT", "Shopify did not respond before the request timed out.");
        if (attempt < 2) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new AppError("SHOPIFY_NETWORK_ERROR", "ProduDash could not reach Shopify.");
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new AppError("SHOPIFY_API_ERROR", "Shopify could not complete the requested synchronization.");
  }

  async paginate(domain, token, query, key) {
    const nodes = [];
    let after = null;
    while (nodes.length < this.maxItems) {
      const first = Math.min(this.pageSize, this.maxItems - nodes.length);
      const data = await this.request(domain, token, query, { first, after });
      const connection = data[key];
      if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
        throw new AppError("SHOPIFY_INVALID_RESPONSE", `Shopify returned invalid ${key} data.`);
      }
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
      after = connection.pageInfo.endCursor;
    }
    return nodes.slice(0, this.maxItems);
  }

  async sync(credentials) {
    const domain = normalizeShopifyDomain(credentials.storeDomain);
    const token = boundedString(credentials.adminAccessToken, { label: "Shopify Admin API token", min: 8, max: 4096 });
    const shopData = await this.request(domain, token, SHOP_QUERY);
    if (!shopData.shop?.id || !shopData.shop?.name)
      throw new AppError("SHOPIFY_INVALID_RESPONSE", "Shopify did not return a shop identity.");

    const [productsResult, ordersResult] = await Promise.allSettled([
      this.paginate(domain, token, PRODUCTS_QUERY, "products"),
      this.paginate(domain, token, ORDERS_QUERY, "orders")
    ]);
    const products = productsResult.status === "fulfilled" ? productsResult.value : [];
    const orders = ordersResult.status === "fulfilled" ? ordersResult.value : [];
    const degraded = productsResult.status === "rejected" || ordersResult.status === "rejected";
    const syncedAt = new Date().toISOString();
    return {
      status: degraded ? "degraded" : "connected",
      error: degraded ? "Some Shopify data could not be refreshed. Try again later." : null,
      syncedAt,
      business: normalizeBusiness(shopData.shop, products, orders, syncedAt, degraded)
    };
  }
}

function normalizeBusiness(shop, products, orders, syncedAt, degraded) {
  const normalizedProducts = products.map((product) => ({
    id: product.id,
    title: product.title || "Untitled product",
    status: String(product.status || "unknown").toLowerCase(),
    inventory: Number.isFinite(product.totalInventory) ? product.totalInventory : null,
    updatedAt: product.updatedAt || null
  }));
  const normalizedOrders = orders.map((order) => {
    const money = order.currentTotalPriceSet?.shopMoney || {};
    const value = Number(money.amount);
    return {
      id: order.name || order.id,
      shopifyId: order.id,
      customer: order.customer?.displayName || "Customer",
      createdAt: order.createdAt || null,
      stage: "Imported from Shopify",
      paymentStatus: String(order.displayFinancialStatus || "unknown").toLowerCase(),
      fulfillmentStatus: String(order.displayFulfillmentStatus || "unfulfilled").toLowerCase(),
      value: Number.isFinite(value) ? value : 0,
      currency: money.currencyCode || shop.currencyCode || "USD",
      risk: "No local risk assessment"
    };
  });
  const revenue = normalizedOrders.reduce((sum, order) => sum + order.value, 0);
  const unfulfilled = normalizedOrders.filter((order) => !["fulfilled", "restocked"].includes(order.fulfillmentStatus)).length;
  const signals = normalizedProducts
    .filter((product) => product.inventory === 0)
    .slice(0, 10)
    .map((product, index) => ({
      id: `inventory-${index}-${product.id}`,
      level: "High",
      title: `${product.title} is out of stock`,
      detail: "Shopify reported zero inventory during the latest sync.",
      status: "open"
    }));
  if (unfulfilled) {
    signals.unshift({
      id: "unfulfilled-orders",
      level: "Medium",
      title: `${unfulfilled} recent orders are not fulfilled`,
      detail: "Review these orders in Shopify before promising shipping dates.",
      status: "open"
    });
  }

  return {
    id: `shopify-${String(shop.id).split("/").pop()}`,
    shopifyShopId: shop.id,
    source: "shopify",
    name: shop.name,
    type: "Shopify store",
    category: "Connected commerce",
    aiMode: "Draft + approval",
    health: degraded ? "Partial sync" : "Connected",
    connectionStatus: degraded ? "degraded" : "connected",
    lastSync: syncedAt,
    currency: shop.currencyCode || "USD",
    metrics: {
      revenue,
      profit: null,
      margin: null,
      orderCount: normalizedOrders.length,
      shipping: `${unfulfilled} unfulfilled`,
      conversion: null
    },
    financeTrend: aggregateWeeklyRevenue(normalizedOrders),
    products: normalizedProducts,
    orders: normalizedOrders,
    signals,
    socials: [],
    automations: [],
    commands: [],
    aiPolicy: [
      "Draft customer responses only; never send automatically.",
      "Require human approval before orders, refunds, discounts, payment links, or fulfillment.",
      "Do not infer payment or shipping status beyond connected provider data."
    ],
    checkoutWorkflow: [
      "Direct the customer to the secure Shopify checkout first.",
      "Collect only the minimum missing order details.",
      "Require staff approval before any external action."
    ]
  };
}

function aggregateWeeklyRevenue(orders) {
  const weeks = new Map();
  for (const order of orders) {
    const date = new Date(order.createdAt);
    if (!Number.isFinite(date.getTime())) continue;
    const day = date.getUTCDay();
    const mondayOffset = (day + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    const key = date.toISOString().slice(0, 10);
    weeks.set(key, (weeks.get(key) || 0) + order.value);
  }
  return [...weeks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([week, revenue]) => ({ week, revenue, profit: null }));
}

module.exports = { ORDERS_QUERY, PRODUCTS_QUERY, SHOP_QUERY, ShopifyClient, aggregateWeeklyRevenue, normalizeBusiness };
