import https from "https";

const BASE_URL = "https://sap-flexo-sl.skyInone.net:50000/b1s/v2";
const USER = "Licencia5";
const PASS = "rEQbxDYM4$E%";
const COMPANY = "SBO_FLEXO_IMP_PROD";

// Custom HTTPS agent that ignores self-signed certs
const agent = new https.Agent({ rejectUnauthorized: false });

async function sapRequest(
  method: string,
  path: string,
  body?: object,
  cookies?: string
): Promise<{ status: number; body: unknown; cookies?: string[] }> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (cookies) headers["Cookie"] = cookies;

  const fetchOptions: RequestInit & { agent?: https.Agent } = {
    method,
    headers,
    // @ts-ignore - Node 18+ fetch doesn't support agent directly, use global dispatcher trick
  };

  // Use native Node https for full control
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const urlObj = new URL(url);

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port ? parseInt(urlObj.port) : 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        ...headers,
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        const setCookies = res.headers["set-cookie"] ?? [];
        resolve({
          status: res.statusCode ?? 0,
          body: parsed,
          cookies: setCookies,
        });
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function extractSessionCookie(setCookies: string[]): string {
  // SAP B1 uses B1SESSION cookie
  const b1 = setCookies.find((c) => c.includes("B1SESSION"));
  if (!b1) return "";
  // Extract just name=value before first semicolon
  return b1.split(";")[0].trim();
}

async function main() {
  console.log("=== SAP B1 Connectivity Test — FlexoImpresos ===\n");

  // ── STEP 1: Login ──────────────────────────────────────────────────────────
  console.log("1) POST /Login ...");
  let sessionCookie = "";
  try {
    const loginRes = await sapRequest("POST", "/Login", {
      UserName: USER,
      Password: PASS,
      CompanyDB: COMPANY,
    });

    console.log(`   HTTP Status: ${loginRes.status}`);

    if (loginRes.status === 200) {
      console.log("   ✓ Login OK");
      sessionCookie = extractSessionCookie(loginRes.cookies ?? []);
      if (sessionCookie) {
        console.log(`   Session cookie: ${sessionCookie.substring(0, 40)}...`);
      } else {
        console.log("   ⚠ No B1SESSION cookie found in response");
        console.log("   All cookies:", loginRes.cookies);
      }
    } else {
      console.log("   ✗ Login FAILED");
      console.log("   Response body:", JSON.stringify(loginRes.body, null, 2));
      process.exit(1);
    }
  } catch (err) {
    console.error("   ✗ Network error during login:", err);
    process.exit(1);
  }

  // ── STEP 2: BusinessPartners ───────────────────────────────────────────────
  console.log(
    "\n2) GET /BusinessPartners?$top=3&$select=CardCode,CardName,CardType ..."
  );
  try {
    const bpRes = await sapRequest(
      "GET",
      "/BusinessPartners?$top=3&$select=CardCode,CardName,CardType",
      undefined,
      sessionCookie
    );

    console.log(`   HTTP Status: ${bpRes.status}`);

    if (bpRes.status === 200) {
      const bpBody = bpRes.body as { value?: Array<Record<string, unknown>> };
      const partners = bpBody.value ?? [];
      console.log(`   Got ${partners.length} business partner(s):`);
      for (const bp of partners) {
        console.log(
          `     CardCode=${bp.CardCode}  CardName=${bp.CardName}  CardType=${bp.CardType}`
        );
      }

      // Analyze CardCode format
      const codes = partners.map((p) => String(p.CardCode ?? ""));
      const cNitFormat = codes.filter((c) => /^C\d+/.test(c));
      if (codes.length > 0 && cNitFormat.length === codes.length) {
        console.log("   ✓ CardCodes match expected C{NIT} format");
      } else if (codes.length > 0) {
        console.log(
          `   ⚠ CardCode format varies: ${cNitFormat.length}/${codes.length} match C{NIT}`
        );
        console.log(`     Sample codes: ${codes.join(", ")}`);
      }
    } else {
      console.log("   ✗ Request failed");
      console.log("   Response:", JSON.stringify(bpRes.body, null, 2));
    }
  } catch (err) {
    console.error("   ✗ Error fetching BusinessPartners:", err);
  }

  // ── STEP 3: PurchaseOrders ─────────────────────────────────────────────────
  console.log(
    "\n3) GET /PurchaseOrders?$top=2&$select=DocNum,NumAtCard,CardCode,DocDate ..."
  );
  try {
    const poRes = await sapRequest(
      "GET",
      "/PurchaseOrders?$top=2&$select=DocNum,NumAtCard,CardCode,DocDate",
      undefined,
      sessionCookie
    );

    console.log(`   HTTP Status: ${poRes.status}`);

    if (poRes.status === 200) {
      const poBody = poRes.body as { value?: Array<Record<string, unknown>> };
      const orders = poBody.value ?? [];
      if (orders.length === 0) {
        console.log("   ℹ No PurchaseOrders found (empty database or no access)");
      } else {
        console.log(`   Got ${orders.length} PurchaseOrder(s):`);
        for (const po of orders) {
          console.log(
            `     DocNum=${po.DocNum}  NumAtCard=${po.NumAtCard}  CardCode=${po.CardCode}  DocDate=${po.DocDate}`
          );
        }
      }
    } else {
      console.log("   ✗ Request failed");
      console.log("   Response:", JSON.stringify(poRes.body, null, 2));
    }
  } catch (err) {
    console.error("   ✗ Error fetching PurchaseOrders:", err);
  }

  // ── STEP 4: Logout ─────────────────────────────────────────────────────────
  console.log("\n4) POST /Logout ...");
  try {
    const logoutRes = await sapRequest(
      "POST",
      "/Logout",
      undefined,
      sessionCookie
    );
    console.log(`   HTTP Status: ${logoutRes.status}`);
    if (logoutRes.status === 204) {
      console.log("   ✓ Logout OK");
    } else {
      console.log("   ⚠ Unexpected logout status");
      console.log("   Response:", JSON.stringify(logoutRes.body, null, 2));
    }
  } catch (err) {
    console.error("   ✗ Error during logout:", err);
  }

  console.log("\n=== Test complete ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
