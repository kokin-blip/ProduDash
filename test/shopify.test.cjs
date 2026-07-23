const assert = require("node:assert/strict");
const test = require("node:test");
const { ShopifyClient } = require("../electron/connectors/shopify.cjs");

function response(body, options = {}) {
  return {
    ok: options.status ? options.status >= 200 && options.status < 300 : true,
    status: options.status || 200,
    headers: { get: () => options.retryAfter || null },
    async json() {
      return body;
    }
  };
}

function shopBody() {
  return {
    data: {
      shop: {
        id: "gid://shopify/Shop/123",
        name: "Connected Store",
        myshopifyDomain: "connected.myshopify.com",
        currencyCode: "USD"
      }
    }
  };
}

test("Shopify sync authenticates, paginates, and normalizes a business", async () => {
  let productPage = 0;
  const transport = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.query.includes("ProduDashShop")) return response(shopBody());
    if (request.query.includes("ProduDashProducts")) {
      productPage += 1;
      return response({
        data: {
          products: {
            nodes: [{ id: `product-${productPage}`, title: `Product ${productPage}`, status: "ACTIVE", totalInventory: productPage - 1 }],
            pageInfo: { hasNextPage: productPage === 1, endCursor: productPage === 1 ? "cursor-1" : null }
          }
        }
      });
    }
    return response({
      data: {
        orders: {
          nodes: [
            {
              id: "order-1",
              name: "#1001",
              createdAt: "2026-07-20T12:00:00Z",
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              currentTotalPriceSet: { shopMoney: { amount: "42.50", currencyCode: "USD" } },
              customer: { displayName: "Customer" }
            }
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
  };
  const snapshot = await new ShopifyClient({ transport, sleep: async () => {} }).sync({
    storeDomain: "connected.myshopify.com",
    adminAccessToken: "shpat_test_token"
  });
  assert.equal(snapshot.status, "connected");
  assert.equal(snapshot.business.products.length, 2);
  assert.equal(snapshot.business.orders[0].value, 42.5);
  assert.equal(snapshot.business.metrics.profit, null);
  assert.equal(snapshot.business.shopifyShopId, "gid://shopify/Shop/123");
});

test("Shopify rejects invalid domains before making a request", async () => {
  let called = false;
  const client = new ShopifyClient({
    transport: async () => {
      called = true;
      return response({});
    }
  });
  await assert.rejects(
    () => client.sync({ storeDomain: "evil.example.com", adminAccessToken: "shpat_test_token" }),
    (error) => error.code === "INVALID_SHOPIFY_DOMAIN"
  );
  assert.equal(called, false);
});

test("Shopify retries rate limiting without exposing the token", async () => {
  let calls = 0;
  const token = "shpat_never_expose_me";
  const client = new ShopifyClient({
    sleep: async () => {},
    transport: async () => {
      calls += 1;
      if (calls < 3) return response({}, { status: 429 });
      return response(shopBody());
    }
  });
  const result = await client.request("connected.myshopify.com", token, "query ProduDashShop { shop { id name } }");
  assert.equal(result.shop.name, "Connected Store");
  assert.equal(calls, 3);

  const rejected = new ShopifyClient({ transport: async () => response({}, { status: 401 }) });
  await assert.rejects(
    () => rejected.request("connected.myshopify.com", token, "query { shop { id } }"),
    (error) => error.code === "SHOPIFY_AUTH_FAILED" && !error.message.includes(token)
  );
});

test("Shopify reports degraded state when one initial dataset fails", async () => {
  const transport = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.query.includes("ProduDashShop")) return response(shopBody());
    if (request.query.includes("ProduDashProducts")) {
      return response({ data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    return response({ errors: [{ message: "Denied", extensions: { code: "ACCESS_DENIED" } }] });
  };
  const snapshot = await new ShopifyClient({ transport }).sync({
    storeDomain: "connected.myshopify.com",
    adminAccessToken: "shpat_test_token"
  });
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.business.orders.length, 0);
  assert.ok(snapshot.error);
});

test("Shopify aborts requests that exceed the timeout", async () => {
  const transport = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const client = new ShopifyClient({ transport, timeoutMs: 5 });
  await assert.rejects(
    () => client.request("connected.myshopify.com", "shpat_test_token", "query { shop { id } }"),
    (error) => error.code === "SHOPIFY_TIMEOUT"
  );
});
